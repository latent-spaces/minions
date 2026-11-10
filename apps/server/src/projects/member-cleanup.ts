import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { FieldPath } from '../firestore.js';
import { projects } from './records.js';
import { Refusal } from '../errors.js';
import { agents, db, inProject, profiles, projectCollection, type Profile, type WithId } from '../firestore.js';
import { presence, runs } from '../v2/records.js';
import { connectionEpoch, membershipEpoch, membershipFenceDoc, membershipDoc } from './access.js';
import { writeAgentGroup } from '../v2/agent-group.js';

type MembershipCleanup = {
  operatorId: string; projectId: string; epoch: number; cursor: string;
  status: 'pending' | 'done'; createdAt: number; updatedAt: number; revoked: number;
};
export const membershipCleanup = () => projectCollection<MembershipCleanup>('membershipCleanup');
// Revocation has up to five writes per agent (including progress/change), plus the job cursor.
const PAGE = 75;

// One authorized operation advances one durable page, at most 376 writes including the job cursor.
// Authorization is already fenced by membership epoch; cleanup never restores access.
// A pending reply also reports how long the cleanup has been pending since the removal.
export async function continueMembershipCleanup(owner: WithId<Profile>, id: string, operatorId: string, now: () => number) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(operatorId)) throw new Refusal('bad_input', 'Choose a member of this project.');
  return inProject(id, () => db.runTransaction(async tx => {
    const ref = membershipCleanup().doc(operatorId);
    const [person, project, found, member, fence] = await Promise.all([
      tx.get(profiles.doc(owner.id)), tx.get(projects.doc(id)), tx.get(ref), tx.get(membershipDoc(id, operatorId)), tx.get(membershipFenceDoc(id, operatorId)),
    ]);
    const job = found.data();
    // Recovery belongs to the existing durable departure and epoch, even if
    // its directly-created project became public after access was revoked.
    const selfCleanup = project.data()?.approval === null && !!project.data()?.privacy && owner.id === operatorId
      && member.data()?.profileId === operatorId && member.data()?.projectId === id
      && job?.operatorId === operatorId && job.projectId === id;
    if (!person.exists || person.data()!.removedAt !== null || (project.data()?.ownerProfileId !== owner.id && !selfCleanup)) {
      throw new Refusal('forbidden', 'Only the owner, or the member who is leaving, can finish this.');
    }
    if (!job) return { status: 'none' as const, revoked: 0 };
    if (job.operatorId !== operatorId || job.projectId !== id || !Number.isSafeInteger(job.epoch) || job.epoch < 1
      || member.data()?.profileId !== operatorId || member.data()?.projectId !== id || membershipEpoch(id, operatorId, member.data(), fence.data()) < job.epoch || !Number.isSafeInteger(job.revoked) || job.revoked < 0
      || typeof job.cursor !== 'string' || (job.cursor !== '' && !/^[A-Za-z0-9_-]{1,200}$/.test(job.cursor))
      || !['pending', 'done'].includes(job.status)) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    if (job.status === 'done') return { status: job.status, revoked: job.revoked };
    let query = agents().where('ownerProfileId', '==', operatorId).where('revokedAt', '==', null).orderBy(FieldPath.documentId()).limit(PAGE);
    if (job.cursor) query = query.startAfter(job.cursor);
    const page = await tx.get(query);
    const candidates = page.docs.filter(d => d.data().revokedAt === null && connectionEpoch(d.data().connectionEpoch) < job.epoch);
    const records = await Promise.all(candidates.map(async agent => ({
      agent, run: await tx.get(runs().doc(agent.id)), contact: await tx.get(presence().doc(agent.id)),
    })));
    const statusProgress = await prepareCurrentStateProgress(tx, records.map(record => record.contact.ref));
    const at = now();
    for (const record of records) {
      tx.update(record.agent.ref, { revokedAt: at });
      const endedRun = record.run.exists && record.run.data()!.endedAt === null;
      if (endedRun) tx.update(record.run.ref, { endedAt: at, endReason: 'membership_removed' });
      writeAgentGroup(tx, record.contact.ref, { ...record.agent.data(), revokedAt: at }, record.contact.exists ? { at, endedRun } : undefined, statusProgress);
    }
    const status = page.size < PAGE ? 'done' as const : 'pending' as const, revoked = job.revoked + records.length;
    tx.update(ref, { status, revoked, cursor: page.docs.at(-1)?.id ?? job.cursor, updatedAt: at });
    return status === 'pending' ? { status, revoked, pendingSinceSeconds: Math.floor((at - job.createdAt) / 1000) } : { status, revoked };
  }));
}
