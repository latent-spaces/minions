import { type CurrentStateProgress } from '../view/current-state-progress.js';
import type { DocumentReference, Transaction } from '../firestore.js';
import type { Agent } from '../firestore.js';

// Every writer of a field carried in the agent group replaces the WHOLE group from its transactional
// agent input. Other status groups are preserved. Preparation reads the progress shard before any writes;
// group, authoritative agent and durable progress all commit atomically. Historical records need no migration.
export type AgentGroup = { name: string; ownerProfileId: string; revokedAt: number | null; connectionEpoch: number;
  focus: { text: string; updatedAt: number } | null; personaText: string;
  // The newest message the agent sent, so every status reader can derive Talking (deriveAgentState) as the agents list does.
  lastSendAt: number | null };
type GroupFields = Pick<Agent, 'name' | 'ownerProfileId' | 'revokedAt' | 'connectionEpoch' | 'focus' | 'persona'> & { recentSends?: number[] };
export const agentGroup = (a: GroupFields): AgentGroup => ({ name: a.name, ownerProfileId: a.ownerProfileId,
  revokedAt: a.revokedAt ?? null, connectionEpoch: a.connectionEpoch,
  focus: a.focus ? { text: a.focus.text, updatedAt: a.focus.updatedAt } : null, personaText: a.persona?.text ?? '',
  lastSendAt: a.recentSends?.length ? Math.max(...a.recentSends) : null });
// `status` is the agent's presence document: presence().doc(agentId), or the same path where no project scope is set.
// `stop`: a revocation that also marks the run group stopping, and records the run's end when it ended the run in this
// transaction, does all of it in this one status write plus its durable change and progress writes.
export type RevocationStop = { at: number; endedRun: boolean };
// Creation (card v20): the agent group plus an explicit "never ran" run group (runId and runEndedAt null), so the new
// agent's status document is complete from its first write (contract C3). A run start replaces both (runs.ts runPresence).
export function writeCreatedAgentStatus(tx: Transaction, status: DocumentReference, agent: GroupFields, progress: CurrentStateProgress) {
  progress(status);
  tx.set(status, { agent: agentGroup(agent), runId: null, runEndedAt: null }, { mergeFields: ['agent', 'runId', 'runEndedAt'] });
}
export function writeAgentGroup(tx: Transaction, status: DocumentReference, after: GroupFields, stop: RevocationStop | undefined, progress: CurrentStateProgress) {
  const run = stop ? { phase: 'stopping', phaseAt: stop.at, ...(stop.endedRun ? { runEndedAt: stop.at } : {}) } : {};
  progress(status);
  tx.set(status, { agent: agentGroup(after), ...run }, { mergeFields: ['agent', ...Object.keys(run)] });
}
