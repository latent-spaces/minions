// Self-hosted delivery transport: an in-process stand-in for Cloud Tasks and Cloud Scheduler.
// Durable intent stays in fanoutJobs. This queue only carries hints, exactly like the hosted queue:
// losing it (crash, restart) is recovered by reservation expiry and the periodic reconcile round,
// and dispatch generation plus the fanout lease still fence stale or duplicate hints.
import type { Dispatch } from './fanout-jobs.js';
import { deliverHint, reconcileFanouts, reconcileWorker, singleFlight, type Enqueue, type WorkerResult } from './fanout-worker.js';

// The engine's queue envelope: a hint stops retrying only once BOTH the attempt count and the retry duration are exhausted.
export const LOCAL_QUEUE = {
  maxAttempts: 8, minBackoffMs: 5_000, maxBackoffMs: 60_000, maxRetryDurationMs: 300_000,
  // A recently used hint name is refused; reservation hints rely on that deduplication.
  tombstoneMs: 60 * 60_000,
  // FANOUT_OUTSTANDING_MAX assumes about four dispatches at a time.
  maxConcurrent: 4,
} as const;
export const LOCAL_RECONCILE_INTERVAL_MS = 60_000;

type Handle = (dispatch: Dispatch) => Promise<WorkerResult>;
type Entry = { dispatch: Dispatch; name: string; attempts: number; firstAttemptAt: number | null };

export function localTaskQueue(handle: Handle, now: () => number = Date.now, limits = LOCAL_QUEUE) {
  const names = new Map<string, number>(); // task name -> tombstone expiry (Infinity while queued)
  const ready: Entry[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let running = 0, closed = false;
  const idle = new Set<() => void>();

  const settleIdle = () => { if (!running && !ready.length && !timers.size) for (const done of idle) done(); };
  const pump = () => {
    while (!closed && running < limits.maxConcurrent && ready.length) void attempt(ready.shift()!);
    settleIdle();
  };
  const later = (entry: Entry, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); ready.push(entry); pump(); }, delay);
    timers.add(timer);
  };
  async function attempt(entry: Entry) {
    running++;
    const at = now();
    entry.firstAttemptAt ??= at;
    entry.attempts++;
    let status: number;
    try { status = (await handle(entry.dispatch)).status; } catch { status = 503; }
    running--;
    const finished = status >= 200 && status < 300;
    const exhausted = entry.attempts >= limits.maxAttempts && now() - entry.firstAttemptAt >= limits.maxRetryDurationMs;
    if (finished || exhausted || closed) {
      names.set(entry.name, now() + limits.tombstoneMs);
      if (!finished && !closed) console.error(JSON.stringify({ event: 'local_fanout_hint_exhausted', jobId: entry.dispatch.jobId, generation: entry.dispatch.generation }));
    } else {
      later(entry, Math.min(limits.maxBackoffMs, limits.minBackoffMs * 2 ** (entry.attempts - 1)));
    }
    pump();
  }

  const enqueue = async (dispatch: Dispatch): Promise<'created' | 'already_exists'> => {
    if (closed) throw new Error('Local delivery queue is closed.');
    if (!/^[a-f0-9]{64}$/.test(dispatch.jobId) || !Number.isSafeInteger(dispatch.generation) || dispatch.generation < 1) {
      throw new Error('Invalid task dispatch.');
    }
    const at = now();
    for (const [name, expiresAt] of names) if (expiresAt <= at) names.delete(name);
    const name = `${dispatch.jobId}-${dispatch.generation}`;
    if (names.has(name)) return 'already_exists';
    names.set(name, Infinity);
    ready.push({ dispatch: { jobId: dispatch.jobId, generation: dispatch.generation }, name, attempts: 0, firstAttemptAt: null });
    queueMicrotask(pump);
    return 'created';
  };
  // Waiting hints are dropped on close; running ones finish. Durable intent remains in fanoutJobs.
  const close = () => { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); ready.length = 0; settleIdle(); };
  const drained = () => new Promise<void>(resolve => {
    const done = () => { idle.delete(done); resolve(); };
    idle.add(done); settleIdle();
  });
  return { enqueue: enqueue satisfies Enqueue, close, drained, pending: () => ready.length + timers.size + running };
}

// Cloud Scheduler stand-in: one reconcile at a time, skipped while the previous one still runs.
export function localScheduler(run: () => Promise<unknown>, intervalMs = LOCAL_RECONCILE_INTERVAL_MS) {
  let active: Promise<void> | null = null;
  const tick = () => active ??= (async () => {
    try { await run(); } catch { console.error(JSON.stringify({ event: 'local_reconcile_failed' })); } finally { active = null; }
  })();
  const timer = setInterval(() => void tick(), intervalMs);
  // Resolves once any reconcile already running has finished.
  return { tick, stop: async () => { clearInterval(timer); await active; } };
}

// The whole self-hosted delivery worker: no HTTP listener, OIDC verification or Google APIs.
export function startLocalWorker(now: () => number = Date.now, intervalMs = LOCAL_RECONCILE_INTERVAL_MS) {
  const queue = localTaskQueue(dispatch => deliverHint(dispatch, round, now), now);
  const round = singleFlight(() => reconcileFanouts(queue.enqueue, now));
  const scheduler = localScheduler(() => reconcileWorker(round, now), intervalMs);
  void scheduler.tick();
  // Let a running reconcile finish enqueueing before the queue refuses new hints.
  return { queue, scheduler, stop: async () => { await scheduler.stop(); queue.close(); } };
}
