import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { MERGE_APPROVAL_TEXT } from '../../apps/web/src/merge-approval';
import { MergeApprovalControl } from '../../apps/web/src/ui/MergeApprovalControl';
import { MergeAccessControl, MergeAccessFeedback, PersonMergeAccess } from '../../apps/web/src/ui/MergeAccessControl';
import { MergingAccess } from '../../apps/web/src/ui/MergingAccess';
import { personGitHubAccess } from '../../apps/web/src/ui/github-access';
import { canManageMerging } from '../../apps/web/src/merging-access';
import { parseRoute, formatRoute, controlCenterRoute } from '../../apps/web/src/route';
import type { GitHubAccessObservation, ProjectMergingAccess, MergePolicyView } from '@mlswarm/contracts';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const id = 'a'.repeat(64);
const person = { id: 'owner', name: 'Owner', role: 'owner' as const, githubUsername: 'sign-in-user' };
const fact = <T,>(value: T) => ({ status: 'ok' as const, value, lastSuccessAt: 1000 });
const empty = { status: 'not_checked' as const, value: null, lastSuccessAt: null };
const observed = (): GitHubAccessObservation => ({ observer: { id: 'owner', name: 'Owner' }, connectionId: 'computer', checkedAt: 1000, receivedAt: 1000, online: true, scope: 'project',
  account: fact({ login: 'worker-login' }), access: fact({ role: 'admin', defaultBranch: 'trunk' }),
  collaborators: fact({ people: [{ login: 'sign-in-user', role: 'write' }], complete: true }),
  invitations: fact({ people: [], complete: true }), rules: fact({ types: ['pull_request'], requiredApprovals: 1, requiredChecks: ['ci'], complete: true }),
  protection: { ...empty, status: 'forbidden' } });
const accessView = (): MergePolicyView => ({ policy: { revision: 0, mode: 'existing', selected: [] }, enforcement: { state: 'not_enabled', checkedAt: null, code: null } });
const base = (): ProjectMergingAccess => ({ projectId: id, repository: 'https://github.com/example/project', generatedAt: 1000,
  people: [person], peopleNext: null, agents: [{ id: 'scout', name: 'Scout', owner: person, connection: 'current' }], agentsNext: null,
  github: { project: null, self: [], more: false } });
function render(data: ProjectMergingAccess, mergeAccess?: MergePolicyView) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(MergingAccess, { data, mergeAccess, changeMergeAccess: noop, peopleFirst: true, agentsFirst: true,
    previousPeople: noop, nextPeople: noop, previousAgents: noop, nextAgents: noop }));
}
test('Merging links survive reloads, with only the owner eligible', () => {
  expect(parseRoute(formatRoute(controlCenterRoute(id, 'merging')))).toEqual(controlCenterRoute(id, 'merging'));
  for (const role of ['owner']) expect(canManageMerging(role)).toBe(true);
  for (const role of ['member', 'admin', 'moderator', 'guest', undefined]) expect(canManageMerging(role)).toBe(false);
});
test('no observation remains unknown; recorded sign-in is not a verified worker login', () => {
  const data = base(), html = render(data);
  expect(html).toContain('Not checked · Start MyLittleSwarm on your computer');
  expect(html).toContain('Sign-in identity'); expect(html).toContain('Unknown');
  expect(html).toContain('Scout'); expect(html).not.toContain('GitHub administrators control');
  expect(html).not.toContain('No active rulesets');
});
test('GitHub observations ground roles and rules, with partial inspection shown separately', () => {
  const data = base(); data.github.project = observed();
  const html = render(data);
  expect(html).toContain('via @worker-login'); expect(html).toContain('Write');
  expect(html).toContain('trunk'); expect(html).toContain('1 approval'); expect(html).toContain('Check: ci');
  expect(html).toContain('Cannot read'); expect(html).not.toContain('No direct pushes');
  expect(personGitHubAccess(data, { ...person, githubUsername: 'absent' }).label).toBe('Unknown');
});
test('self account wins over sign-in name; cached facts remain explicitly saved', () => {
  const data = base(), source = observed(); source.online = false; source.access.status = 'failed';
  data.github.self = [source];
  const access = personGitHubAccess(data, person);
  expect(access.login).toBe('worker-login'); expect(access.signInOnly).toBe(false); expect(access.label).toBe('Admin');
  const html = render(data); expect(html).toContain('Local service offline'); expect(html).toContain('Saved results');
});
test('partial collaborator lists do not deny missing users; invitations do not become write access', () => {
  const data = base(), source = observed(); source.collaborators = fact({ people: [], complete: false });
  source.invitations = fact({ people: [{ login: 'sign-in-user', invitedBy: 'host' }], complete: true });
  data.github.project = source;
  expect(personGitHubAccess(data, person).label).toBe('Invited');
  expect(personGitHubAccess(data, { ...person, githubUsername: 'unseen' }).label).toBe('Unknown');
  data.agentsNext = 'more';
  const html = render(data); expect(html).toContain('Partial list'); expect(html).toContain('Loaded pages'); expect(html).toContain('Next agents');
});

test('review policies are presented as guidance, separately from the worker merge command', () => {
  for (const mode of ['other_agents', 'agent_review'] as const) {
    const html = renderToStaticMarkup(createElement(MergeApprovalControl, { id: 'policy', value: mode, onChange() {} }));
    expect(html).toContain('Guidance:');
    expect(html).toMatch(/not verif/);
    expect(MERGE_APPROVAL_TEXT[mode].worker).toContain('allowed; review is guidance');
  }
});

test('selected-people controls separate automatic roles, grants and pending enforcement', () => {
  const data = base();
  const value: MergePolicyView = { policy: { revision: 1, mode: 'selected_people', selected: [{ profileId: person.id, epoch: 0 }] }, enforcement: { state: 'pending', checkedAt: null, code: null } };
  data.people = [{ ...person, role: 'member' }]; data.agents = [];
  const html = render(data, value);
  expect(html).toContain('Revoke merge access');
  const control = renderToStaticMarkup(createElement(MergeAccessControl, { value, busy: false, closed: false, save() {}, refresh() {} }));
  expect(control).toContain('Pending GitHub synchronization');
  expect(control).not.toContain('Verified on GitHub');
  expect(control).toContain('Direct pushes to main');
});
test('failed and stale enforcement remain explicit and closed controls stay disabled', () => {
  for (const state of ['failed', 'stale'] as const) {
    const value = accessView();
    value.enforcement = { state, checkedAt: 1234, code: 'github_permissions' };
    const html = renderToStaticMarkup(createElement(MergeAccessControl, { value, busy: false, closed: true, save() {}, refresh() {} }));
    expect(html).not.toContain('Verified on GitHub');
    expect(html).toContain('repository administration');
    expect(html).toContain('disabled');
  }
});

test('shared people controls keep role authority separate from merge permission', () => {
  const value: MergePolicyView = { policy: { revision: 2, mode: 'selected_people', selected: [] }, enforcement: { state: 'pending', checkedAt: null, code: null } };
  const member = { id: 'member', name: 'Member', role: 'member' as const };
  const readOnly = renderToStaticMarkup(createElement(PersonMergeAccess, { person: member, value }));
  expect(readOnly).toContain('PRs only'); expect(readOnly).not.toContain('<button');
  const editor = renderToStaticMarkup(createElement(PersonMergeAccess, { person: member, value, editable: true, onChange() {} }));
  expect(editor).toContain('Grant merge access for Member');
  const access = { value, editable: false, error: '', notice: '', loading: false, busy: false, pending: null, locked: false, save() {}, toggle() {}, refresh() {}, retry() {}, discard() {} };
  expect(renderToStaticMarkup(createElement(MergeAccessFeedback, { access }))).toBe('');
  const unconfirmed = renderToStaticMarkup(createElement(MergeAccessFeedback, { access: { ...access, pending: { client_request_id: 'merge-1', expected_revision: 2, mode: 'selected_people' as const, selected_profile_ids: ['member'] } } }));
  expect(unconfirmed).toContain('Retry original merge change'); expect(unconfirmed).toContain('Discard and reload merge access');
});
