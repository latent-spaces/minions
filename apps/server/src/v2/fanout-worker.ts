import { reconcileHostingCleanup } from '../hosting/cleanup.js';
import { reconcileHostingOperations } from '../hosting/service.js';
import { reconcileUsageMetrics } from '../analytics/projection.js';
// Fanout rounds and periodic reconciliation, run by the engine's in-process queue (v2/local-fanout.ts):
// they advance lifecycle and durable delivery without participant authentication or paid model invocation.
import { reconcileScheduledStarts } from '../projects/scheduled-start.js';
import { dispatchFanoutJob, fanoutBacklog, reserveFanoutRound, type Dispatch } from './fanout-jobs.js';
export type Enqueue = (dispatch: Dispatch) => Promise<unknown>;

// Four enqueue RPCs at once; at most sixteen hints in one round. Failure leaves persisted intent
// reserved until expiry, never deletes it and never interprets a queue tombstone as completion.
export type FanoutRoundResult = { selected: number; refused: number; oldestDueSeconds: number | null };
export async function reconcileFanouts(enqueue: Enqueue, now: () => number): Promise<FanoutRoundResult> {
  const { dispatches: jobs, oldestDueSeconds } = await reserveFanoutRound(now);
  let refused = 0;
  for (let start = 0; start < jobs.length; start += 4) {
    const results = await Promise.allSettled(jobs.slice(start, start + 4).map(enqueue));
    refused += results.filter(result => result.status === 'rejected').length;
  }
  console.info(JSON.stringify({ event: 'fanout_reconcile', selected: jobs.length, enqueueRefused: refused, oldestDueSeconds }));
  return { selected: jobs.length, refused, oldestDueSeconds };
}

// One round in flight per process plus at most one trailing round. Callers arriving during a round
// share the trailing one, which starts after it and so observes every caller's committed state.
// Concurrent rounds would otherwise serialize on the single round-robin control document.
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null, trailing: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const round = run().finally(() => { if (current === round) current = null; });
    current = round;
    return round;
  };
  return () => {
    // A trailing round that has not started yet still observes this caller's state.
    if (trailing) return trailing;
    if (!current) return start();
    const next = current.then(() => undefined, () => undefined).then(() => { trailing = null; return start(); });
    trailing = next;
    return next;
  };
}

// Handlers for the in-process queue. Status 503 asks the queue to retry; 200 settles the request.
export type WorkerResult = { status: 200 | 503; body: Record<string, unknown> };
type Round = () => Promise<FanoutRoundResult>;

export async function deliverHint(dispatch: Dispatch, round: Round, now: () => number): Promise<WorkerResult> {
  try {
    const outcome = await dispatchFanoutJob(dispatch, now);
    console.info(JSON.stringify({ event: 'fanout_dispatch', jobId: dispatch.jobId, generation: dispatch.generation, outcome }));
    if (outcome === 'leased' || outcome === 'lost_lease') return { status: 503, body: { error: 'lease_busy' } };
    // Completion or a normal slice boundary drives another fair round immediately. Scheduler
    // remains the independent safety net for crashes and commit-to-enqueue loss.
    const next = await round();
    return { status: next.refused ? 503 : 200, body: { outcome, ...next } };
  } catch {
    console.error(JSON.stringify({ event: 'fanout_dispatch_failed', jobId: dispatch.jobId, generation: dispatch.generation }));
    return { status: 503, body: { error: 'retryable_failure' } };
  }
}

export async function reconcileWorker(round: Round, now: () => number): Promise<WorkerResult> {
  try {
    const [fanout, scheduled, queue, metrics, hosting, cleanup] = await Promise.allSettled([
      round(), reconcileScheduledStarts(now), fanoutBacklog(now), reconcileUsageMetrics(now), reconcileHostingOperations(now), reconcileHostingCleanup(now),
    ]);
    const shared = fanout.status === 'fulfilled' ? fanout.value : undefined;
    // Observation only: a failed backlog read never asks Scheduler to retry delivery work.
    const backlog = queue.status === 'fulfilled' ? queue.value : null;
    console.info(JSON.stringify({ event: 'fanout_backlog', ...(backlog ?? { error: 'unavailable' }) }));
    const scheduledStarts = scheduled.status === 'fulfilled' ? scheduled.value : undefined;
    const usageMetrics = metrics.status === 'fulfilled' ? metrics.value : undefined;
    const hostingCleanup = cleanup.status === 'fulfilled' ? cleanup.value : undefined;
    const projectHosting = hosting.status === 'fulfilled' ? hosting.value : undefined;
    const failedComponents = [
      ...(cleanup.status === 'rejected' || hostingCleanup?.failed ? ['hostingCleanup'] : []),
      ...(hosting.status === 'rejected' || projectHosting?.failed ? ['projectHosting'] : []),
      ...(metrics.status === 'rejected' || usageMetrics?.failed ? ['usageMetrics'] : []),
      ...(fanout.status === 'rejected' ? ['fanout'] : []),
      ...(scheduled.status === 'rejected' || scheduledStarts?.failed ? ['scheduledStarts'] : []),
    ];
    if (failedComponents.length) console.error(JSON.stringify({ event: 'worker_reconcile_failed', components: failedComponents }));
    // Keep successful component evidence visible, while asking Scheduler to retry failures.
    return { status: failedComponents.length || shared?.refused ? 503 : 200, body: {
      ...shared, backlog, usageMetrics, projectHosting, hostingCleanup,
      scheduledStarts: scheduledStarts ?? { error: 'retryable_failure' },
      ...(failedComponents.length ? { failedComponents } : {}),
    } };
  } catch { return { status: 503, body: { error: 'retryable_failure' } }; }
}
