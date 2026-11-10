import { expect, test, vi } from 'vitest';
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => undefined }, projects: vi.fn(), ApiError: class extends Error {} }));
// A static render cannot click: with open set, every confirmation that starts closed renders open.
const confirm = vi.hoisted(() => ({ open: false }));
vi.mock('react', async original => { const react = await original<typeof import('react')>();
  return { ...react, useState: (initial: unknown) => react.useState(confirm.open && initial === false ? true : initial) }; });
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import type { BackgroundControlView, ProjectWorkersView } from '@mlswarm/contracts';
import { MyWorkerControls } from '../../apps/web/src/ui/MyWorkerControls';

// Synthetic rows only: no server, computer or model.
const at = 1_000_000, projectId = 'p';
const view = (agentId: string, pending: BackgroundControlView['pending'] = null): BackgroundControlView => ({
  target: { projectId, agentId } as BackgroundControlView['target'], missionId: `m-${agentId}`, generation: 1,
  state: 'running', pauseOperationId: null, updatedAt: at, deviceLastSeenAt: at, available: true, pending });
const pending = (kind: 'pause' | 'resume' | 'stop') => ({ id: `op-${kind}`, kind, state: 'accepted' as const, approvedAt: at });
const render = (views: BackgroundControlView[]) => {
  const data = { agents: views.map(v => ({ agentId: v.target.agentId, agentName: v.target.agentId, backgroundControl: v,
    worker: { available: true, session: { missionId: v.missionId, generation: 1, phase: 'working', lastContactAt: at } } })) } as unknown as ProjectWorkersView;
  const controls = { data, now: at, error: '', loading: false, participation: null, refresh: () => {},
    background: { pending: {}, busy: {}, errors: {}, act: async () => {}, retry: async () => {} } };
  return renderToStaticMarkup(createElement(MyWorkerControls, { projectId, controls, disabled: false, inline: true }));
};

test('Kill all counts agents that are pausing; Pause all leaves them out', () => {
  const html = render([view('a', pending('pause')), view('b')]);
  expect(html).toContain('Kill all');
  expect(html).not.toContain('Pause all');
  expect(render([view('a', pending('resume')), view('b')])).toContain('Kill all');
});

test('an agent whose Kill is already pending is not counted again', () => {
  expect(render([view('a', pending('stop')), view('b')])).not.toContain('Kill all');
  expect(render([view('a'), view('b')])).toContain('Pause all');
});

test('the Kill all confirmation says it cannot be undone', () => {
  confirm.open = true;
  try { expect(render([view('a'), view('b')])).toContain('Kill all 2 agents? It cannot be undone.'); }
  finally { confirm.open = false; }
});
