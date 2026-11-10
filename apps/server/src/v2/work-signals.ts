import { effectiveNativeTaskSettings } from '../projects/native-task-settings.js';
import { runInTransaction } from './runs.js';
import type { Run } from './records.js';
// One self-scoped scheduling hint, not a shared project counter or Issue progress.
import type { Transaction } from '../firestore.js';
import { db, projectDocument, projectCollection } from '../firestore.js';
import { Refusal } from '../errors.js';
export type WorkSignal = { revision: number; runnable: boolean };
// Independent counters for runnable recovery intents and unanswered-by-agent human replies.
// Existing summaries predate human requests, so their absent reply count is zero.
type StoredWorkSignal = WorkSignal & { runnableCount: number; humanAnswerCount?: number };
export const workSignalDoc = (agentId: string) => projectDocument<StoredWorkSignal>(`agents/${agentId}/workIntentControl/main`);
export function checkedWorkSignal(value: WorkSignal | undefined): WorkSignal {
  if (!value) return { revision: 0, runnable: false };
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.runnable !== 'boolean') {
    throw new Refusal('intent_conflict', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
  }
  return { revision: value.revision, runnable: value.runnable };
}
export async function countedWorkSignal(tx: Transaction, agentId: string, stored: StoredWorkSignal | undefined) {
  const signal = checkedWorkSignal(stored);
  if (stored) {
    const count = stored.runnableCount, humanAnswerCount = stored.humanAnswerCount ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(humanAnswerCount) || humanAnswerCount < 0 || !Number.isSafeInteger(count + humanAnswerCount) || stored.runnable !== (count + humanAnswerCount > 0)) {
      throw new Refusal('intent_conflict', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    }
    return { ...signal, runnableCount: count, humanAnswerCount };
  }
  // One indexed aggregate when creating a summary. Do not fetch old checkpoint
  // bodies or repeat an existence query on every ongoing update. The same summary is fenced.
  const aggregate = await tx.get(projectCollection(`agents/${agentId}/workIntents`).where('state', '==', 'runnable').count());
  const count = aggregate.data().count;
  if (!Number.isSafeInteger(count) || count < 0) throw new Refusal('intent_conflict', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
  return { ...signal, runnable: count > 0, runnableCount: count, humanAnswerCount: 0 };
}
export async function workSignalAtStart(tx: Transaction, agentId: string) {
  const ref = workSignalDoc(agentId);
  const snapshot = await tx.get(ref);
  const signal = await countedWorkSignal(tx, agentId, snapshot.data());
  return { ref, create: !snapshot.exists, signal };
}


/** Project the contact hint without task-linked runnable work while the capability is OFF.
 * Retain stored checkpoints/counters; ordinary work and human answers remain actionable.
 */
export async function effectiveTaskWorkSignal(agentId: string, runId: string, now: () => number = Date.now): Promise<WorkSignal> {
  return db.runTransaction(async tx => taskWorkSignalIn(tx, agentId, (await runInTransaction(tx, agentId, runId, now)).run));
}

// The hint from a run snapshot this transaction already checked; the run is not read again.
export async function taskWorkSignalIn(tx: Transaction, agentId: string, run: Run): Promise<WorkSignal> {
  const [settings, stored] = await Promise.all([effectiveNativeTaskSettings(tx), tx.get(workSignalDoc(agentId))]);
  const signal = checkedWorkSignal(run.workSignal);
  if (settings.enabled) return signal;
  const unlinked = await tx.get(projectCollection(`agents/${agentId}/workIntents`).where('state', '==', 'runnable').where('taskId', '==', null).count());
  const answers = stored.data()?.humanAnswerCount ?? 0;
  if (!Number.isSafeInteger(answers) || answers < 0) throw new Refusal('intent_conflict', 'The recovery hint is unavailable. Read the current state again.');
  return { revision: signal.revision, runnable: unlinked.data().count + answers > 0 };
}
