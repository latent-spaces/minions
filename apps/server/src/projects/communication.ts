import { assertProjectWritable, projectClosed } from './access.js';
import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { agents, db, projectDocument } from '../firestore.js';
import { assertMembership } from './access.js';
import { Refusal } from '../errors.js';
import { V2_LIMITS, COMMUNICATION_BOUNDS } from '../config.js';
import type { CommunicationSettings } from '@minions/contracts';
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

// Communication limits are a project-level setting only; every agent uses the project defaults (owner, 12 November 2026).
export async function resolveCommunication(tx: Transaction) {
  const record = (await tx.get(communicationPolicyDoc())).data();
  const policy = record === undefined ? null : POLICY.parse(record);
  return { ...(policy?.defaults ?? defaultCommunication()),
    sharedBroadcastsPerHour: policy?.sharedBroadcastsPerHour ?? V2_LIMITS.sharedBroadcastsPerHour,
    projectRevision: policy?.revision ?? 0 };
}

async function requireManager(tx: Transaction, profileId: string, message: string) {
  const role = await assertMembership(tx, profileId);
  if (role !== 'owner') throw new Refusal('forbidden', message);
}
const policyInput = POLICY.pick({ defaults: true, sharedBroadcastsPerHour: true })
  .extend({ expectedRevision: z.number().int().nonnegative() }).strict();

export async function readCommunication(profileId: string): Promise<CommunicationSettings> {
  return db.runTransaction(async tx => {
    await requireManager(tx, profileId, 'Only the owner can change the default message limits.');
    const effective = await resolveCommunication(tx);
    const { sharedBroadcastsPerHour, projectRevision, ...defaults } = effective;
    return { effective, canEditDefaults: !await projectClosed(tx),
      configuration: { defaults, sharedBroadcastsPerHour, projectRevision } };
  });
}
export async function saveCommunication(profileId: string, input: unknown, now: () => number) {
  const parsed = policyInput.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', 'Some limits are missing or out of range. Check them, then save again.');
  return db.runTransaction(async tx => {
    await requireManager(tx, profileId, 'Only the owner can change message limits.');
    await assertProjectWritable(tx);
    const data = parsed.data;
    const ref = communicationPolicyDoc(), current = (await tx.get(ref)).data();
    const before = current === undefined ? null : POLICY.parse(current);
    if (data.expectedRevision !== (before?.revision ?? 0)) throw new Refusal('proposal_conflict', 'Someone else changed the default message limits. Reload, then save again.');
    const result = { defaults: data.defaults, sharedBroadcastsPerHour: data.sharedBroadcastsPerHour,
      revision: data.expectedRevision + 1, updatedAt: now(), updatedByProfileId: profileId };
    tx.set(ref, result);
    return result;
  });
}
