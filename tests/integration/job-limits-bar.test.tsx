import { expect, test, vi } from 'vitest';
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => undefined }, projects: vi.fn(), ApiError: class extends Error {} }));
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
import type { ProjectWorkersView } from '@mlswarm/contracts';
import type { Workspace } from '../../apps/web/src/project-api';
import type { ProjectControls } from '../../apps/web/src/ui/ProjectControls';
import { JobLimitsBar, TokenCapEditor } from '../../apps/web/src/ui/JobLimitsBar';
import { MyWorkerControls } from '../../apps/web/src/ui/MyWorkerControls';

// Synthetic rows only: no server, computer or model.
const at = 1_000_000;
const workspace = (patch: Partial<Workspace> = {}) => ({ id: 'p', role: 'owner', execution: 'active', revision: 3,
  project: { started: true, paused: false }, tokenLimit: null, ...patch }) as unknown as Workspace;
const agents = (counted: number, othersUsed?: number) => [{ agentId: 'a', agentName: 'Builder', worker: { available: true, session: { missionId: 'm1', generation: 1, phase: 'working', lastContactAt: at,
  tokens: { counted, unknownTurns: 0 }, ...(othersUsed === undefined ? {} : { tokenLimit: { tokens: 1000, othersUsed } }) } } }] as unknown as ProjectWorkersView['agents'];
const controls = (rows = agents(0)) => ({ workers: { data: { agents: rows }, now: at }, locked: false, busy: false, error: '', setTokens: async () => true, act: async () => {} }) as unknown as ProjectControls;
const render = (patch: Partial<Workspace> = {}, rows?: ProjectWorkersView['agents']) => renderToStaticMarkup(createElement(JobLimitsBar, { workspace: workspace(patch), controls: controls(rows) }));

test('only the owner sees the job bar, once the job has started and while the project is open', () => {
  expect(render()).toContain('This job');
  expect(render({ role: 'member' })).toBe('');
  expect(render({ project: { started: false } as Workspace['project'] })).toBe('');
  expect(render({ execution: 'closed' })).toBe('');
});

// A job has no time limit (owner decision, 10 November 2026): the bar holds only the token cap.
test('the bar has no time part, even for a workspace or session that still carries an old past end time', () => {
  const old = agents(0).map(row => ({ ...row, worker: { ...row.worker, session: { ...row.worker.session, deadlineAt: at - 1 } } })) as unknown as ProjectWorkersView['agents'];
  const html = render({ endsAt: at - 1 } as Partial<Workspace>, old);
  for (const text of ['Time is up', 'Add time', 'min left', 'more time', 'Ends ']) expect(html).not.toContain(text);
  expect(html).toContain('No token cap');
});

test('without a cap the bar says so and offers Set cap', () => {
  const html = render({}, agents(500));
  expect(html).toContain('No token cap');
  expect(html).toContain('Set cap');
  expect(html).not.toContain('k42-job-meter');
});

test('with a cap the bar shows the pool used of the cap; at the cap it says the agents wait', () => {
  const under = render({ tokenLimit: { tokens: 2_000_000 } }, agents(200_000, 1_000_000));
  expect(under).toContain('Used 1,200,000 of 2,000,000 tokens for this job');
  expect(under).toContain('width:60%');
  expect(under).toContain('Change cap');
  expect(under).not.toContain('Cap reached');
  const full = render({ tokenLimit: { tokens: 1000 } }, agents(400, 700));
  expect(full).toContain('Used 1,100 of 1,000 tokens for this job');
  expect(full).toContain('width:100%');
  expect(full).toContain('Cap reached. Agents wait after their current turn until you raise or remove it.');
});

const editor = (initial: string, cap: number | null, used = 0) => renderToStaticMarkup(createElement(TokenCapEditor, { id: 'cap', initial, cap, used, locked: false, busy: false, failed: false, onSave: () => {}, onRemove: () => {}, onCancel: () => {} }));

test('the cap editor is a labelled numeric field with Save and Cancel, and Remove cap only when a cap is set', () => {
  const html = editor('2,000,000', 2_000_000);
  expect(html).toMatch(/<label for="cap">Token cap<\/label>/);
  expect(html).toContain('inputMode="numeric"');
  expect(html).toContain('value="2,000,000"');
  expect(html).toContain('aria-invalid="false"');
  for (const label of ['Save', 'Cancel', 'Remove cap']) expect(html).toContain(`>${label}</button>`);
  expect(editor('', null)).not.toContain('Remove cap');
  // An empty field is named only on Save.
  expect(editor('', null)).not.toContain('Enter the number of tokens.');
});

test('the cap editor names an invalid number plainly and warns before a cap at or below what is used', () => {
  const invalid = editor('0', null);
  expect(invalid).toContain('The cap must be at least 1 token.');
  expect(invalid).toContain('aria-invalid="true"');
  expect(invalid).toContain('aria-describedby="cap-help cap-error"');
  expect(editor('12.5', null)).toContain('Use whole numbers only, like 2,000,000.');
  const below = editor('1,000', null, 1500);
  expect(below).toContain('Your agents have used 1,500 tokens. With this cap they wait after their current turn until you raise or remove it.');
  expect(editor('2,000', null, 1500)).not.toContain('With this cap they wait');
});

test('My agents renders the job bar above its agent rows and keeps each row as it was', () => {
  const rows = agents(200, 300), data = { agents: rows } as unknown as ProjectWorkersView;
  const workers = { data, now: at, error: '', loading: false, participation: null, refresh: () => {}, background: { pending: {}, busy: {}, errors: {}, act: async () => {}, retry: async () => {} } };
  const html = renderToStaticMarkup(createElement(MyWorkerControls, { projectId: 'p', controls: workers, disabled: false, inline: true,
    jobBar: createElement(JobLimitsBar, { workspace: workspace({ tokenLimit: { tokens: 1000 } }), controls: controls(rows) }) }));
  expect(html.indexOf('This job')).toBeGreaterThan(html.indexOf('My agents'));
  expect(html.indexOf('This job')).toBeLessThan(html.indexOf('my-worker-list'));
  // The row keeps its own note, from what the cap told that agent.
  expect(html).toContain('Used 500 of 1,000 tokens for this job.');
});
