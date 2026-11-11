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
  target: { projectId, agentId: 'a' } as BackgroundControlView['target'], missionId, generation: 1, deadlineAt: at + 600_000,
  state: 'waiting', pauseOperationId: null, updatedAt: at, deviceLastSeenAt: at, available: true, pending: null });
const render = (session: Record<string, unknown>, background: BackgroundControlView | null = null) => {
  const data = { agents: [{ agentId: 'a', agentName: 'a', backgroundControl: background,
    worker: { available: true, session: { missionId: 'm1', generation: 1, phase: 'waiting', deadlineAt: at + 600_000, lastContactAt: at, ...session } } }] } as unknown as ProjectWorkersView;
  const controls = { data, now: at, error: '', loading: false, participation: null, refresh: () => {},
    background: { pending: {}, busy: {}, errors: {}, act: async () => {}, retry: async () => {} } };
  return renderToStaticMarkup(createElement(MyWorkerControls, { projectId, controls, disabled: false, inline: true }));
};

test('a new mission does not show the previous mission\'s token cap', () => {
  const capped = { tokenLimit: cap, tokens: { counted: 1000, unknownTurns: 0 } };
  expect(render(capped, view('m1'))).toContain('Token cap reached');
  expect(render(capped, view('m2'))).not.toContain('Token cap reached');
});

test('an agent past its end time and at the cap names both reasons', () => {
  const capped = { tokenLimit: cap, tokens: { counted: 1000, unknownTurns: 0 } }, late = { deadlineAt: at - 1 };
  const lateView = { ...view('m1'), ...late };
  for (const html of [render({ ...capped, ...late }), render({ ...capped, ...late }, lateView)]) {
    expect(html).toContain('Time is up and token cap reached. Waiting for more time and a higher cap');
    expect(html).not.toContain('Time is up. Waiting for more time');
  }
  // Only one reason: only that one.
  expect(render({ ...capped, tokens: { counted: 10, unknownTurns: 0 }, ...late }, lateView)).toContain('Time is up. Waiting for more time');
  expect(render(capped, view('m1'))).toContain('Token cap reached. Waiting for a higher cap');
});
