import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import type { AgentPersona, AgentParticipationContext } from '@minions/contracts';
import { z } from 'zod';
import { agents, currentProjectId, db, type Agent } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertAgentMembership, currentConnectionEpoch, assertProjectWritable, projectClosed } from './access.js';
import { workSettings } from '../onboarding/store.js';
import { V2_LIMITS } from '../config.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { writeAgentGroup } from '../v2/agent-group.js';
import { presence } from '../v2/records.js';
import { resolveCommunication, sharedBroadcastLimit } from './communication.js';

const TEXT = z.string().trim().max(4000).refine(value => [...value].length <= 2000)
  .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/);
const STORED = z.object({ text: TEXT, revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative().nullable() }).strict();
const PERSONA_INPUT = z.object({ text: TEXT, expectedRevision: z.number().int().nonnegative() }).strict();
const validId = (id: string) => /^[A-Za-z0-9_-]{1,200}$/.test(id);
function personaOf(agent: Pick<Agent, 'persona'>): AgentPersona {
  return agent.persona === undefined ? { text: '', revision: 0, updatedAt: null } : STORED.parse(agent.persona);
}

export async function readAgentPersona(personId: string, agentId: string) {
  if (!validId(agentId)) throw new Refusal('not_found', 'This agent wasn’t found.');
  return db.runTransaction(async tx => {
    await assertMembership(tx, personId);
    const row = await tx.get(agents().doc(agentId));
    if (!row.exists) throw new Refusal('not_found', 'This agent wasn’t found.');
    const a = row.data()!;
    const own = a.ownerProfileId === personId;
    const epoch = own ? await currentConnectionEpoch(tx, personId) : null;
    return { agentId, persona: personaOf(a), canEditPersona: own && a.revokedAt === null && a.connectionEpoch === epoch && !await projectClosed(tx) };
  });
}

export async function saveAgentPersona(personId: string, agentId: string, input: unknown, now: () => number) {
  if (!validId(agentId)) throw new Refusal('not_found', 'This agent wasn’t found.');
  const parsed = PERSONA_INPUT.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', 'Keep the persona to plain text of up to 2,000 characters, and save from the latest version.');
  return db.runTransaction(async tx => {
    await assertMembership(tx, personId); await assertProjectWritable(tx);
    const row = await tx.get(agents().doc(agentId));
    if (!row.exists || row.data()!.ownerProfileId !== personId || row.data()!.revokedAt !== null)
      throw new Refusal('forbidden', 'Only the person this agent works for can edit its persona.');
    await assertAgentMembership(tx, agentId);
    const current = personaOf(row.data()!);
    if (current.text === parsed.data.text) return { agentId, persona: current, canEditPersona: true };
    if (current.revision !== parsed.data.expectedRevision) throw new Refusal('proposal_conflict', 'Someone else changed this persona. Reload it, then edit again.');
    const persona = { text: parsed.data.text, revision: current.revision + 1, updatedAt: now() };
    const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
    tx.update(row.ref, { persona });
    writeAgentGroup(tx, presence().doc(agentId), { ...row.data()!, persona }, undefined, statusProgress);
    return { agentId, persona, canEditPersona: true };
  });
}

// Own-agent context, resolved from the same live authority as message acceptance.
export async function readParticipationContext(agentId: string, runId: string | undefined, now: () => number): Promise<AgentParticipationContext> {
  return db.runTransaction(async tx => {
    if (runId) await assertRunInTransaction(tx, agentId, runId); else await assertAgentMembership(tx, agentId);
    const a = (await tx.get(agents().doc(agentId))).data()!;
    const policy = await resolveCommunication(tx);
    return { identity: { projectId: currentProjectId(), agentId, profileId: a.ownerProfileId },
      persona: personaOf(a), messaging: { directRecipientsMax: V2_LIMITS.recipientsMax, sendsPerHour: policy.sendsPerHour,
        minimumGapSeconds: policy.minimumGapSeconds, broadcastAllowed: policy.broadcastAllowed,
        broadcastsPerAgentPerHour: policy.broadcastsPerHour, sharedBroadcastLimit: await sharedBroadcastLimit(tx, policy.sharedBroadcastsPerHour),
        projectRevision: policy.projectRevision },
      workDefaults: { ...workSettings(a), appliesTo: 'next_start' }, personaApplication: 'next_natural_turn_boundary', observedAt: now() };
  });
}
