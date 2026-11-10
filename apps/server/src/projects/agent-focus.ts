import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { z } from 'zod';
import { assertProjectWritable } from './access.js';
import { AGENT_TEXT_LIMIT, type AgentFocus } from '@mlswarm/contracts';
import { agents, db, projectDocument } from '../firestore.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { writeAgentGroup } from '../v2/agent-group.js';
import { presence } from '../v2/records.js';
import { untrusted } from '../v2/untrusted.js';

export const AGENT_STATUS_INPUT = z.object({
  status: z.string().trim().min(1).refine(value => [...value].length <= AGENT_TEXT_LIMIT && !/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)),
  client_request_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();
export const focusView = (value: AgentFocus | undefined): AgentFocus | null => value ? { text: value.text, updatedAt: value.updatedAt } : null;
export const focusWithSource = (agentId: string, value: AgentFocus | undefined) => value
  ? { text: untrusted({ type: 'agent', agentId }, value.text), updatedAt: value.updatedAt } : null;

/** Current run and membership are fenced in the same transaction as the write. */
export async function reportAgentFocus(agentId: string, runId: string, input: unknown, now: () => number, sequence?: number) {
  const parsed = AGENT_STATUS_INPUT.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', `Keep the status to one line of up to ${AGENT_TEXT_LIMIT} characters, and include a client_request_id.`);
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new Refusal('bad_input', 'Use a positive status observation sequence.');
  const { status, client_request_id: requestId } = parsed.data;
  const fingerprint = hashToken(JSON.stringify([runId, status, sequence ?? null]));
  return db.runTransaction(async tx => {
    await assertRunInTransaction(tx, agentId, runId); await assertProjectWritable(tx);
    const ref = agents().doc(agentId);
    const operation = projectDocument<{ fingerprint: string; focus: AgentFocus; superseded: boolean }>(`agentFocusOperations/${hashToken(agentId + ':' + requestId)}`);
    const [saved, receipt] = await Promise.all([tx.get(ref), tx.get(operation)]);
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { focus: receipt.data()!.focus, superseded: receipt.data()!.superseded, replayed: true };
    }
    const previous = saved.data()?.focus;
    // Repeated descriptions do not make an old observation appear newly authored.
    const superseded = sequence !== undefined && previous?.runId === runId && previous.sequence !== undefined && sequence <= previous.sequence;
    const focus = superseded ? previous! : {
      text: status, updatedAt: previous?.text === status && previous.runId === runId ? previous.updatedAt : now(), runId,
      ...(sequence === undefined ? previous?.runId === runId && previous.sequence !== undefined ? { sequence: previous.sequence } : {} : { sequence }),
    };
    const statusProgress = !superseded ? await prepareCurrentStateProgress(tx, [presence().doc(agentId)]) : undefined;
    if (!superseded) { tx.update(ref, { focus }); writeAgentGroup(tx, presence().doc(agentId), { ...saved.data()!, focus }, undefined, statusProgress!); }
    const visible = focusView(focus)!;
    tx.create(operation, { fingerprint, focus: visible, superseded });
    return { focus: visible, superseded, replayed: false };
  });
}
