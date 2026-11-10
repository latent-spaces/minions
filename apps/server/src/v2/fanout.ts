// Project-wide items have a durable source and dispatch intent. Work commits one bounded page at
// a time. Two paths deliver it: the private dispatcher, and request-assisted delivery, in which
// some requests that create an item run a bounded slice and agent requests resume lapsed sources.
import { randomUUID } from 'node:crypto';
import { FieldPath, type Transaction } from '../firestore.js';
import { activeRecipientOperators, connectionAllowed } from '../projects/access.js';
import { V2_LIMITS } from '../config.js';
import { agents, currentProjectId, db } from '../firestore.js';
import { deliver, readTargets } from './inbox.js';
import { createFanoutJob, fanoutJobRef } from './fanout-jobs.js';
import { fanouts, type ItemKind } from './records.js';

const LEASE_MS = V2_LIMITS.fanoutLeaseSeconds * 1000;
const MAX_BATCHES = 4;
const MAX_RECOVERY_SOURCES = 16;

// Writes only. Returns the stable source ID; intent and source cannot commit independently.
export function createFanout(tx: Transaction, kind: ItemKind, payload: object, at: number,
  message?: { id: string, senderId: string }): string {
  const ref = message ? fanouts().doc(message.id) : fanouts().doc();
  tx.set(ref, {
    kind, payload: { ...payload }, messageId: message?.id ?? null, senderId: message?.senderId ?? null,
    createdAt: at, audienceBefore: at, cursor: '', delivered: 0, status: 'pending',
    leaseOwner: null, leaseUntil: 0, protocol: 2,
  });
  createFanoutJob(tx, ref.id, at);
  return ref.id;
}

type FanoutResult = 'done' | 'leased' | 'lost_lease' | 'pending' | 'stale' | 'blocked';

// At most four pages per invocation. A normal boundary releases the lease; a process death leaves
// it to expire. expectedGeneration fences delayed queue hints.
export async function runFanout(sourceId: string, now: () => number, expectedGeneration?: number): Promise<FanoutResult> {
  const owner = randomUUID();
  const ref = fanouts().doc(sourceId);
  const jobRef = fanoutJobRef(sourceId);
  const claimed = await db.runTransaction(async tx => {
    const found = (await tx.get(ref)).data();
    const job = (await tx.get(jobRef)).data();
    const at = now();
    if (expectedGeneration !== undefined && (!job || job.status !== 'pending' || job.generation !== expectedGeneration)) {
      return { result: 'stale' as const };
    }
    if (job && (job.projectId !== currentProjectId() || job.sourceId !== sourceId)) {
      tx.update(jobRef, { status: 'blocked', failure: 'invalid_context', updatedAt: at });
      return { result: 'blocked' as const };
    }
    if (job?.status === 'blocked') return { result: 'blocked' as const };
    if (!found) {
      if (job?.status === 'pending') tx.update(jobRef, { status: 'blocked', failure: 'missing_source', updatedAt: at });
      return { result: 'blocked' as const };
    }
    if (found.status === 'done') {
      if (job?.status === 'pending') tx.update(jobRef, { status: 'done', delivered: found.delivered, updatedAt: at });
      return { result: 'leased' as const };
    }
    if (found.leaseOwner !== null && found.leaseUntil > at) return { result: 'leased' as const };
    // createFanout commits the source and its job together, so a source without one is blocked.
    if (!job) return { result: 'blocked' as const };
    tx.update(jobRef, { readyAt: at + LEASE_MS, updatedAt: at });
    tx.update(ref, { leaseOwner: owner, leaseUntil: at + LEASE_MS });
    return { fanout: found };
  });
  if ('result' in claimed) return claimed.result!;
  const fanout = claimed.fanout;
  let cursor = fanout.cursor;
  for (let batches = 0; batches < MAX_BATCHES; batches++) {
    // Discovery skips retained revoked records; the committing transaction below stays authoritative.
    let query = agents().where('revokedAt', '==', null).orderBy(FieldPath.documentId()).limit(V2_LIMITS.fanoutBatch);
    if (cursor !== '') query = query.startAfter(cursor);
    const page = await query.get();
    const last = page.size < V2_LIMITS.fanoutBatch;
    const next = page.docs.at(-1)?.id ?? cursor;
    const finalBatch = last || batches === MAX_BATCHES - 1;

    const kept = await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      const job = (await tx.get(jobRef)).data();
      if (!current || current.status === 'done' || current.leaseOwner !== owner || current.leaseUntil <= now()
          || job?.status !== 'pending' || job.projectId !== currentProjectId() || job?.sourceId !== sourceId
          || (expectedGeneration !== undefined && job?.generation !== expectedGeneration)) return false;
      // Re-read membership inside the committing transaction. Revocation between page discovery
      // and delivery must prevent an inbox write, including on a transaction retry.
      const fresh = page.empty ? [] : await tx.getAll(...page.docs.map(d => d.ref));
      const candidates = fresh.filter(d => d.exists && d.id !== current.senderId
        && d.data()!.createdAt < current.audienceBefore && d.data()!.revokedAt === null);
      const operators = await activeRecipientOperators(tx, candidates.map(d => d.data()!.ownerProfileId));
      const audience = candidates.filter(d => connectionAllowed(d.data()!, operators)).map(d => d.id);
      const targets = await readTargets(tx, audience, sourceId);
      const at = now();
      if (current.leaseUntil <= at) return false;
      const count = deliver(tx, targets,
        { sourceId, kind: current.kind, messageId: current.messageId, payload: current.payload }, at);
      const delivered = current.delivered + count;
      tx.update(ref, {
        cursor: next, delivered, leaseUntil: finalBatch ? 0 : at + LEASE_MS,
        ...(finalBatch ? { leaseOwner: null } : {}), ...(last ? { status: 'done' } : {}),
      });
      tx.update(jobRef, { delivered, consecutiveFailures: 0, failure: null, updatedAt: at, readyAt: finalBatch ? at : at + LEASE_MS,
        ...(last ? { status: 'done' } : {}) });
      return true;
    });
    if (!kept) return 'lost_lease';
    if (last) return 'done';
    cursor = next;
  }
  return 'pending';
}

// Request-assisted delivery: a project-wide message, and a project control, configure
// change that creates an item, run one bounded slice before they answer. Other
// creators, such as the scheduled start, leave delivery to the
// dispatcher or a resume. A failure cannot undo the accepted source/intent; the dispatcher or a
// resume continues it.
export async function deliverProjectWide(sourceId: string, now: () => number): Promise<void> {
  let result: FanoutResult | undefined;
  try { result = await runFanout(sourceId, now); }
  catch (error) { console.error(`Fanout ${sourceId} stopped; durable intent remains pending.`, error); }
  // Work this process created and did not finish is checked again at the base cadence.
  if (result !== 'done') checkSoon();
}

// Bounded recovery that agent requests trigger, beside the private dispatcher. Sequential pages
// avoid a pending-source burst creating an unbounded Promise.all. The root dispatcher supplies
// cross-project fairness and recovery independently of participants. Returns whether any source
// was still pending, leased or not.
async function resumeFanouts(now: () => number): Promise<boolean> {
  const pending = await fanouts().where('status', '==', 'pending').limit(MAX_RECOVERY_SOURCES).get();
  for (const doc of pending.docs) {
    if (doc.data().leaseOwner === null || doc.data().leaseUntil <= now()) await runFanout(doc.id, now);
  }
  return !pending.empty;
}

// At most one lapsed-source check per project per interval in this process. The interval is
// fanoutCheckSeconds while a check finds pending sources or this process left one unfinished; each
// empty check doubles it up to FANOUT_CHECK_MAX_SECONDS, the Scheduler's one-minute /reconcile cadence, so an idle
// project costs one read a minute per process instead of twelve. A failed check keeps its interval.
// The state lives here, not in the project router, so a router evicted from the process cache and
// re-created keeps the cadence instead of checking on its first request. Oldest idle entries make room;
// one with a check in flight stays, so a re-created router cannot start a second resume for the same project.
const FANOUT_CHECK_PROJECTS = 1_000;
const FANOUT_CHECK_MAX_SECONDS = 60;
const baseCheckMs = () => V2_LIMITS.fanoutCheckSeconds * 1000;
type CheckState = { lastCheck: number; interval: number; checking: boolean; soon: boolean };
const fanoutChecks = new Map<string, CheckState>();
const checkCounts = { checks: 0, emptyChecks: 0, failedChecks: 0 };
export function checkLapsedFanouts(now: () => number): void {
  const projectId = currentProjectId(), at = now(), previous = fanoutChecks.get(projectId);
  // A check stamped later than this clock reading (a reset test clock) does not hold this one back.
  if (previous && (previous.checking || (at >= previous.lastCheck && at - previous.lastCheck < previous.interval))) return;
  fanoutChecks.delete(projectId);
  if (fanoutChecks.size >= FANOUT_CHECK_PROJECTS) {
    for (const [id, entry] of fanoutChecks) if (!entry.checking) { fanoutChecks.delete(id); break; }
  }
  const state: CheckState = { lastCheck: at, interval: previous?.interval ?? baseCheckMs(), checking: true, soon: false };
  fanoutChecks.set(projectId, state);
  checkCounts.checks++;
  resumeFanouts(now).then(found => {
    if (!found) checkCounts.emptyChecks++;
    // Work created while this check was reading must not be backed off by its empty answer.
    state.interval = found || state.soon ? baseCheckMs() : Math.min(FANOUT_CHECK_MAX_SECONDS * 1000, state.interval * 2);
  }, error => { checkCounts.failedChecks++; console.error('Checking lapsed fanouts failed.', error); })
    .finally(() => { state.checking = false; state.soon = false; });
}

function checkSoon(): void {
  const state = fanoutChecks.get(currentProjectId());
  if (!state) return;
  state.interval = baseCheckMs();
  if (state.checking) state.soon = true;
}

// Counts only, for this replica: tracked projects, checks in flight, checks started and how many found
// nothing or failed. Each started check bills at least one Firestore read.
export function fanoutCheckStats() {
  let inFlight = 0;
  for (const entry of fanoutChecks.values()) if (entry.checking) inFlight++;
  return { projects: fanoutChecks.size, inFlight, ...checkCounts };
}
