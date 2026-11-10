import { beforeEach, expect, test } from 'vitest';
import { agents, db, inProject, profiles } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { createFanout, runFanout } from '../src/v2/fanout.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { inboxItems, messagesV2 } from '../src/v2/records.js';
import { resetEmulator, seed, loadAgent, TEST_PROJECT, seedApprovedProject } from './helpers.js';
const T = 1_000_000, A = 'a'.repeat(64);
const inTest = (work: () => Promise<void>) => () => inProject(TEST_PROJECT, work);
beforeEach(resetEmulator);
async function fixture() {
  return seed({ profiles: [
    { name: 'Owner', email: 'owner@example.com' },
    { name: 'Member', email: 'member@example.com' },
    { name: 'Other admin', email: 'other@example.com' },
  ], agents: [{ person: 0, name: 'Owner Fox' }, { person: 1, name: 'Member Wind' }, { person: 2, name: 'Other Oak' }] });
}

test('direct delivery to a dangling agent of a removed operator refuses the whole message atomically', inTest(async () => {
  const data = await fixture();
  const [sender, removed, other] = await Promise.all(data.agents.map(a => loadAgent(a.agentId)));
  await profiles.doc(removed.ownerProfileId).update({ removedAt: T });
  expect((await agents().doc(removed.id).get()).data()?.revokedAt).toBeNull();
  await expect(sendMessageV2(sender, { to: [removed.id, other.id], body: 'Private', clientId: 'refused' }, () => T)).rejects.toMatchObject({ code: 'not_found' });
  expect((await messagesV2().get()).empty).toBe(true);
  expect((await inboxItems(other.id).get()).empty).toBe(true);
  expect((await inboxItems(removed.id).get()).empty).toBe(true);
}));

test('scoped delivery requires current project membership; an admin of another project or a removed member is not an audience', async () => {
  const data = await fixture(), [ownerId, memberId, outsiderId] = data.personIds;
  await seedApprovedProject(A, { definition: { title: 'Synthetic', goal: 'Verify', beneficiaries: 'Test', output: 'Evidence', scope: 'Isolated', acceptanceCriteria: 'Tests', sources: null, resources: null, mergeApproval: 'humans' }, ownerProfileId: ownerId, reviewerProfileId: ownerId, submittedRevision: 1, approvedAt: 1, required: false });
  await membershipDoc(A, memberId).set({ projectId: A, role: 'member', revision: 1, updatedAt: 1, profileId: memberId, status: 'active', statusChangedAt: 0, restrictions: { chatMutedUntil: null }, connectionEpoch: 0 });
  await inProject(A, async () => {
    await seed();
    for (const [i, personId] of [ownerId, memberId, outsiderId].entries()) await agents().doc(`scoped-${i}`).set({
      ownerProfileId: personId, connectionEpoch: 0, name: `Synthetic ${i}`, tokenHash: 'unused', createdAt: 1, revokedAt: null, tokenIssuedAt: 1});
    const sender = await loadAgent('scoped-0');
    await expect(sendMessageV2(sender, { to: ['scoped-2'], body: 'Private', clientId: 'other-admin' }, () => T)).rejects.toMatchObject({ code: 'not_found' });
    await membershipDoc(A, memberId).update({ status: 'removed', statusChangedAt: T });
    await expect(sendMessageV2(sender, { to: ['scoped-1'], body: 'Private', clientId: 'removed' }, () => T)).rejects.toMatchObject({ code: 'not_found' });
    const sourceId = await db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Private' }, T));
    expect(await runFanout(sourceId, () => T)).toBe('done');
    expect((await inboxItems('scoped-0').get()).size).toBe(1);
    expect((await inboxItems('scoped-1').get()).empty).toBe(true);
    expect((await inboxItems('scoped-2').get()).empty).toBe(true);
    // Restoring eligibility affects a later source, never creates a replay of a completed source.
    await membershipDoc(A, memberId).update({ status: 'active', statusChangedAt: 0 });
    const next = await db.runTransaction(async tx => createFanout(tx, 'announcement', {}, T + 1));
    expect(await runFanout(next, () => T + 1)).toBe('done');
    expect((await inboxItems('scoped-1').get()).size).toBe(1);
  });
});
