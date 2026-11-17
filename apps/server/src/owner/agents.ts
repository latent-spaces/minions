import { prepareUsageProgress } from '../v2/usage-progress.js';
import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { prepareProjectJourney } from '../onboarding/journeys.js';
import { associateWebStart } from './web-agent-starts.js';
import { assertProjectWritable } from '../projects/access.js';
import { runtimeWithCard } from '../projects/records.js';
import { cardDoc } from '../projects/card.js';
import { z } from 'zod';
import { Refusal } from '../errors.js';
import { hashToken } from '../auth.js';
import { agents, currentProjectId, db, projectCollection, projectDoc } from '../firestore.js';
import { assertMembership, currentConnectionEpoch } from '../projects/access.js';
import { clientNameSchema } from '../onboarding/registration.js';
import { agentLimit, agentLimitReached, workSettings } from '../onboarding/store.js';
import { AGENTS_PER_PARTICIPANT_CEILING } from '../platform/settings.js';
import { writeCreatedAgentStatus } from '../v2/agent-group.js';
import { presence } from '../v2/records.js';

const NAME = /^[\w-]{1,64}$/;

// folder is reported context for the person's records: the agent's folder, or the project's folder when the
// computer places the agent in its own layout.
export const connectOwnAgentInput = z.object({ name: z.string().regex(NAME), webStartId: z.string().uuid().optional(), agentId: z.string().regex(/^[\w-]{1,200}$/).optional(), candidateTokenHash: z.string().regex(/^[a-f0-9]{64}$/), clientName: clientNameSchema,
  folder: z.string().max(1000).regex(/^(?:\/|[A-Za-z]:[\\/])/).refine(v => !/[\x00-\x1f\x7f]/.test(v)) }).strict();

// The owner connects a named agent of their own in a project they belong to. The connector generated
// the agent's credential; only its hash arrives here.
export async function connectOwnAgent(personId: string, input: z.infer<typeof connectOwnAgentInput>, now: () => number) {
  const projectId = currentProjectId(), created = agents().doc();
  return db.runTransaction(async tx => {
    await assertMembership(tx, personId);
    const epoch = await currentConnectionEpoch(tx, personId);
    const [main, card] = await Promise.all([tx.get(projectDoc()), tx.get(cardDoc(projectId))]);
    await assertProjectWritable(tx);
    const project = runtimeWithCard(main.data(), card.data());
    if (!project) throw new Refusal('forbidden', 'This project isn’t set up yet. Ask the owner to finish setting it up.');
    // Serialize with every other registration path of this person.
    const fence = projectCollection<{ revision: number }>('agentRegistrationOwners').doc(personId), revision = (await tx.get(fence)).data()?.revision ?? 0;
    const [owned, limit] = await Promise.all([tx.get(agents().where('ownerProfileId', '==', personId).where('revokedAt', '==', null).where('connectionEpoch', '==', epoch).limit(AGENTS_PER_PARTICIPANT_CEILING)), agentLimit(tx)]);
    const existing = owned.docs.find(d => d.data().name === input.name), at = now();
    const credentials = await tx.get(agents().where('tokenHash', '==', input.candidateTokenHash).limit(2));
    if (credentials.docs.some(row => row.data().revokedAt !== null || row.id !== existing?.id))
      throw new Refusal('duplicate', 'This credential already belongs to another or revoked agent. Reconnect using a new agent credential.');
    const progress = await prepareProjectJourney(tx, personId, currentProjectId(), at);
    const statusProgress = await prepareCurrentStateProgress(tx, existing ? [] : [presence().doc(created.id)]);
    const usageProgress = await prepareUsageProgress(tx, existing ? [] : [created.id]);
    const webSettings=input.webStartId ? await associateWebStart(tx,personId,projectId,input.webStartId,input.name,existing?.id??created.id,
      existing ? {id:existing.id,tokenHash:existing.data().tokenHash} : undefined,input.candidateTokenHash,at) : undefined;
    // A tool that names an exact agent connects that one or nothing; it never creates another under the name.
    if (input.agentId !== undefined && existing?.id !== input.agentId) throw new Refusal('not_found', 'You have no agent with this ID and name in this project. List your agents and use its exact ID and name.');
    const answer = (agentId: string, state: { created: boolean; replayed: boolean }, settings = workSettings(existing?.data() ?? {})) =>
      ({ agentId, agentName: input.name, projectId, projectName: project.name, repoUrl: project.repoUrl, settings, ...state, startsAgents: false });
    if (existing?.data().tokenHash === input.candidateTokenHash) return answer(existing.id, { created: false, replayed: true });
    // A connected agent keeps its credential. A fresh credential is a new agent, or this one revoked first.
    if (existing && existing.data().tokenIssuedAt !== null) throw new Refusal('duplicate', 'This agent is already connected from another folder. Add an agent under another name, or revoke this one in its project first.');
    if (!existing && owned.size >= limit) throw agentLimitReached(limit, owned.size);
    progress(['agent']);
    if (existing) tx.update(existing.ref, { tokenHash: input.candidateTokenHash, tokenIssuedAt: at });
    else {
      const agent = { name: input.name, ownerProfileId: personId, connectionEpoch: epoch, tokenHash: input.candidateTokenHash, tokenIssuedAt: at, createdAt: at, revokedAt: null, ...(webSettings ? {workSettings:webSettings} : {}) };
      usageProgress(created.id, 'created'); tx.create(created, agent); writeCreatedAgentStatus(tx, presence().doc(created.id), agent, statusProgress);
    }
    tx.set(fence, { revision: revision + 1 });
    const agentId = existing?.id ?? created.id;
    tx.set(projectCollection<{ agentId: string; ownerProfileId: string; clientName: string; folder: string; connectedAt: number; tokenHashPrefix: string }>('ownerAgentConnections').doc(hashToken(`${agentId}:${input.candidateTokenHash}`)),
      { agentId, ownerProfileId: personId, clientName: input.clientName, folder: input.folder, connectedAt: at, tokenHashPrefix: input.candidateTokenHash.slice(0, 8) });
    return answer(agentId, { created: !existing, replayed: false }, webSettings ?? workSettings(existing?.data() ?? {}));
  });
}
