import { expect, test, vi } from 'vitest';
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => undefined }, projects: vi.fn(), ApiError: class extends Error {} }));
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import type { BackgroundControlView, ProjectWorkersView } from '@mlswarm/contracts';
import { MyWorkerControls } from '../../apps/web/src/ui/MyWorkerControls';

// Synthetic rows only: no server, computer or model.
const at = 1_000_000, projectId = 'p';
const cap = { tokens: 1000, othersUsed: 0 };
const view = (missionId: string): BackgroundControlView => ({
  target: { projectId, agentId: 'a' } as BackgroundControlView['target'], missionId, generation: 1,
  state: 'waiting', pauseOperationId: null, updatedAt: at, deviceLastSeenAt: at, available: true, pending: null });
const render = (session: Record<string, unknown>, background: BackgroundControlView | null = null) => {
  const data = { agents: [{ agentId: 'a', agentName: 'a', backgroundControl: background,
    worker: { available: true, session: { missionId: 'm1', generation: 1, phase: 'waiting', lastContactAt: at, ...session } } }] } as unknown as ProjectWorkersView;
  const controls = { data, now: at, error: '', loading: false, participation: null, refresh: () => {},
    background: { pending: {}, busy: {}, errors: {}, act: async () => {}, retry: async () => {} } };
  return renderToStaticMarkup(createElement(MyWorkerControls, { projectId, controls, disabled: false, inline: true }));
};

test('a new mission does not show the previous mission\'s token cap', () => {
  const capped = { tokenLimit: cap, tokens: { counted: 1000, unknownTurns: 0 } };
  expect(render(capped, view('m1'))).toContain('Token cap reached');
  expect(render(capped, view('m2'))).not.toContain('Token cap reached');
});

// A job has no time limit (owner decision, 10 November 2026): an old stored end time adds no reason to wait.
test('at the cap the agent names only the cap, even with an old past end time stored', () => {
  const capped = { tokenLimit: cap, tokens: { counted: 1000, unknownTurns: 0 } }, late = { deadlineAt: at - 1 };
  const lateView = { ...view('m1'), ...late } as BackgroundControlView;
  for (const html of [render({ ...capped, ...late }), render({ ...capped, ...late }, lateView)]) {
    expect(html).toContain('Token cap reached. Waiting for a higher cap');
    expect(html).not.toContain('Time is up'); expect(html).not.toContain('more time');
  }
  const under = render({ ...capped, tokens: { counted: 10, unknownTurns: 0 }, ...late }, lateView);
  expect(under).not.toContain('Time is up'); expect(under).not.toContain('more time'); expect(under).not.toContain('Token cap reached');
});
