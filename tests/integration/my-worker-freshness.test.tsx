import { expect, test, vi } from 'vitest';
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => undefined }, projects: vi.fn(), ApiError: class extends Error {} }));
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import type { AgentObservation, BackgroundControlView, ProjectWorkersView } from '@mlswarm/contracts';
import { MyWorkerControls } from '../../apps/web/src/ui/MyWorkerControls';

// Synthetic saved observations only. No process, computer or model is started.
const at = 1_000_000, projectId = 'p';
const view = (extra: Partial<BackgroundControlView> = {}): BackgroundControlView => ({
  target: { projectId, agentId: 'a' } as BackgroundControlView['target'], missionId: 'm1', generation: 1,
  deadlineAt: at + 600_000, state: 'running', pauseOperationId: null, updatedAt: at - 120_000,
  deviceLastSeenAt: at - 120_000, available: false, pending: null, ...extra });
const session = (extra: Partial<NonNullable<AgentObservation['worker']['session']>> = {}) => ({ missionId: 'm1', generation: 1,
  phase: 'working' as const, deadlineAt: at + 600_000, lastContactAt: at - 120_000, ...extra });
const render = (background = view(), s: AgentObservation['worker']['session'] = session()) => {
  const data = { agents: [{ agentId: 'a', agentName: 'Synthetic agent', backgroundControl: background,
    worker: { available: false, session: s } }] } as unknown as ProjectWorkersView;
  const controls = { data, now: at, error: '', loading: false, participation: null, refresh: () => {},
    background: { pending: {}, busy: {}, errors: {}, act: async () => {}, retry: async () => {} } };
  return renderToStaticMarkup(createElement(MyWorkerControls, { projectId, controls, disabled: false, inline: true }));
};

test('My agents never renders an old running snapshot as Working, including after the job end', () => {
  for (const background of [view(), view({ deadlineAt: at - 1 })]) {
    const html = render(background);
    expect(html).toContain('Offline');
    expect(html).toContain('state-offline');
    expect(html).not.toContain('state-working');
    expect(html).not.toContain('Working');
    expect(html).not.toContain('finishing its turn');
    expect(html).not.toContain('Start again');
  }
  expect(render(view(), null)).toContain('Offline');
});

test('My agents follows a fresh matching session but never another mission or a future contact', () => {
  const working = render(view(), session({ lastContactAt: at }));
  expect(working).toContain('Working'); expect(working).toContain('state-working');
  const idle = render(view(), session({ phase: 'waiting', lastContactAt: at }));
  expect(idle).toContain('Idle'); expect(idle).toContain('state-idle'); expect(idle).not.toContain('Working');
  for (const s of [session({ missionId: 'other', lastContactAt: at }), session({ lastContactAt: at + 1 })])
    expect(render(view(), s)).toContain('Offline');
});
