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
// Start needs a job length first, so the button itself is off until one is chosen; a blocked start also locks the choice.
const lengthLocked = /<select[^>]*disabled=""/;
test('setup and below-minimum blockers remain visible; the owner can override minimum', () => {
  const setup = { required: true, finalizedAt: 10, minContributors: 3, startDeadline: null };
  for (const project of [null, { started: false }]) {
    const html = render(workspace({ project: project as Workspace['project'], setup: { ...setup, finalizedAt: null } }));
    expect(html).toMatch(lengthLocked); expect(html).toContain(project ? 'Publish the project' : 'Add a repository');
  }
  const view = workspace({ project: { started: false } as Workspace['project'], setup, participantCount: 1 });
  expect(render(view)).toContain('start with fewer'); expect(render(view)).not.toMatch(lengthLocked);
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
// Owner decision, 9 November 2026: one job end time for every agent, and no length is chosen for the person.
test('starting offers the job length with one hour preselected and Start enabled, in Settings and on Home', () => {
  const view = workspace({ execution: 'ready', project: { started: false } as Workspace['project'] });
  for (const html of [render(view), renderToStaticMarkup(createElement(ProjectStatusPanel, { workspace: view, controls }))]) {
    expect(html).toContain('How long should agents work?');
    expect(html).toMatch(/<option value="60" selected="">1 hour<\/option>/);
    for (const preset of ['30 minutes', '1 hour', '4 hours', 'Other…']) expect(html).toContain(preset);
    expect(html).not.toContain('Until the project ends');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>.*?Start project/s);
  }
});
test('the owner sees the job end time and Add time only in the job bar; others see the end time in the status panel', () => {
  const panel = (patch: Partial<Workspace>) => renderToStaticMarkup(createElement(ProjectStatusPanel, { workspace: workspace(patch), controls }));
  for (const endsAt of [Date.now() + 45 * 60_000 - 5000, null, Date.now() - 1000]) {
    const owner = panel({ endsAt });
    expect(owner).not.toContain('Add time'); expect(owner).not.toContain('min left'); expect(owner).not.toContain('Time is up');
  }
  const paused = panel({ execution: 'paused', project: { started: true, paused: true } as Workspace['project'], endsAt: Date.now() + 45 * 60_000 - 5000 });
  expect(paused).not.toContain('Add time'); expect(paused).toContain('Resume all agents');
  const member = panel({ role: 'member', endsAt: Date.now() + 45 * 60_000 - 5000 });
  expect(member).toContain('45 min left'); expect(member).toContain('ends '); expect(member).not.toContain('Add time');
  const late = panel({ role: 'member', endsAt: Date.now() - 1000 });
  expect(late).toContain('Time is up'); expect(late).toContain('wait until the owner adds time'); expect(late).not.toContain('Add time');
  const closed = panel({ role: 'member', execution: 'closed', endsAt: Date.now() + 60_000 });
  expect(closed).not.toContain('min left'); expect(closed).not.toContain('Time is up');
});
