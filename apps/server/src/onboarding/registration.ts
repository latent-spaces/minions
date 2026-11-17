import { prepareUsageProgress } from '../v2/usage-progress.js';
import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { prepareProjectJourney } from './journeys.js';
import { assertProjectWritable } from '../projects/access.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { hashToken, newToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { agents, currentProjectId, db, projectCollection } from '../firestore.js';
import { assertMembership, currentConnectionEpoch, connectionEpoch } from '../projects/access.js';
import { agentLimit, agentLimitReached } from './store.js';
import { AGENTS_PER_PARTICIPANT_CEILING } from '../platform/settings.js';
import { writeCreatedAgentStatus } from '../v2/agent-group.js';
import { presence } from '../v2/records.js';

// A person's agent identities. Connecting one is done by their approved computer (owner/agents.ts).
// MCP client-reported name is descriptive metadata, never proof of identity or authority.
export const clientNameSchema = z.string().min(1).max(100).refine(v => !/[\x00-\x1f\x7f]/.test(v)).transform(v => v.trim()).pipe(z.string().min(1));

export async function registerAgentTeam(personId: string, names: string[], requestId: string, now: () => number, requireOwner = false) {
  if (!/^[\w-]{1,64}$/.test(requestId) || names.length < 1 || names.length > 10 || new Set(names).size !== names.length || names.some(name => !/^[\w-]{1,64}$/.test(name))) throw new Refusal('bad_input', 'Choose 1 to 10 different agent names using letters, digits, hyphens or underscores. If you retry, keep the same request ID.');
  const refs = names.map(() => agents().doc());
  return db.runTransaction(async tx => {
    if (requireOwner && await assertMembership(tx, personId) !== 'owner') throw new Refusal('forbidden', 'Only the owner can add agents to this project from here.');
    const epoch = await currentConnectionEpoch(tx, personId);
    const receipt = projectCollection<{ ownerProfileId: string; epoch: number; names: string[]; agents: { agentId: string; agentName: string }[] }>('agentRegistrations').doc(hashToken(`${personId}:${requestId}`));
    // Serialize all registration paths per person, even when the roster is empty.
    const fence = projectCollection<{ revision:number }>('agentRegistrationOwners').doc(personId);
    const registrationRevision = (await tx.get(fence)).data()?.revision ?? 0;
    const saved = (await tx.get(receipt)).data();
    if (saved) {
      if (saved.ownerProfileId !== personId || saved.epoch !== epoch || JSON.stringify(saved.names) !== JSON.stringify(names)) throw new Refusal('duplicate', 'This request ID was already used for different agents. Check the original request, or use a new request ID.');
      const records = await tx.getAll(...saved.agents.map(a => agents().doc(a.agentId)));
      if (records.some((d, i) => !d.exists || d.data()!.ownerProfileId !== personId || d.data()!.name !== saved.agents[i].agentName || d.data()!.revokedAt !== null || connectionEpoch(d.data()!.connectionEpoch) !== epoch)) throw new Refusal('duplicate', 'Your agents changed since this request. Check your agent list, then try again.');
      return { agents: saved.agents, replayed: true, startsAgents: false, connectsAgents: false };
    }
    await assertProjectWritable(tx);
    const [owned, limit] = await Promise.all([tx.get(agents().where('ownerProfileId', '==', personId).where('revokedAt', '==', null).where('connectionEpoch', '==', epoch).limit(AGENTS_PER_PARTICIPANT_CEILING)), agentLimit(tx)]);
    if (owned.size + names.length > limit) throw agentLimitReached(limit, owned.size);
    if (owned.docs.some(d => names.includes(d.data().name))) throw new Refusal('duplicate', 'You already have an agent with one of these names. Pick it from your agent list, or choose different names.');
    const result = refs.map((ref, i) => ({ agentId: ref.id, agentName: names[i] }));
    const at = now();
    const progress = await prepareProjectJourney(tx, personId, currentProjectId(), at);
    const statusProgress = await prepareCurrentStateProgress(tx, refs.map(ref => presence().doc(ref.id)));
    const usageProgress = await prepareUsageProgress(tx, refs.map(ref => ref.id));
    progress(['agent']);
    refs.forEach((ref, i) => {
      const agent = { name: names[i], ownerProfileId: personId, connectionEpoch: epoch, tokenHash: hashToken(newToken()), tokenIssuedAt: null, createdAt: at, revokedAt: null };
      usageProgress(ref.id, 'created'); tx.create(ref, agent); writeCreatedAgentStatus(tx, presence().doc(ref.id), agent, statusProgress);
    });
    tx.set(fence, {revision:registrationRevision+1});
    tx.create(receipt, { ownerProfileId: personId, epoch, names, agents: result });
    return { agents: result, replayed: false, startsAgents: false, connectsAgents: false };
  });
}
export async function registerAgent(personId: string, name: string, now: () => number) {
  const result = await registerAgentTeam(personId, [name], randomUUID(), now);
  return result.agents[0];
}
