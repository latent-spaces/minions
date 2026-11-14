import { isPrivateProject } from './schema.js';
import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { githubRepositoryUrl } from '@mlswarm/contracts';
import { hashToken } from '../auth.js';
import { collection, db, inProject, profiles, type Profile, type WithId } from '../firestore.js';
import { Refusal } from '../errors.js';
import { platformSettings, privateParticipantLimit } from '../platform/settings.js';
import { projectAdmission } from './project-admission.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { PROJECT_RECORD, projects } from './records.js';
import { PROPOSAL_CONTENT } from '../community/content.js';
import { cardDoc, cardVersions, cardVersionId } from './card.js';
import { SETUP_PLAN } from './setup-schema.js';
import { initializeSetupCommunication } from './setup-plan.js';
import { createCommunityDefaults } from './community-schema.js';
import { membershipDoc, membershipFenceDoc, membershipsOf, membershipEpoch, type Membership } from './access.js';
import { membershipCleanup, continueMembershipCleanup } from './member-cleanup.js';

export const CREATE_PRIVATE = z.object({ client_request_id: z.string().uuid(), title: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(1500), githubUrl: z.string().max(300).refine(url => githubRepositoryUrl(url) !== null, 'Enter a GitHub repository URL, such as https://github.com/owner/repository.').transform(url => githubRepositoryUrl(url)!), rules: z.string().trim().max(3000).optional(), setupPlan: SETUP_PLAN.optional() }).strict();
const operations = collection<{ actorProfileId: string; fingerprint: string; result: object }>('privateProjectOperations');
const active = (profile: Profile | undefined) => !!profile && profile.removedAt === null;

export async function createPrivateProject(actor: WithId<Profile>, input: z.infer<typeof CREATE_PRIVATE>, now: () => number) {
  input = CREATE_PRIVATE.parse(input);
  const id = hashToken(`private-project:${actor.id}:${input.client_request_id}`), fingerprint = hashToken(JSON.stringify(input));
  return db.runTransaction(async tx => {
    const [person, receipt, current, limits] = await Promise.all([tx.get(profiles.doc(actor.id)), tx.get(operations.doc(id)), tx.get(projects.doc(id)), tx.get(platformSettings)]);
    if (!active(person.data())) throw new Refusal('unauthorized', 'Your MyLittleSwarm account is no longer active.');
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { ...receipt.data()!.result, replayed: true };
    }
    if (current.exists) throw new Refusal('intent_conflict', 'This request already created a project. Open it from your project list.');
    const at = now();
    writePrivateProject(tx, id, actor.id, input, at);
    tx.create(projectAdmission(id), { capacity: privateParticipantLimit(limits.data()), newcomers: false, revision: 0 });
    const result = { id, memberLimit: privateParticipantLimit(limits.data()), messageProtection: 'server_readable_v1', replayed: false };
    tx.create(operations.doc(id), { actorProfileId: actor.id, fingerprint, result });
    return result;
  });
}

export async function leavePrivateProject(actor: WithId<Profile>, id: string, requestId: string, now: () => number) {
  const operationId = hashToken(`private-leave:${id}:${actor.id}:${z.string().uuid().parse(requestId)}`);
  const result = await inProject(id, () => db.runTransaction(async tx => {
    const [person, project, member, fence, previous, capacity] = await Promise.all([tx.get(profiles.doc(actor.id)), tx.get(projects.doc(id)), tx.get(membershipDoc(id, actor.id)), tx.get(membershipFenceDoc(id, actor.id)), tx.get(operations.doc(operationId)), tx.get(collection<{ revision: number }>(`projects/${id}/capacity`).doc('membership'))]);
    if (!active(person.data()) || !project.exists || project.data()!.ownerProfileId === actor.id) throw new Refusal('forbidden', 'The owner can’t leave their own project.');
    if (previous.exists) {
      if (project.data()!.approval !== null || !project.data()!.privacy || previous.data()!.actorProfileId !== actor.id || previous.data()!.fingerprint !== operationId)
        throw new Refusal('intent_conflict', 'This departure receipt needs review.');
      return { ...previous.data()!.result, replayed: true };
    }
    if (!isPrivateProject(project.data())) throw new Refusal('forbidden', 'Only a current private-project member can start this departure.');
    if (member.data()?.status !== 'active') throw new Refusal('not_found', 'You’re not a member of this project.');
    const epoch = membershipEpoch(id, actor.id, member.data(), fence.data()) + 1;
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    const at = now();
    const left: Membership = { ...member.data()!, status: 'left', statusChangedAt: at, connectionEpoch: epoch, revision: member.data()!.revision + 1, updatedAt: at };
    tx.set(membershipDoc(id, actor.id), left); tx.set(membershipsOf(actor.id).doc(id), left); tx.set(membershipFenceDoc(id, actor.id), { profileId: actor.id, projectId: id, epoch });
    tx.set(collection(`projects/${id}/capacity`).doc('membership'), { revision: (capacity.data()?.revision ?? 0) + 1 });
    tx.create(collection(`projects/${id}/membershipHistory`).doc(operationId), { operatorId: actor.id, at, member: left });
    tx.set(membershipCleanup().doc(actor.id), { operatorId: actor.id, projectId: id, epoch, cursor: '', status: 'pending', createdAt: at, updatedAt: at, revoked: 0 });
    const result = { left: true, replayed: false }; tx.create(operations.doc(operationId), { actorProfileId: actor.id, fingerprint: operationId, result }); return result;
  }));
  try { await continueMembershipCleanup(actor, id, actor.id, now); } catch { console.error('Leaving was accepted; agent cleanup remains pending.'); }
  return result;
}

function writePrivateProject(tx: Transaction, id: string, actorId: string, input: Pick<z.infer<typeof CREATE_PRIVATE>, 'title' | 'goal' | 'githubUrl' | 'rules' | 'setupPlan'>, at: number) {
  const definition = PROPOSAL_CONTENT.parse({ title: input.title, goal: input.goal, proposalFormat: 'simple', mergeApproval: 'anyone', githubUrl: input.githubUrl, ...(input.rules ? { rules: input.rules } : {}) });
  const record = PROJECT_RECORD.parse({ schemaVersion: 1, workspaceId: DEFAULT_WORKSPACE_ID, ownerProfileId: actorId, approval: null, ...(input.setupPlan ? { setupPlan: input.setupPlan } : {}),
      privacy: { visibility: 'private', messageProtection: 'server_readable_v1', createdAt: at },
      setup: { required: false, configuredAt: at, configuredByProfileId: actorId, finalizedAt: null, repoUrl: input.githubUrl, minContributors: null, startDeadline: null },
      execution: { startsAt: 0, paused: true, started: false, awaitingKickoff: true, completedAt: null }, publication: { listed: false, revision: 0 }, revision: 0 });
    tx.create(projects.doc(id), record);
    const card = { version: 1, definition, at, editorProfileId: actorId };
    tx.create(cardDoc(id), card); tx.create(cardVersions(id).doc(cardVersionId(1)), card);
    createCommunityDefaults(tx, id, actorId, at);
    initializeSetupCommunication(tx, id, input.setupPlan, actorId, at);
}
