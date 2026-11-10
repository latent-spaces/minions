import { assertProjectWritable, projectClosed } from './access.js';
import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { agents, db, projectDocument, type Agent } from '../firestore.js';
import { assertMembership, assertAgentMembership } from './access.js';
import { Refusal } from '../errors.js';
import { V2_LIMITS, COMMUNICATION_BOUNDS } from '../config.js';
import type { CommunicationSettings } from '@mlswarm/contracts';
import { activeRecipientOperators, connectionAllowed } from './access.js';

// First slice permits restrictions within the existing platform envelope.
// Zero/unlimited and larger platform capacities require a separate decision.
export const COMMUNICATION_FIELDS = z.object({
  broadcastAllowed: z.boolean(), sendsPerHour: z.number().int().min(1).max(COMMUNICATION_BOUNDS.sendsPerHour),
  minimumGapSeconds: z.number().int().min(COMMUNICATION_BOUNDS.minimumGapSeconds).max(COMMUNICATION_BOUNDS.maximumGapSeconds),
  broadcastsPerHour: z.number().int().min(1).max(COMMUNICATION_BOUNDS.broadcastsPerHour),
}).strict();
const metadata = { revision: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  updatedByProfileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) };
const POLICY = z.object({ ...metadata, defaults: COMMUNICATION_FIELDS,
  sharedBroadcastsPerHour: z.number().int().min(1).max(COMMUNICATION_BOUNDS.broadcastsPerHour) }).strict();
const OVERRIDE = z.object({ ...metadata, fields: COMMUNICATION_FIELDS.partial().strict() }).strict();
export type CommunicationOverride = z.infer<typeof OVERRIDE>;
export const communicationPolicyDoc = () => projectDocument<z.infer<typeof POLICY>>('settings/communication');
export const communicationUsageDoc = () => projectDocument<{ recentBroadcasts: number[] }>('usage/communication');
export const defaultCommunication = () => ({ broadcastAllowed: true, sendsPerHour: V2_LIMITS.sendsPerHour,
  minimumGapSeconds: V2_LIMITS.minSecondsBetweenSends, broadcastsPerHour: V2_LIMITS.projectWidePerHour });

// The saved shared allowance is per agent in the team, so the project-wide broadcast limit grows with the team.
export async function sharedBroadcastLimit(tx: Transaction, perAgent: number) {
  // Registration, not runtime activity, determines the team. Reuse the same
  // membership/connection authority as message delivery, including rejoin fences.
  const candidates = (await tx.get(agents().where('revokedAt', '==', null))).docs.map(doc => doc.data());
  const operators = await activeRecipientOperators(tx, candidates.map(agent => agent.ownerProfileId));
  const team = candidates.filter(agent => connectionAllowed(agent, operators)).length;
  return perAgent * team;
}

export async function resolveCommunication(tx: Transaction, agent: Pick<Agent, 'communicationOverride'>) {
  const record = (await tx.get(communicationPolicyDoc())).data();
  const policy = record === undefined ? null : POLICY.parse(record);
  const override = agent.communicationOverride === undefined ? null : OVERRIDE.parse(agent.communicationOverride);
  return { ...COMMUNICATION_FIELDS.parse({ ...(policy?.defaults ?? defaultCommunication()), ...override?.fields }),
    sharedBroadcastsPerHour: policy?.sharedBroadcastsPerHour ?? V2_LIMITS.sharedBroadcastsPerHour,
    projectRevision: policy?.revision ?? 0, overrideRevision: override?.revision ?? 0 };
}

async function requireManager(tx: Transaction, profileId: string) {
  const role = await assertMembership(tx, profileId);
  if (role !== 'owner') throw new Refusal('forbidden', 'Only the owner can change message limits.');
}
const policyInput = POLICY.pick({ defaults: true, sharedBroadcastsPerHour: true })
  .extend({ expectedRevision: z.number().int().nonnegative() }).strict();
const overrideInput = z.object({ expectedRevision: z.number().int().nonnegative(),
  fields: COMMUNICATION_FIELDS.partial().strict() }).strict();

// Members see effective project policy; audit/configuration inputs remain manager-only.
export async function readCommunication(profileId: string, agentId?: string): Promise<CommunicationSettings> {
  if (agentId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(agentId)) throw new Refusal('not_found', 'This agent wasn’t found.');
  return db.runTransaction(async tx => {
    const role = await assertMembership(tx, profileId);
    const manager = role === 'owner';
    if (agentId === undefined && !manager) throw new Refusal('forbidden', 'Only the owner can change the default message limits.');
    const row = agentId === undefined ? undefined : (await tx.get(agents().doc(agentId))).data();
    if (agentId !== undefined && !row) throw new Refusal('not_found', 'This agent wasn’t found.');
    const effective = await resolveCommunication(tx, row ?? {});
    const policy = manager ? (await tx.get(communicationPolicyDoc())).data() : undefined;
    const overrideFields = row?.communicationOverride?.fields ?? {};
    const active = row && row.revokedAt === null && connectionAllowed(row, await activeRecipientOperators(tx, [row.ownerProfileId]));
    const editable = manager && !await projectClosed(tx);
    return { agentId: agentId ?? null, effective, canEditDefaults: editable, canEditAgent: editable && !!active,
      overriddenFields: Object.keys(overrideFields) as CommunicationSettings['overriddenFields'],
      ...(manager ? { configuration: { defaults: policy?.defaults ?? defaultCommunication(),
        sharedBroadcastsPerHour: effective.sharedBroadcastsPerHour, projectRevision: effective.projectRevision,
        overrideFields, overrideRevision: effective.overrideRevision } } : {}) };
  });
}
export async function saveCommunication(profileId: string, input: unknown, now: () => number, agentId?: string) {
  if (agentId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(agentId)) throw new Refusal('not_found', 'This agent wasn’t found.');
  const parsed = (agentId === undefined ? policyInput : overrideInput).safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', 'Some limits are missing or out of range. Check them, then save again.');
  return db.runTransaction(async tx => {
    await requireManager(tx, profileId);
    await assertProjectWritable(tx);
    const at = now();
    if (agentId === undefined) {
      const data = policyInput.parse(parsed.data);
      const ref = communicationPolicyDoc(), current = (await tx.get(ref)).data();
      const before = current === undefined ? null : POLICY.parse(current);
      if (data.expectedRevision !== (before?.revision ?? 0)) throw new Refusal('proposal_conflict', 'Someone else changed the default message limits. Reload, then save again.');
      const result = { defaults: data.defaults, sharedBroadcastsPerHour: data.sharedBroadcastsPerHour,
        revision: data.expectedRevision + 1, updatedAt: at, updatedByProfileId: profileId };
      tx.set(ref, result);
      return result;
    }
    const data = overrideInput.parse(parsed.data);
    const ref = agents().doc(agentId), row = (await tx.get(ref)).data();
    if (!row || row.revokedAt !== null) throw new Refusal('not_found', 'This agent wasn’t found, or it was removed.');
    await assertAgentMembership(tx, agentId);
    const current = row.communicationOverride === undefined ? null : OVERRIDE.parse(row.communicationOverride);
    if (data.expectedRevision !== (current?.revision ?? 0)) throw new Refusal('proposal_conflict', 'Someone else changed this agent’s message limits. Reload, then save again.');
    // Empty fields reset inheritance while retaining the optimistic revision fence.
    const result = { fields: data.fields, revision: data.expectedRevision + 1, updatedAt: at, updatedByProfileId: profileId };
    tx.update(ref, { communicationOverride: result });
    return result;
  });
}
