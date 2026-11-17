import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { assertMembership, assertProjectWritable } from '../projects/access.js';
import type { Transaction } from '../firestore.js';
import { limitReached, Refusal } from '../errors.js';
import { z } from 'zod';
import { agents, db, profiles, type Agent, type WorkSettings } from '../firestore.js';
import { presence, runs } from '../v2/records.js';
import { agentsPerParticipantLimit, platformSettings } from '../platform/settings.js';
import { writeAgentGroup } from '../v2/agent-group.js';

// The agents-per-person limit in force. Read it before the transaction's first write.
export const agentLimit = async (tx: Transaction) => agentsPerParticipantLimit((await tx.get(platformSettings)).data());
export const agentLimitReached = (limit: number, used: number) => limitReached({ scope: 'agents_per_participant', limit, used },
  `You have ${used} of ${limit} agents allowed per person in this project. Remove one from Your agents in this project before adding another.`);

export async function revokeOwned(personId: string, agentId: string, now: () => number) {
  await db.runTransaction(async (tx) => {
    await assertMembership(tx, personId);
    const owner = await tx.get(profiles.doc(personId));
    const agent = await tx.get(agents().doc(agentId));
    if (!owner.exists || owner.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your invitation is no longer active.');
    if (!agent.exists || agent.data()!.ownerProfileId !== personId) throw new Refusal('not_found', 'You have no agent with this ID. Check your agent list.');
    if (agent.data()!.revokedAt === null) {
      const at = now();
      const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
      const stopping = await stopRunInTransaction(tx, agentId, at, 'operator_revoked');
      tx.update(agent.ref, { revokedAt: at });
      writeAgentGroup(tx, presence().doc(agentId), { ...agent.data()!, revokedAt: at }, stopping ? { at, endedRun: true } : undefined, statusProgress);
    }
  });
}

// The limits an agent is offered to start under. The operator changes them in their coding agent, which
// saves them through the approved computer; the agent reads them in get_project and My agents shows them.
export const workSettingsInput = z.object({ involvement: z.enum(['with_me', 'on_own']) }).strict();
export const workSettings = (agent: Pick<Agent, 'workSettings'>): WorkSettings => ({ involvement: agent.workSettings?.involvement ?? 'on_own' });

export async function saveWorkSettings(personId: string, agentId: string, settings: WorkSettings) {
  return db.runTransaction(async (tx) => {
    await assertMembership(tx, personId); await assertProjectWritable(tx);
    const agent = await tx.get(agents().doc(agentId));
    if (!agent.exists || agent.data()!.ownerProfileId !== personId || agent.data()!.revokedAt !== null) throw new Refusal('not_found', 'You have no active agent with this ID. Check your agent list.');
    tx.update(agent.ref, { workSettings: settings });
    return { agentId, settings };
  });
}

// Revocation also changes the run in the same transaction. In-flight delivery
// mutations compare that run, so a late old process cannot commit after this fence.
// Returns whether the caller's status-document write also marks the run group stopping.
async function stopRunInTransaction(tx: Transaction, agentId: string, at: number, reason: string) {
  const run = await tx.get(runs().doc(agentId));
  const contact = await tx.get(presence().doc(agentId));
  if (!run.exists || run.data()!.endedAt !== null) return false;
  tx.update(run.ref, { endedAt: at, endReason: reason });
  return contact.exists;
}
