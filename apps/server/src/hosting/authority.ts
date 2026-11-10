import type { Transaction } from '../firestore.js';
import type { Agent, Profile, WithId } from '../firestore.js';
import { agents, currentProjectId } from '../firestore.js';
import { activeRecipientOperators } from '../projects/access.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { Refusal } from '../errors.js';
import { hashToken } from '../auth.js';
import { computerConnections } from '../owner/computer-access.js';
import { projects, runtimeOf } from '../projects/records.js';
import { assertCanAct } from '../store/project-policy.js';

export type HostingComputerConnection = { connectionId: string; tokenHashDigest: string };
export type HostingActor = { kind: 'person'; person: WithId<Profile>; computer?: HostingComputerConnection } | { kind: 'agent'; agent: WithId<Agent>; runId: string };
export const hostingActorKey = (actor: HostingActor) => actor.kind === 'person' ? actor.computer ? `computer:${actor.computer.connectionId}` : `person:${actor.person.id}` : `agent:${actor.agent.id}`;
export async function assertHostingComputer(tx: Transaction, computer: HostingComputerConnection, profileId: string, at: number) {
  const current = (await tx.get(computerConnections.doc(computer.connectionId))).data();
  if (!current || current.profileId !== profileId || !Number.isFinite(current.approvedAt) || current.revokedAt !== null
    || !Number.isFinite(current.connectionExpiresAt) || at >= current.connectionExpiresAt!
    || hashToken(current.candidateTokenHash) !== computer.tokenHashDigest)
    throw new Refusal('unauthorized', 'This computer approval expired or was ended. Approve this computer again.');
}
export async function hostingAuthority(tx: Transaction, actor: HostingActor, now: () => number) {
  const profileId = actor.kind === 'person' ? actor.person.id : actor.agent.ownerProfileId;
  const operator = (await activeRecipientOperators(tx, [profileId])).get(profileId);
  if (!operator) throw new Refusal('unauthorized', 'This project membership is no longer active.');
  if (actor.kind === 'person' && actor.computer) await assertHostingComputer(tx, actor.computer, profileId, now());
  if (actor.kind === 'agent') {
    await assertRunInTransaction(tx, actor.agent.id, actor.runId, now);
    const current = (await tx.get(agents().doc(actor.agent.id))).data();
    if (!current || current.ownerProfileId !== profileId || current.tokenHash !== actor.agent.tokenHash) throw new Refusal('unauthorized', 'This agent connection has changed.');
  }
  return { profileId, epoch: operator.epoch, role: operator.role, name: operator.name, actorKey: hostingActorKey(actor) };
}
export async function hostingWritable(tx: Transaction, actor: HostingActor | null, agentMutation = actor?.kind === 'agent') {
  const project = (await tx.get(projects.doc(currentProjectId()))).data();
  if (!project || project.execution.completedAt !== null) throw new Refusal('forbidden', 'Reopen this project before publishing a new output.');
  if (agentMutation) {
    const runtime = runtimeOf(project);
    if (!runtime) throw new Refusal('not_started', 'This project is not ready for agent contributions.');
    assertCanAct(runtime);
  }
}
