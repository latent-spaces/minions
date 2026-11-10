import { expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectControlsCard, ProjectControlFeedback, type ProjectControls } from '../../apps/web/src/ui/ProjectControls';
import { ProjectStatusPanel } from '../../apps/web/src/ui/ProjectStatusPanel';
import type { Workspace } from '../../apps/web/src/project-api';
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => undefined }, projects: vi.fn(), ApiError: class extends Error {} }));
const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const workspace = (patch: Partial<Workspace> = {}) => ({ id: 'synthetic-project', role: 'owner', execution: 'active', project: { started: true, paused: false }, revision: 3, ...patch }) as Workspace;
const controls = { locked: false, pending: null, busy: false, error: '', act() {}, retry() {}, discard() {}, workers: { data: null, now: 1000, background: { pending: {}, busy: {} } } } as unknown as ProjectControls;
const render = (view: Workspace, state = controls, disabled = false) => renderToStaticMarkup(createElement(ProjectControlsCard, { workspace: view, controls: state, disabled }));
for (const role of ['member', 'admin', 'moderator', 'guest'] as const) test(`${role} cannot see project management controls in any lifecycle state`, () => {
  for (const project of [null, { started: false }, { started: true, paused: false }, { started: true, paused: true }]) {
    for (const execution of ['closed', 'active'] as const) expect(render(workspace({ role, execution, project: project as Workspace['project'] }))).toBe('');
  }
});
test('owner sees only the applicable lifecycle action', () => {
  for (const [execution, project, label] of [
    ['ready', { started: false }, 'Start project'],
    ['active', { started: true, paused: false }, 'Pause project'],
    ['paused', { started: true, paused: true }, 'Resume project'],
    ['closed', { started: true, paused: true }, 'Reopen project'],
  ] as const) {
    const html = render(workspace({ execution, project: project as Workspace['project'] }));
    expect(html).toContain('Project status'); expect(html).toContain(label);
    for (const other of ['Start project', 'Pause project', 'Resume project', 'Reopen project'].filter(v => v !== label)) expect(html).not.toContain(other);
    expect(html.includes('Close project')).toBe(execution !== 'closed');
  }
});
// A blocked start turns the Start button off.
const startLocked = /<button[^>]*disabled=""[^>]*>.*?Start project/s;
test('setup and below-minimum blockers remain visible; the owner can override minimum', () => {
  const setup = { required: true, finalizedAt: 10, minContributors: 3, startDeadline: null };
  for (const project of [null, { started: false }]) {
    const html = render(workspace({ project: project as Workspace['project'], setup: { ...setup, finalizedAt: null } }));
    expect(html).toMatch(startLocked); expect(html).toContain(project ? 'Publish the project' : 'Add a repository');
  }
  const view = workspace({ project: { started: false } as Workspace['project'], setup, participantCount: 1 });
  expect(render(view)).toContain('start with fewer'); expect(render(view)).not.toMatch(startLocked);
});
test('busy, uncertain-request and external edit locks disable all lifecycle buttons', () => {
  for (const [state, disabled] of [[{ ...controls, locked: true }, false], [controls, true]] as const) {
    expect((render(workspace(), state, disabled).match(/disabled=""/g) ?? []).length).toBe(2);
  }
  const html = renderToStaticMarkup(createElement(ProjectControlFeedback, { controls: { ...controls, error: 'Lost response', pending: { action: 'pause', expected_revision: 3, client_request_id: 'same-request' } } }));
  expect(html).toContain('role="alert"'); expect(html).toContain('Retry pause project'); expect(html).toContain('Discard request and reload');
});
test('participant waiting notice remains without duplicating a manager Start action', () => {
  const view = workspace({ project: { started: false } as Workspace['project'] });
  expect(renderToStaticMarkup(createElement(ProjectStatusPanel, { workspace: view, controls }))).toContain('Start project');
  expect(renderToStaticMarkup(createElement(ProjectStatusPanel, { workspace: { ...view, role: 'member' }, controls }))).toContain('Waiting for the owner');
});
// A job has no time limit (owner decision, 10 November 2026): Start is one button with no length to choose.
test('starting is one enabled Start button with no job length to choose, in Settings and on Home', () => {
  const view = workspace({ execution: 'ready', project: { started: false } as Workspace['project'] });
  for (const html of [render(view), renderToStaticMarkup(createElement(ProjectStatusPanel, { workspace: view, controls }))]) {
    expect(html).not.toContain('How long should agents work?'); expect(html).not.toContain('<select');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>.*?Start project/s);
  }
});
test('an old stored end time shows no end time, time left, time up or Add time to anyone', () => {
  const panel = (patch: Partial<Workspace>) => renderToStaticMarkup(createElement(ProjectStatusPanel, { workspace: workspace(patch), controls }));
  const old = { endsAt: Date.now() - 1000 } as Partial<Workspace>, later = { endsAt: Date.now() + 45 * 60_000 } as Partial<Workspace>;
  for (const role of ['owner', 'member'] as const) for (const execution of ['active', 'paused', 'closed'] as const) for (const time of [old, later]) {
    const html = panel({ role, execution, ...time });
    for (const text of ['Time is up', 'Add time', 'min left', 'ends ', 'more time', 'adds time']) expect(html).not.toContain(text);
  }
  expect(panel({ execution: 'paused', project: { started: true, paused: true } as Workspace['project'], ...old })).toContain('Resume all agents');
});
