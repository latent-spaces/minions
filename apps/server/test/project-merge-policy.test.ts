import { getProject } from '../src/store/project.js';
import { beforeEach, expect, test, vi } from 'vitest';
import { collection, db, githubAccounts, inProject, profiles } from '../src/firestore.js';
import { membershipDoc, membershipFenceDoc } from '../src/projects/access.js';
import { editMergePolicy, readMergePolicy, mergePolicySnapshot, mergePolicyView, reportMergePolicy } from '../src/projects/merge-policy.js';
import { repositoryAccess } from '../src/projects/github-username.js';
import { projects } from '../src/projects/records.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
const at = 1_000_000, connectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeEach(resetEmulator);
const snapshot = () => inProject(TEST_PROJECT, () => db.runTransaction(tx => mergePolicySnapshot(tx, TEST_PROJECT)));
const view = (now = at) => inProject(TEST_PROJECT, () => db.runTransaction(tx => mergePolicyView(tx, TEST_PROJECT, now)));
const edit = (selected: string[] = [], revision = 0, mode = 'selected_people', client_request_id = `edit-${revision}`) => ({ mode, selected_profile_ids: selected, expected_revision: revision, client_request_id });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'First', email: 'first@example.test' }, { name: 'Member', email: 'member@example.test' }, { name: 'Third', email: 'third@example.test' }] });
  await profiles.doc('seed-owner').set({ name: 'Owner', email: 'owner@example.test', githubUsername: 'owner', removedAt: null });
  for (const [index, id] of ['seed-owner', ...f.personIds].entries()) {
    const person = (await profiles.doc(id).get()).data()!;
    const login = `person-${index}`;
    await profiles.doc(id).update({ githubUsername: login });
    await githubAccounts.doc(String(index + 1)).set({ firebaseUid: `firebase-${id}`, login, emails: [person.email], avatarUrl: null, checkedAt: at });
  }
  await collection('computerConnections').doc(connectionId).set({ profileId: 'seed-owner', approvedAt: 1, revokedAt: null, connectionExpiresAt: at + 3600000 });
  return f;
}
test('existing projects make no enforcement request until this mode is explicitly saved', async () => {
  await fixture();
  expect((await view()).enforcement.state).toBe('not_enabled');
  expect((await repositoryAccess('seed-owner')).mergePolicies).toEqual([]);
});
test('the owner selects people and is automatic; verified account IDs enter the synchronization target', async () => {
  const f = await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit([f.personIds[1]]));
  const saved = await snapshot();
  expect(saved.policy.selected).toEqual([{ profileId: f.personIds[1], epoch: 0 }]);
  expect(saved.target).toMatchObject({ mode: 'selected_people', ownerGithubId: 1, allowedGithubIds: [1, 3] });
  expect((await view()).enforcement.state).toBe('pending');
  expect((await repositoryAccess('seed-owner')).mergePolicies).toEqual([saved.target]);
  expect((await repositoryAccess(f.personIds[0])).mergePolicies).toEqual([]);
  expect((await readMergePolicy(f.personIds[0], TEST_PROJECT, () => at)).policy.revision).toBe(1);
});
test('members and outsiders cannot change merge access; selected people gain no authority to change it', async () => {
  const f = await fixture();
  for (const actor of [...f.personIds, 'outsider']) await expect(editMergePolicy(actor, TEST_PROJECT, edit())).rejects.toThrow();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit([f.personIds[1]]));
  await expect(editMergePolicy(f.personIds[1], TEST_PROJECT, edit([], 1))).rejects.toThrow();
});
test('retries are idempotent and concurrent/stale or changed-input edits refuse', async () => {
  const f = await fixture(), body = edit([f.personIds[1]]);
  expect(await editMergePolicy('seed-owner', TEST_PROJECT, body)).toEqual({ revision: 1, replayed: false });
  expect(await editMergePolicy('seed-owner', TEST_PROJECT, body)).toEqual({ revision: 1, replayed: true });
  const history = await collection(`projects/${TEST_PROJECT}/mergePolicyHistory`).get();
  expect(history.size).toBe(1);
  expect(history.docs[0].data()).toMatchObject({ editorProfileId: 'seed-owner', revision: 1, mode: 'selected_people' });
  await expect(editMergePolicy('seed-owner', TEST_PROJECT, edit([], 0, 'selected_people', 'another-request'))).rejects.toThrow(/changed/);
  await expect(editMergePolicy('seed-owner', TEST_PROJECT, { ...body, selected_profile_ids: [] })).rejects.toThrow(/request ID/);
  await projects.doc(TEST_PROJECT).update({ 'execution.completedAt': at, 'execution.paused': true });
  await expect(editMergePolicy('seed-owner', TEST_PROJECT, edit([], 1))).rejects.toThrow(/closed/);
});
test('removed members lose grants and rejoining does not restore them', async () => {
  const f = await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit([f.personIds[1]]));
  const first = (await snapshot()).target!;
  await membershipDoc(TEST_PROJECT, f.personIds[1]).update({ status: 'removed' });
  expect((await snapshot()).target?.allowedGithubIds).toEqual([1]);
  await membershipDoc(TEST_PROJECT, f.personIds[1]).update({ status: 'active', connectionEpoch: 1 });
  await membershipFenceDoc(TEST_PROJECT, f.personIds[1]).set({ projectId: TEST_PROJECT, profileId: f.personIds[1], epoch: 1 });
  expect((await snapshot()).target?.allowedGithubIds).toEqual([1]);
  expect((await view()).policy.selected).toEqual([]);
  expect((await snapshot()).target?.policyKey).not.toBe(first.policyKey);
});
test('unverified/reused usernames never resolve to arbitrary GitHub account IDs', async () => {
  const f = await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit([f.personIds[1]]));
  await githubAccounts.doc('3').update({ emails: ['someone-else@example.test'] });
  const result = await snapshot();
  expect(result.target?.allowedGithubIds).toEqual([1]);
  expect(result.problem).toBe('identity_required');
  expect((await view()).enforcement.state).toBe('pending');
});
test('only current matching owner-computer receipts verify enforcement, with explicit stale/failed states', async () => {
  const f = await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit());
  const target = (await snapshot()).target!;
  const report = { projectId: TEST_PROJECT, policyKey: target.policyKey, code: 'verified' };
  await expect(reportMergePolicy(f.personIds[0], connectionId, report, () => at)).rejects.toThrow();
  await reportMergePolicy('seed-owner', connectionId, report, () => at);
  expect((await view()).enforcement.state).toBe('verified');
  expect((await view(at + 120001)).enforcement.state).toBe('stale');
  await reportMergePolicy('seed-owner', connectionId, { ...report, code: 'github_permissions' }, () => at + 1);
  expect((await view(at + 1)).enforcement.state).toBe('failed');
  await collection('computerConnections').doc(connectionId).update({ revokedAt: at });
  expect((await view()).enforcement.state).toBe('pending');
  await expect(reportMergePolicy('seed-owner', connectionId, report, () => at)).rejects.toThrow();
});
test('repository changes and mode edits reject stale reports; disabling requires confirmed removal', async () => {
  await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit());
  await editMergePolicy('seed-owner', TEST_PROJECT, edit([], 1, 'existing'));
  const disabled = (await snapshot()).target!;
  expect((await view()).enforcement.state).toBe('pending');
  await expect(reportMergePolicy('seed-owner', connectionId, { projectId: TEST_PROJECT, policyKey: disabled.policyKey, code: 'verified' }, () => at)).rejects.toThrow();
  await reportMergePolicy('seed-owner', connectionId, { projectId: TEST_PROJECT, policyKey: disabled.policyKey, code: 'removed' }, () => at);
  expect((await view()).enforcement.state).toBe('not_enabled');
  await projects.doc(TEST_PROJECT).update({ 'setup.repoUrl': 'https://github.com/example/other' });
  expect((await view()).enforcement.state).toBe('pending');
});
test('invalid/nonmember selections never create a grant', async () => {
  await fixture();
  for (const body of [edit(['outsider']), edit(['seed-owner', 'seed-owner']), edit([], 0, 'wrong'), { ...edit(), token: 'extra' }]) await expect(editMergePolicy('seed-owner', TEST_PROJECT, body)).rejects.toThrow();
});

test('worker project instructions distinguish selected people from PR-only people without claiming synchronization', async () => {
  const f = await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit([f.personIds[1]]));
  const selected = await inProject(TEST_PROJECT, () => getProject(f.personIds[1]));
  const prOnly = await inProject(TEST_PROJECT, () => getProject(f.personIds[2]));
  expect(selected.rules).toContain('Your person has merge access');
  expect(prOnly.rules).toContain('Your person has PR-only access');
  expect(selected.rules).toContain('synchronization may still be pending');
});

test('ownership changes after discovery cannot issue an operational repository target', async () => {
  const f = await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit());
  const originalRun = db.runTransaction.bind(db);
  const transaction = vi.spyOn(db, 'runTransaction').mockImplementationOnce(async (work, options) => {
    await projects.doc(TEST_PROJECT).update({ ownerProfileId: f.personIds[1] });
    return originalRun(work, options);
  });
  try {
    const result = await repositoryAccess('seed-owner');
    expect(transaction).toHaveBeenCalledOnce();
    expect(result.mergePolicies).toEqual([]);
    expect(result.owned).toEqual([]);
  } finally { transaction.mockRestore(); }
});

test('Home policy readers are current members and never receive operational GitHub targets', async () => {
  const f = await fixture();
  await editMergePolicy('seed-owner', TEST_PROJECT, edit([f.personIds[1]]));
  for (const actor of ['seed-owner', ...f.personIds]) {
    const result = await readMergePolicy(actor, TEST_PROJECT, () => at);
    expect(result.policy.mode).toBe('selected_people');
    expect(result.policy.selected).toEqual([{ profileId: f.personIds[1], epoch: 0 }]);
    expect(JSON.stringify(result)).not.toMatch(/allowedGithubIds|ownerGithubId|policyKey|firebaseUid|connectionId|token/);
  }
  await membershipDoc(TEST_PROJECT, f.personIds[1]).update({ status: 'removed' });
  for (const actor of [f.personIds[1], 'outsider']) await expect(readMergePolicy(actor, TEST_PROJECT, () => at)).rejects.toMatchObject({ code: 'unauthorized' });
});
