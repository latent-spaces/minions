import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { cleanupFeedback } from '../feedback/store.js';
import { cleanupProfilePhotos } from '../community/profile-photos.js';
import { FieldPath } from '../firestore.js';
import { assertCommunityActor } from '../community/identity.js';
import { Refusal } from '../errors.js';
import { membershipDoc, membershipEpoch, membershipFenceDoc, membershipsOf } from '../projects/access.js';
import { collection, db, profiles, type Agent } from '../firestore.js';
import { prepareInvitationEmailCleanup, type InvitationEmailCleanupCursor } from './invitation-email-cleanup.js';
import { writeAgentGroup } from '../v2/agent-group.js';

type AccountCleanup = {
  operatorId: string; removedAt: number; createdAt: number; updatedAt: number;
  cursor: string; status: 'pending' | 'done';
  revokedAgents: number; feedbackDone?: boolean;
  membershipCursor?: string; membershipsDone?: boolean;
  invitationEmailCursor?: InvitationEmailCleanupCursor; invitationEmailsDone?: boolean;
};
export const accountCleanup = collection<AccountCleanup>('accountCleanup');
// Each agent costs up to five writes including the atomic progress/change fence.
const PAGE = 50;
const MEMBERS_PAGE = 25;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const AGENT_PATH = /^projects\/[a-f0-9]{64}\/agents\/[A-Za-z0-9_-]{1,200}$/;
// Beta.19 completed jobs predate membership cleanup. OPE-71: retain their counters/cursors
// and expose them as pending until their membership backfill has completed.
const summary = (job: AccountCleanup) => ({ status: job.status === 'done' && (job.feedbackDone === false || job.membershipsDone !== true || job.invitationEmailsDone !== true) ? 'pending' as const : job.status, revokedAgents: job.revokedAgents });
function validate(job: AccountCleanup, operatorId: string, removedAt: number | null | undefined) {
  if (job.operatorId !== operatorId || removedAt === null || removedAt === undefined || job.removedAt !== removedAt
    || !Number.isFinite(job.removedAt) || !['pending', 'done'].includes(job.status)
    || !Number.isSafeInteger(job.revokedAgents) || job.revokedAgents < 0
    || job.feedbackDone !== undefined && typeof job.feedbackDone !== 'boolean'
    || job.membershipsDone !== undefined && typeof job.membershipsDone !== 'boolean'
    || job.invitationEmailsDone !== undefined && typeof job.invitationEmailsDone !== 'boolean'
    || job.invitationEmailCursor !== undefined && (typeof job.invitationEmailCursor !== 'object' || job.invitationEmailCursor === null
      || Object.entries(job.invitationEmailCursor).some(([key, value]) => !['owner', 'recipient', 'ownerTokens', 'recipientTokens'].includes(key)
        || typeof value !== 'string' || value !== '' && !/^[a-f0-9]{64}$/.test(value)))
    || job.membershipCursor !== undefined && job.membershipCursor !== '' && !/^[a-f0-9]{64}$/.test(job.membershipCursor)
    || typeof job.cursor !== 'string' || (job.cursor !== '' && !AGENT_PATH.test(job.cursor))) {
    throw new Refusal('bad_input', 'The account cleanup record needs explicit maintenance.');
  }
}
async function ownerAuthority(tx: import('../firestore.js').Transaction, operatorId: string) {
  const actor = await assertCommunityActor(tx, { kind: 'person', operatorId });
  if (!actor.isOwner) throw new Refusal('forbidden', 'Only the active community owner can inspect or continue account cleanup.');
}
export async function readAccountCleanup(ownerId: string, operatorId: string) {
  if (!ID.test(operatorId)) throw new Refusal('bad_input', 'Choose a registered account ID.');
  return db.runTransaction(async tx => {
    await ownerAuthority(tx, ownerId);
    const [person, found] = await Promise.all([tx.get(profiles.doc(operatorId)), tx.get(accountCleanup.doc(operatorId))]);
    const job = found.data();
    if (!job) return { status: 'none' as const };
    validate(job, operatorId, person.data()?.removedAt);
    return summary(job);
  }, { readOnly: true });
}

// Omitting ownerId is only for trusted backend/admin code already using cloud credentials.
// Public callers always provide the authenticated owner and recheck authority inside this page.
export async function continueAccountCleanup(operatorId: string, now: () => number, ownerId?: string) {
  if (!ID.test(operatorId)) throw new Refusal('bad_input', 'Choose a registered account ID.');
  const result = await db.runTransaction(async tx => {
    if (ownerId !== undefined) await ownerAuthority(tx, ownerId);
    const ref = accountCleanup.doc(operatorId);
    const [person, found] = await Promise.all([tx.get(profiles.doc(operatorId)), tx.get(ref)]);
    const job = found.data();
    if (!job) return { status: 'none' as const };
    validate(job, operatorId, person.data()?.removedAt);
    if (job.status === 'done' && job.membershipsDone === true && job.invitationEmailsDone === true) return summary(job);
    let query = db.collectionGroup('agents').where('ownerProfileId', '==', operatorId).where('revokedAt', '==', null).orderBy(FieldPath.documentId()).limit(PAGE);
    if (job.cursor) query = query.startAfter(db.doc(job.cursor));
    const page = await tx.get(query);
    // Reject unfamiliar namespaces before any writes instead of interpreting arbitrary history as live connections.
    if (page.docs.some(d => !AGENT_PATH.test(d.ref.path))) throw new Refusal('bad_input', 'An account connection namespace needs explicit maintenance.');
    const records = await Promise.all(page.docs.map(async agent => {
      const prefix = agent.ref.path.slice(0, -(`agents/${agent.id}`).length);
      return { agent, run: await tx.get(db.doc(`${prefix}runs/${agent.id}`)), contact: await tx.get(db.doc(`${prefix}presence/${agent.id}`)) };
    }));
    // Membership retirement shares the page: at most 250 agent and 100 membership writes. Each membership
    // writes both copies, its connection fence and the shared admission/capacity fence.
    let members = membershipsOf(operatorId).where('status', '==', 'active').orderBy(FieldPath.documentId()).limit(MEMBERS_PAGE);
    if (job.membershipCursor) members = members.startAfter(job.membershipCursor);
    const memberPage = await tx.get(members);
    const memberships = await Promise.all(memberPage.docs.map(async mirror => {
      const id = mirror.id;
      if (!/^[a-f0-9]{64}$/.test(id) || mirror.data().profileId !== operatorId || mirror.data().projectId !== id)
        throw new Refusal('bad_input', 'An account membership namespace needs explicit maintenance.');
      const capacity = collection<{ revision: number }>(`projects/${id}/capacity`).doc('membership');
      const [member, fence, counter] = await Promise.all([tx.get(membershipDoc(id, operatorId)), tx.get(membershipFenceDoc(id, operatorId)), tx.get(capacity)]);
      if (!member.exists || member.data()!.profileId !== operatorId || member.data()!.projectId !== id)
        throw new Refusal('bad_input', 'An account membership needs explicit maintenance.');
      const epoch = membershipEpoch(id, operatorId, member.data(), fence.data());
      if (epoch < 0 || epoch === Number.MAX_SAFE_INTEGER) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the Minions team.');
      return { id, mirror, member, epoch, capacity, counter };
    }));
    const emailCleanup = await prepareInvitationEmailCleanup(tx, operatorId, job.invitationEmailCursor);
    const at = now();
    const statusProgress = await prepareCurrentStateProgress(tx, records.map(record => record.contact.ref));
    emailCleanup.apply(at);
    tx.delete(db.doc(`webPresence/${operatorId}`));
    for (const item of memberships) {
      const before = item.member.data()!;
      const epoch = item.epoch + (before.status === 'active' ? 1 : 0);
      const member = before.status === 'active' ? { ...before, status: 'removed' as const, statusChangedAt: job.removedAt,
        updatedAt: at, revision: before.revision + 1, connectionEpoch: epoch } : before;
      tx.set(item.member.ref, member); tx.set(item.mirror.ref, member);
      tx.set(membershipFenceDoc(item.id, operatorId), { profileId: operatorId, projectId: item.id, epoch });
      tx.set(item.capacity, { revision: (item.counter.data()?.revision ?? 0) + 1 });
    }
    for (const record of records) {
      tx.update(record.agent.ref, { revokedAt: job.removedAt });
      const endedRun = record.run.exists && record.run.data()!.endedAt === null;
      if (endedRun) tx.update(record.run.ref, { endedAt: at, endReason: 'operator_removed' });
      writeAgentGroup(tx, record.contact.ref, { ...record.agent.data() as Agent, revokedAt: job.removedAt }, record.contact.exists ? { at, endedRun } : undefined, statusProgress);
    }
    const last = page.size < PAGE && memberPage.size < MEMBERS_PAGE && emailCleanup.done;
    const updated: AccountCleanup = { ...job, status: last ? 'done' : 'pending', cursor: page.docs.at(-1)?.ref.path ?? job.cursor,
      membershipCursor: memberPage.docs.at(-1)?.id ?? job.membershipCursor ?? '', membershipsDone: last,
      invitationEmailCursor: emailCleanup.cursor, invitationEmailsDone: emailCleanup.done,
      updatedAt: at, revokedAgents: job.revokedAgents + page.size };
    tx.set(ref, updated);
    return summary(updated);
  });
  // Authorization above completes before managed bytes are touched; retry also repairs a previous storage outage.
  if (result.status !== 'none') {
    await cleanupProfilePhotos(operatorId, now);
    const feedbackDone = await cleanupFeedback(operatorId);
    return db.runTransaction(async tx => {
      const [person, current] = await Promise.all([tx.get(profiles.doc(operatorId)), tx.get(accountCleanup.doc(operatorId))]);
      const job = current.data();
      if (!job) return result;
      validate(job, operatorId, person.data()?.removedAt);
      const done = job.feedbackDone === true || feedbackDone;
      tx.update(current.ref, { feedbackDone: done });
      return summary({ ...job, feedbackDone: done });
    });
  }
  return result;
}
