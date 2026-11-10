// Durable dispatch intent. The private transport must accept only opaque job IDs and generations;
// project scope comes from this authoritative record, never from a request body.
import { createHash } from 'node:crypto';
import { FieldPath, type Transaction } from '../firestore.js';
import { collection, currentProjectId, db, inProject } from '../firestore.js';
import { V2_LIMITS } from '../config.js';

export type FanoutJob = {
  projectId: string; sourceId: string; createdAt: number; updatedAt: number;
  status: 'pending' | 'done' | 'blocked'; readyAt: number; generation: number;
  delivered: number; failure: string | null; consecutiveFailures?: number; olderFailureGeneration?: number;
};
export const fanoutJobs = collection<FanoutJob>('fanoutJobs');
export const fanoutProjects = collection<{ projectId: string }>('fanoutProjects');
const controls = collection<{ cursor: string }>('fanoutControl');
// D2: round-robin heads are split into contiguous project-id ranges, each with its own cursor
// document, so rounds on different shards never contend. Project ids are lowercase hex, so ranges
// split on the first character; the first and last ranges are open, so every id belongs to exactly
// one shard whatever its format. One shard is today's single cursor and keeps its document.
// Raise only with more than one delivery worker instance: one process already coalesces rounds.
export const FANOUT_SHARDS = 1;
export type FanoutShard = { shard: number; shards: number };
export function fanoutShardRange({ shard, shards }: FanoutShard) {
  if (![1, 2, 4, 8, 16].includes(shards) || !Number.isInteger(shard) || shard < 0 || shard >= shards) {
    throw new Error('Invalid fanout shard.');
  }
  const bound = (n: number) => (n * 16 / shards).toString(16);
  return { control: controls.doc(shard ? `roundRobin-${shard}` : 'roundRobin'),
    lo: shard ? bound(shard) : null, hi: shard < shards - 1 ? bound(shard + 1) : null };
}
// Each process rotates through shards from a random start, so instances spread across cursors.
let rotation = Math.floor(Math.random() * FANOUT_SHARDS);
const nextShard = (): FanoutShard => ({ shard: rotation++ % FANOUT_SHARDS, shards: FANOUT_SHARDS });
export const fanoutJobId = (projectId: string, sourceId: string) =>
  createHash('sha256').update(JSON.stringify([projectId, sourceId])).digest('hex');
export const fanoutJobRef = (sourceId: string) => fanoutJobs.doc(fanoutJobId(currentProjectId(), sourceId));

// Writes only: called in the same transaction as the source.
export function createFanoutJob(tx: Transaction, sourceId: string, createdAt: number): void {
  const projectId = currentProjectId();
  tx.set(fanoutJobRef(sourceId), {
    projectId, sourceId, createdAt, updatedAt: createdAt, status: 'pending', readyAt: createdAt,
    generation: 0, delivered: 0, failure: null,
  });
  // Rewriting the head also conflicts with a selector deleting an empty head. It does not reset
  // round-robin position or create one head per source on a busy project.
  tx.set(fanoutProjects.doc(projectId), { projectId });
}

export type Dispatch = { jobId: string; generation: number };
// oldestDueSeconds: how long the longest-waiting job selected this round had been due, or null when
// none was selected. It covers only the projects scanned this round, not the whole queue.
type FanoutRound = { dispatches: Dispatch[]; oldestDueSeconds: number | null };
const MAX_PROJECTS = 16;
// D4: reservations whose queue hint has not run yet expire after the lease. If hints wait in the queue
// longer than that, jobs are re-reserved under a new generation, the old hints arrive stale, and the
// queue fills with hints that deliver nothing. Rounds therefore keep at most this many jobs reserved,
// running or backing off (pending with readyAt in the future). Keep it at or below
// dispatches per second × fanoutLeaseSeconds / 2 (today 4/s × 30 s / 2 = 60), so the expected queue
// wait stays under half the lease; raise it only together with the queue's dispatch rate. This counts live
// reservations, not queue depth: hints whose reservation already lapsed still sit in the queue, and 4/s is
// the queue's maximum, not the worker's actual service rate, so the wait estimate is optimistic.
export const FANOUT_OUTSTANDING_MAX = 60;

// A bounded durable round-robin: at most one ready job per project in this round. Reservation
// expires without a participant request if enqueue or the process dies. Queue hints can repeat;
// dispatch generation and the fanout's transaction lease fence stale/duplicate execution.
export async function reserveFanoutRound(now: () => number, shard = nextShard()): Promise<FanoutRound> {
  const { control, lo, hi } = fanoutShardRange(shard);
  return db.runTransaction(async tx => {
    const at = now();
    const saved = (await tx.get(control)).data()?.cursor ?? '';
    const liveReservations = (await tx.get(fanoutJobs.where('status', '==', 'pending').where('readyAt', '>', at).count())).data().count;
    const room = Math.min(MAX_PROJECTS, FANOUT_OUTSTANDING_MAX - liveReservations);
    // Over the cap the round reserves nothing and keeps its cursor, so round-robin order is preserved.
    if (room <= 0) return { dispatches: [], oldestDueSeconds: null };
    // A cursor saved under another shard count may lie outside this range: restart the range.
    const cursor = saved && (!lo || saved >= lo) && (!hi || saved < hi) ? saved : '';
    const ordered = fanoutProjects.orderBy(FieldPath.documentId());
    const start = cursor ? ordered.startAfter(cursor) : lo ? ordered.startAt(lo) : ordered;
    const after = await tx.get((hi ? start.endBefore(hi) : start).limit(MAX_PROJECTS));
    const heads = [...after.docs];
    if (heads.length < MAX_PROJECTS && cursor) {
      const wrapped = await tx.get((lo ? ordered.startAt(lo) : ordered).endAt(cursor).limit(MAX_PROJECTS - heads.length));
      heads.push(...wrapped.docs);
    }
    const selected: { id: string; generation: number; readyAt: number }[] = [];
    const empty: string[] = [];
    const invalid: string[] = [];
    // Heads after the last one examined stay ahead of the cursor for the next round.
    let examined = 0;
    for (const head of heads) {
      if (selected.length >= room) break;
      examined++;
      const base = fanoutJobs.where('projectId', '==', head.id).where('status', '==', 'pending');
      const due = await tx.get(base.where('readyAt', '<=', at).orderBy('readyAt').limit(1));
      if (due.empty) {
        // Future reservations/active leases keep their project visible. Check only one record.
        if ((await tx.get(base.limit(1))).empty) empty.push(head.id);
      } else {
        const job = due.docs[0];
        const generation = job.data().generation;
        if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) invalid.push(job.id);
        else selected.push({ id: job.id, generation: generation + 1, readyAt: job.data().readyAt });
      }
    }
    for (const job of selected) tx.update(fanoutJobs.doc(job.id), {
      generation: job.generation, readyAt: at + V2_LIMITS.fanoutLeaseSeconds * 1000, updatedAt: at,
    });
    for (const id of invalid) tx.update(fanoutJobs.doc(id), { status: 'blocked', failure: 'invalid_generation', updatedAt: at });
    for (const id of empty) tx.delete(fanoutProjects.doc(id));
    if (examined) tx.set(control, { cursor: heads[examined - 1].id });
    const oldest = Math.min(...selected.map(job => job.readyAt));
    return { dispatches: selected.map(job => ({ jobId: job.id, generation: job.generation })),
      oldestDueSeconds: selected.length ? Math.floor((at - oldest) / 1000) : null };
  });
}

// Whole-queue progress for the scheduled safety net: the longest-due pending job in any project and
// how many projects still hold a round-robin head. A round's oldestDueSeconds cannot show a project
// that is waiting behind the cursor. Two reads outside the reservation transaction.
export async function fanoutBacklog(now: () => number) {
  const at = now();
  const [due, heads] = await Promise.all([
    fanoutJobs.where('status', '==', 'pending').where('readyAt', '<=', at).orderBy('readyAt').limit(1).get(),
    fanoutProjects.count().get(),
  ]);
  const readyAt = due.docs[0]?.data().readyAt;
  return { globalOldestDueSeconds: readyAt === undefined ? null : Math.floor((at - readyAt) / 1000),
    backlogProjects: heads.data().count };
}

// The transport's IAM/OIDC boundary belongs to the worker service (not this library). This
// lookup additionally prevents a job payload from supplying a different project's authority.
export async function dispatchFanoutJob(dispatch: Dispatch, now: () => number) {
  if (!/^[a-f0-9]{64}$/.test(dispatch.jobId) || !Number.isSafeInteger(dispatch.generation) || dispatch.generation < 1) {
    throw new Error('Invalid fanout dispatch.');
  }
  const ref = fanoutJobs.doc(dispatch.jobId);
  const job = (await ref.get()).data();
  // D5: a hint from an earlier reservation stays valid while the job is pending. Re-reserving a job whose
  // hint is still queued must not revoke that hint, or a queue slower than the lease never delivers. The
  // run is fenced by the job's current generation, its source lease and per-recipient markers, so an older
  // hint cannot deliver twice. A hint newer than the job, or for finished work, is stale.
  if (!job || job.status !== 'pending' || !Number.isSafeInteger(job.generation) || job.generation < 1
      || dispatch.generation > job.generation) return 'stale' as const;
  const current: Dispatch = { jobId: dispatch.jobId, generation: job.generation };
  const older = dispatch.generation < job.generation;
  const scopeValid = /^[a-f0-9]{64}$/.test(job.projectId);
  if (!scopeValid || !/^[A-Za-z0-9_-]{1,128}$/.test(job.sourceId)
      || fanoutJobId(job.projectId, job.sourceId) !== ref.id) {
    await db.runTransaction(async tx => {
      const latest = (await tx.get(ref)).data();
      if (latest?.status === 'pending' && latest.generation === current.generation) {
        tx.update(ref, { status: 'blocked', failure: 'invalid_context', updatedAt: now() });
      }
    });
    return 'blocked' as const;
  }
  // Deferred import avoids a module initialization cycle: fanout creates the job atomically.
  const { runFanout } = await import('./fanout.js');
  try {
    const outcome = await inProject(job.projectId, () => runFanout(job.sourceId, now, current.generation));
    // The current holder is running this work: an older hint has nothing to add and must not cause a queue retry.
    return older && (outcome === 'leased' || outcome === 'lost_lease') ? 'stale' as const : outcome;
  } catch (error) {
    // Queued older hints each have their own queue retries, so counting all of their failures could block the
    // job within seconds. Each reservation generation counts at most one older-hint failure, and the older hint
    // does not ask for a retry. A persistent fault still blocks the job even when only older hints ever run
    // (a slow queue): every generation adds one failure. Current-hint accounting is unchanged.
    const recorded = await recordFanoutFailure(current, now, older);
    if (older) {
      console.error(JSON.stringify({ event: 'fanout_older_hint_failed', jobId: dispatch.jobId, generation: dispatch.generation,
        current: current.generation, recorded, errorName: error instanceof Error ? error.name : 'unknown' }));
      return recorded === 'retry' || recorded === 'counted' ? 'stale' as const : recorded;
    }
    if (recorded !== 'retry') return recorded;
    throw error;
  }
}

// Delivery exceptions get a persisted finite retry budget. Successful page progress resets it.
// Enqueue failures are handled separately by reservation expiry; they cannot erase accepted work.
// olderHint: the failure came from an older hint run under this generation; olderFailureGeneration marks the
// generation whose one older-hint failure has been counted, and later ones return 'counted' without a write.
async function recordFanoutFailure(dispatch: Dispatch, now: () => number, olderHint = false) {
  return db.runTransaction(async tx => {
    const ref = fanoutJobs.doc(dispatch.jobId);
    const job = (await tx.get(ref)).data();
    if (!job || job.generation !== dispatch.generation) return 'stale' as const;
    if (job.status === 'done') return 'done' as const;
    if (job.status === 'blocked') return 'blocked' as const;
    if (olderHint && job.olderFailureGeneration === dispatch.generation) return 'counted' as const;
    const failures = (job.consecutiveFailures ?? 0) + 1;
    const at = now();
    const blocked = failures >= 8;
    tx.update(ref, { consecutiveFailures: failures, updatedAt: at, failure: 'delivery_error',
      readyAt: Math.max(job.readyAt, at + Math.min(60_000, 5000 * 2 ** (failures - 1))),
      ...(olderHint ? { olderFailureGeneration: dispatch.generation } : {}),
      ...(blocked ? { status: 'blocked' } : {}) });
    return blocked ? 'blocked' as const : 'retry' as const;
  });
}
