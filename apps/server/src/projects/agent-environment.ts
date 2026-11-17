import { z } from 'zod';
import { agents, db, projectCollection, type Agent, type WithId } from '../firestore.js';
import { assertMembership, assertAgentMembership } from './access.js';
import { Refusal } from '../errors.js';
import type { AgentEnvironmentReport, AgentEnvironmentView } from '@minions/contracts';

const text = z.string().min(1).max(1024).refine(v => !/[\x00-\x1f\x7f]/.test(v));
const REPORT = z.object({
  schemaVersion: z.literal(1), client: z.enum(['claude','codex','unknown']), mode: z.enum(['current_chat','background_worker']),
  connectorVersion: z.string().min(1).max(100), capturedAt: z.number().int().nonnegative(), workingFolder: text,
  sources: z.array(z.object({ path: text, scope: z.enum(['global','managed','ancestor','project','local','rules','nested','runner']),
    status: z.enum(['discovered','missing','unreadable','supplied']), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(64),
  truncated: z.boolean(), nativeLoading: z.literal('unverified'),
}).strict();
type Stored = { profileId: string; connectionEpoch: number; report: AgentEnvironmentReport; receivedAt: number };
const reports = () => projectCollection<Stored>('agentEnvironments');

export async function saveAgentEnvironment(identity: WithId<Agent>, input: unknown, now: () => number) {
  const parsed = REPORT.safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > 80 * 1024)
    throw new Refusal('bad_input', 'Send a bounded instruction metadata report without file contents.');
  return db.runTransaction(async tx => {
    await assertAgentMembership(tx, identity.id);
    const current = (await tx.get(agents().doc(identity.id))).data();
    if (!current || current.tokenHash !== identity.tokenHash || current.ownerProfileId !== identity.ownerProfileId)
      throw new Refusal('unauthorized', 'This agent connection changed. Reconnect before reporting.');
    const receivedAt = now();
    tx.set(reports().doc(identity.id), { profileId: current.ownerProfileId, connectionEpoch: current.connectionEpoch, report: parsed.data, receivedAt });
    return { receivedAt };
  });
}

export async function readAgentEnvironment(profileId: string, agentId: string, now: () => number): Promise<AgentEnvironmentView> {
  if (!/^[\w-]{1,200}$/.test(agentId)) throw new Refusal('not_found', 'This agent wasn’t found.');
  return db.runTransaction(async tx => {
    await assertMembership(tx, profileId);
    const agent = (await tx.get(agents().doc(agentId))).data();
    if (!agent || agent.ownerProfileId !== profileId) throw new Refusal('forbidden', 'Only the person this agent works for can see its local instructions.');
    const saved = (await tx.get(reports().doc(agentId))).data();
    const visible = saved?.profileId === profileId && saved.connectionEpoch === agent.connectionEpoch ? saved : null;
    return { agentId, report: visible?.report ?? null, receivedAt: visible?.receivedAt ?? null, serverTime: now() };
  });
}
