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

// Synthetic rows only: no server, computer or model.
const at = 1_000_000;
const workspace = (patch: Partial<Workspace> = {}) => ({ id: 'p', role: 'owner', execution: 'active', revision: 3, endsAt: at + 113 * 60_000,
  project: { started: true, paused: false }, tokenLimit: null, ...patch }) as unknown as Workspace;
const agents = (counted: number, othersUsed?: number) => [{ agentId: 'a', agentName: 'Builder', worker: { available: true, session: { missionId: 'm1', generation: 1, phase: 'working', deadlineAt: at + 600_000, lastContactAt: at,
  tokens: { counted, unknownTurns: 0 }, ...(othersUsed === undefined ? {} : { tokenLimit: { tokens: 1000, othersUsed } }) } } }] as unknown as ProjectWorkersView['agents'];
const controls = (rows = agents(0)) => ({ workers: { data: { agents: rows }, now: at }, locked: false, busy: false, error: '', setTokens: async () => true, act: async () => {} }) as unknown as ProjectControls;
const render = (patch: Partial<Workspace> = {}, rows?: ProjectWorkersView['agents']) => renderToStaticMarkup(createElement(JobLimitsBar, { workspace: workspace(patch), controls: controls(rows) }));

test('only the owner sees the job bar, once the job has started and while the project is open', () => {
  expect(render()).toContain('This job');
  expect(render({ role: 'member' })).toBe('');
  expect(render({ project: { started: false } as Workspace['project'] })).toBe('');
  expect(render({ execution: 'closed' })).toBe('');
});

test('the time part says how long is left and offers +30 min; once the end passes it says time is up', () => {
  const html = render();
  expect(html).toContain('1 h 53 min left');
  expect(html).toContain('aria-label="Add 30 minutes"');
  const late = render({ endsAt: at - 1 });
  expect(late).toContain('Time is up');
  expect(late).toContain('Agents finish their turn, then wait for more time.');
  expect(late).toContain('aria-label="Add 30 minutes"');
});

test('without a cap the bar says so and offers Set cap', () => {
  const html = render({}, agents(500));
  expect(html).toContain('No cap');
  expect(html).toContain('Set cap');
  expect(html).not.toContain('k42-job-meter');
});

test('with a cap the bar shows the pool used of the cap; at the cap it says the agents wait', () => {
  const under = render({ tokenLimit: { tokens: 2_000_000 } }, agents(200_000, 1_000_000));
  expect(under).toContain('1,200,000 of 2,000,000');
  expect(under).toContain('width:60%');
  expect(under).toContain('Change cap');
  expect(under).not.toContain('is-alert');
  const full = render({ tokenLimit: { tokens: 1000 } }, agents(400, 700));
  expect(full).toContain('1,100 of 1,000');
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
