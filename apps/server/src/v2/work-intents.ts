import { assertNativeTasksEnabled } from '../projects/native-task-settings.js';
import { assertProjectWritable } from '../projects/access.js';
import { runtimeOf } from '../projects/records.js';
// Recovery checkpoints only: these neither execute actions nor establish GitHub progress.
import { createHash } from 'node:crypto';
import { FieldPath } from '../firestore.js';
import * as z from 'zod';
import { currentProjectId, db, projectCollection, projectDoc } from '../firestore.js';
import { Refusal } from '../errors.js';
import { runs } from './records.js';
import { countedWorkSignal, workSignalDoc } from './work-signals.js';
import { nativeTasks } from '../projects/native-tasks.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { assertRunInTransaction } from './runs.js';

const id = z.string().regex(/^[\w-]{1,64}$/);
export const WORK_INTENT = z.object({
  intent_id: id,
  client_request_id: id,
  expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  state: z.enum(['runnable', 'waiting', 'blocked', 'done', 'cancelled']),
  next_step: z.string().trim().min(1).max(2000),
  task_id: z.string().regex(/^task_[a-f0-9]{64}$/).optional(),
  blocker: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === 'blocked' && value.blocker === undefined) ctx.addIssue({ code: 'custom', message: 'Describe the blocker for blocked work.' });
  if (value.blocker !== undefined && !['waiting', 'blocked'].includes(value.state)) ctx.addIssue({ code: 'custom', message: 'Supply a blocker only for waiting or blocked work.' });
});
export type WorkIntent = {
  id: string; revision: number; agentId: string; recordedRunId: string;
  state: z.infer<typeof WORK_INTENT>['state']; pending: boolean;
  nextStep: string; blocker: string | null; taskId: string | null;
  createdAt: number; updatedAt: number;
};
const intents = (agentId: string) => projectCollection<WorkIntent>(`agents/${agentId}/workIntents`);
const operations = (agentId: string) => projectCollection<{ fingerprint: string; intent: WorkIntent }>(`agents/${agentId}/workIntentOperations`);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function recordWorkIntent(agentId: string, runId: string, raw: unknown, now: () => number) {
  const parsed = WORK_INTENT.safeParse(raw);
  if (!parsed.success) throw new Refusal('bad_input', parsed.error.issues[0]?.message ?? 'Check the work intent fields.');
  const input = parsed.data;
  const fingerprint = digest(JSON.stringify([input.intent_id, input.expected_revision, input.state,
    input.next_step, input.task_id ?? null, input.blocker ?? null]));
  return db.runTransaction(async tx => {
    await assertRunInTransaction(tx, agentId, runId);
    const ref = intents(agentId).doc(input.intent_id);
    const operation = operations(agentId).doc(input.client_request_id);
    const signalRef = workSignalDoc(agentId);
    const [stored, current, project, signalSnapshot] = await Promise.all([tx.get(operation), tx.get(ref), tx.get(projectDoc()), tx.get(signalRef)]);
    const prior = current.data();
    if (input.task_id !== undefined && !(prior?.taskId === input.task_id && ['done', 'cancelled'].includes(input.state))) await assertNativeTasksEnabled(tx);
    if (stored.exists) {
      if (stored.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Use a new one.');
      return { intent: stored.data()!.intent, replayed: true, historical: true };
    }
    if (!runtimeOf(project.data())) throw new Refusal('not_found', 'This project isn’t set up yet.');
    await assertProjectWritable(tx);
    if ((prior?.revision ?? 0) !== input.expected_revision) {
      throw new Refusal('intent_conflict', 'This intent changed since you read it. Read list_work_intents again before updating it.');
    }
    const taskId = input.task_id ?? null;
    if (prior && prior.taskId !== taskId) throw new Refusal('bad_input', 'Keep an intent linked to the same task; use a new intent for different work.');
    if (taskId !== null && !(await tx.get(nativeTasks().doc(taskId))).exists) throw new Refusal('not_found', 'This task is unavailable in this project.');
    const signal = await countedWorkSignal(tx, agentId, signalSnapshot.data());
    if (signal.revision >= Number.MAX_SAFE_INTEGER) throw new Refusal('intent_conflict', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    const runnableCount = signal.runnableCount + Number(input.state === 'runnable') - Number(prior?.state === 'runnable');
    if (!Number.isSafeInteger(runnableCount) || runnableCount < 0) throw new Refusal('intent_conflict', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    const runnable = runnableCount + signal.humanAnswerCount > 0;
    const at = now();
    const intent: WorkIntent = { id: input.intent_id, revision: input.expected_revision + 1,
      agentId, recordedRunId: runId, state: input.state,
      pending: !['done', 'cancelled'].includes(input.state), nextStep: input.next_step,
      blocker: input.blocker ?? null, taskId,
      createdAt: prior?.createdAt ?? at, updatedAt: at };
    tx.set(ref, intent);
    tx.create(operation, { fingerprint, intent });
    const nextSignal = { revision: signal.revision + 1, runnable };
    tx.set(signalRef, { ...nextSignal, runnableCount, humanAnswerCount: signal.humanAnswerCount });
    tx.update(runs().doc(agentId), { workSignal: nextSignal });
    return { intent, replayed: false, historical: false };
  }, { maxAttempts: 2 }).catch(error => {
    if (error?.code === 10 || error?.code === 3 && /Transaction is invalid or closed/.test(String(error?.details))) {
      throw new Refusal('project_busy', 'Too many changes at once. Read the current state, then send the same input again with the same request ID. Finish this turn instead of waiting.', 5);
    }
    throw error;
  });
}

export async function listWorkIntents(agentId: string, runId: string, input: { cursor?: string; includeCompleted?: boolean; limit?: number } = {}) {
  const completed = input.includeCompleted ?? false;
  const scope = [currentProjectId(), agentId, completed];
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && (!cursor || cursor.length !== 4 || scope.some((part, i) => part !== cursor[i])
    || typeof cursor[3] !== 'string' || !/^[\w-]{1,64}$/.test(cursor[3]))) {
    throw new Refusal('bad_input', 'This cursor belongs to a different project, agent or query.');
  }
  return db.runTransaction(async tx => {
    await assertRunInTransaction(tx, agentId, runId);
    let query = completed ? intents(agentId).orderBy(FieldPath.documentId())
      : intents(agentId).where('pending', '==', true).orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor[3]);
    const size = input.limit ?? 20, docs = (await tx.get(query.limit(size + 1))).docs;
    const page = docs.slice(0, size);
    return { items: page.map(doc => doc.data()),
      next: docs.length > size ? encodeCursor([...scope, page.at(-1)!.id]) : null,
      source: 'agent-reported recovery intent; reconcile native task and local state before acting' };
  });
}
