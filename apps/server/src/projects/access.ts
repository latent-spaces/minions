import { agentComputerAllowed } from '../owner/computer-access.js';
import type { Transaction } from '../firestore.js';
import { agents, collection, validatedCollection, currentProjectId, profiles, type Agent, type Profile, type WithId } from '../firestore.js';
import { projects } from './records.js';
import { z } from 'zod';
import { Refusal } from '../errors.js';

// The one person owns their projects; anyone else in a project is a member (owner decision, 10 November 2026).
export type ProjectRole = 'owner' | 'member';
const MEMBERSHIP = z.object({
  profileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), projectId: z.string().regex(/^[a-f0-9]{64}$/),
  // Stored records may still carry the removed admin and moderator roles; they read as member.
  role: z.enum(['admin', 'moderator', 'member']), status: z.enum(['active', 'left', 'removed', 'banned']),
  statusChangedAt: z.number().int().nonnegative(),
  restrictions: z.object({ chatMutedUntil: z.number().int().nonnegative().nullable() }).strict(),
  revision: z.number().int().positive(), updatedAt: z.number().int().nonnegative(), connectionEpoch: z.number().int().nonnegative(),
}).strict();
export type Membership = z.infer<typeof MEMBERSHIP>;
export const membershipDoc = (projectId: string, profileId: string) => validatedCollection(`projects/${projectId}/members`, value => MEMBERSHIP.parse(value)).doc(profileId);
type MembershipFence = { profileId: string; projectId: string; epoch: number };
export const membershipFenceDoc = (projectId: string, profileId: string) => collection<MembershipFence>(`projects/${projectId}/membershipFences`).doc(profileId);
export const membershipsOf = (profileId: string) => validatedCollection(`profiles/${profileId}/memberships`, value => MEMBERSHIP.parse(value));
export const validProjectId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

// Every project uses explicit membership.
export async function projectRole(operator: WithId<Profile>, projectId = currentProjectId()): Promise<ProjectRole> {
  if (operator.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
  const [project, member] = await Promise.all([projects.doc(projectId).get(), membershipDoc(projectId, operator.id).get()]);
  if (!project.exists) throw new Refusal('not_found', 'This project wasn’t found, or you’re not a member. Choose one of your projects.');
  if (project.data()!.ownerProfileId === operator.id) return 'owner';
  if (!member.exists || member.data()!.status !== 'active' || member.data()!.profileId !== operator.id || member.data()!.projectId !== projectId) {
    throw new Refusal('not_found', 'This project wasn’t found, or you’re not a member. Choose one of your projects.');
  }
  return 'member';
}

export async function assertMembership(tx: Transaction, operatorId: string) {
  const operator = await tx.get(profiles.doc(operatorId));
  if (!operator.exists || operator.data()!.removedAt !== null) throw new Refusal('unauthorized', 'This person’s MyLittleSwarm account is no longer active.');
  const id = currentProjectId();
  const [project, member] = await Promise.all([tx.get(projects.doc(id)), tx.get(membershipDoc(id, operatorId))]);
  if (!project.exists || (project.data()!.ownerProfileId !== operatorId && (!member.exists || member.data()!.status !== 'active' || member.data()!.profileId !== operatorId || member.data()!.projectId !== id))) {
    throw new Refusal('unauthorized', 'This person is no longer a member of this project.');
  }
  return project.data()!.ownerProfileId === operatorId ? 'owner' : 'member';
}

// Epochs fence agent connections after participation is revoked.
// Malformed generations never grant access.
export const connectionEpoch = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : -1;
// The fence is separate authority: a membership record written without its generation cannot lower it.
export function membershipEpoch(projectId: string, operatorId: string, member: Membership | undefined, fence: MembershipFence | undefined): number {
  const epoch = member === undefined ? 0 : connectionEpoch(member.connectionEpoch);
  if (epoch < 0) return -1;
  if (!fence) return epoch;
  if (fence.projectId !== projectId || fence.profileId !== operatorId || connectionEpoch(fence.epoch) < 0 || fence.epoch === undefined) return -1;
  return Math.max(epoch, fence.epoch);
}
export function connectionAllowed(agent: Agent, operators: Map<string, { epoch: number; name: string }>): boolean {
  const expected = operators.get(agent.ownerProfileId);
  return expected !== undefined && connectionEpoch(agent.connectionEpoch) === expected.epoch;
}
export async function currentConnectionEpoch(tx: Transaction, operatorId: string): Promise<number> {
  const operators = await activeRecipientOperators(tx, [operatorId]);
  const epoch = operators.get(operatorId)?.epoch;
  if (epoch === undefined) throw new Refusal('unauthorized', 'This person is no longer a member of this project.');
  return epoch;
}
export async function assertAgentMembership(tx: Transaction, agentId: string): Promise<ProjectRole> {
  return (await agentMembership(tx, agentId)).role;
}
// The same check, also returning the agent document it read, for a caller that writes from it (no second read).
export async function agentMembership(tx: Transaction, agentId: string): Promise<{ role: ProjectRole; agent: Agent }> {
  const agent = await tx.get(agents().doc(agentId));
  if (!agent.exists || agent.data()!.revokedAt !== null) throw new Refusal('unauthorized', 'This agent is no longer active. Add it again from your agent list.');
  if (!await agentComputerAllowed(tx, agent.data()!)) throw new Refusal('unauthorized', 'This agent’s computer was revoked. Connect it again from an approved computer.');
  const operators = await activeRecipientOperators(tx, [agent.data()!.ownerProfileId]);
  if (!connectionAllowed(agent.data()!, operators)) throw new Refusal('unauthorized', 'This agent belongs to someone who is no longer a member of this project. Rejoin the project, then add the agent again.');
  return { role: operators.get(agent.data()!.ownerProfileId)!.role, agent: agent.data()! };
}

type EligibleOperator = { epoch: number; name: string; role: ProjectRole };
// Fresh recipient eligibility and project role from the same transactional authority snapshot,
// deduplicated by operator within a bounded message/fanout batch. No request/process role cache.
// A dangling active agent row does not restore a removed operator or project membership.
export async function activeRecipientOperators(tx: Transaction, operatorIds: string[]): Promise<Map<string, EligibleOperator>> {
  const ids = [...new Set(operatorIds)].filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id));
  if (ids.length === 0) return new Map();
  const operators = await tx.getAll(...ids.map(id => profiles.doc(id)));
  const projectId = currentProjectId();
  const names = new Map(operators.filter(d => d.exists && d.data()!.removedAt === null).map(d => [d.id, d.data()!.name]));
  const active = [...names.keys()];
  if (active.length === 0) return new Map();
  const project = await tx.get(projects.doc(projectId));
  if (!project.exists) return new Map();
  const ownerId = project.data()!.ownerProfileId;
  const members = active.filter(id => id !== ownerId);
  const [records, fences] = members.length ? await Promise.all([
    tx.getAll(...members.map(id => membershipDoc(projectId, id))),
    tx.getAll(...members.map(id => membershipFenceDoc(projectId, id))),
  ]) : [[], []];
  const eligible = new Map<string, EligibleOperator>(active.filter(id => id === ownerId).map(id => [id, { epoch: 0, name: names.get(id)!, role: 'owner' }]));
  for (const [index, record] of records.entries()) {
    const member = record.data(), epoch = membershipEpoch(projectId, record.id, member, fences[index].data());
    if (member?.status === 'active' && member.profileId === record.id && member.projectId === projectId && epoch >= 0) eligible.set(record.id, { epoch, name: names.get(record.id)!, role: 'member' });
  }
  return eligible;
}

export async function projectClosed(tx: Transaction, id = currentProjectId()) {
  return (await tx.get(projects.doc(id))).data()?.execution.completedAt != null;
}
export async function assertProjectWritable(tx: Transaction, id = currentProjectId()) {
  const project = (await tx.get(projects.doc(id))).data();
  if (project?.execution.completedAt != null) throw new Refusal('forbidden', 'This project is closed. Reopen it before making changes.');
}
