import { currentProjectId } from '../firestore.js';
import { projects, type ProjectRecord } from './records.js';
import { Refusal } from '../errors.js';

export function projectControl(record: ProjectRecord) {
  const state = record.execution;
  return { started: state.started, paused: state.paused, closed: state.completedAt !== null,
    revision: record.revision, ...(state.pauseRequest ? { pauseRequest: state.pauseRequest } : {}) };
}

type Waiter<T> = (value: T | undefined, error?: unknown) => void;
type Watch<T> = { latest?: { value: T | undefined }; waiters: Set<Waiter<T>>; stop?: () => void; error?: { value: unknown }; linger?: ReturnType<typeof setTimeout> };
type Open<T> = (key: string, next: (value: T | undefined) => void, fail: (error: unknown) => void) => () => void;

/** One live subscription per key in this process, shared by every held waiter.
 * A new waiter receives the latest delivered value (as a fresh listener's first snapshot would),
 * then each later change. The last waiter to leave stops the subscription; an error ends it for
 * all current waiters and the next waiter opens a new one. Authorization stays with each caller.
 * With lingerMs, the subscription stays open that long after its last waiter leaves, so a re-hold that reaches the
 * same process joins it instead of opening a new listener (one billed read and a listen-target round trip). At most
 * maxLingering subscriptions linger at once; past that, the last waiter stops it at once, as without a linger. */
export function createSharedWatches<T>(open: Open<T>, lingerMs = 0, maxLingering = Infinity) {
  const watches = new Map<string, Watch<T>>();
  let opened = 0, failed = 0, lingering = 0;
  const endLinger = (watch: Watch<T>) => {
    if (watch.linger === undefined) return;
    clearTimeout(watch.linger); watch.linger = undefined; lingering--;
  };
  function join(key: string, waiter: Waiter<T>) {
    let watch = watches.get(key);
    if (!watch) {
      const created: Watch<T> = { waiters: new Set() };
      watches.set(key, watch = created);
      opened++;
      created.stop = open(key, value => {
        created.latest = { value };
        for (const each of [...created.waiters]) each(value);
      }, error => {
        failed++;
        created.error = { value: error };
        endLinger(created);
        if (watches.get(key) === created) watches.delete(key);
        const waiters = [...created.waiters]; created.waiters.clear();
        created.stop?.();
        for (const each of waiters) each(undefined, error);
      });
      if (created.error) created.stop?.();
    }
    const joined = watch;
    endLinger(joined);
    joined.waiters.add(waiter);
    // Deliver asynchronously so the caller always holds its leave function first.
    if (joined.error) { const { value } = joined.error; queueMicrotask(() => waiter(undefined, value)); }
    else if (joined.latest) queueMicrotask(() => { if (joined.waiters.has(waiter) && joined.latest) waiter(joined.latest.value); });
    return () => {
      if (!joined.waiters.delete(waiter) || joined.waiters.size > 0) return;
      const stop = () => {
        endLinger(joined);
        if (joined.waiters.size > 0) return;
        if (watches.get(key) === joined) watches.delete(key);
        joined.stop?.();
      };
      if (lingerMs > 0 && lingering < maxLingering && !joined.error && watches.get(key) === joined) {
        lingering++; joined.linger = setTimeout(stop, lingerMs); joined.linger.unref?.();
      } else stop();
    };
  }
  // Counts only: held waiters are this process's held HTTP requests, which Cloud Run
  // counts against instance concurrency. listeners includes lingering ones. Keys never leave this module.
  function stats() {
    let held = 0;
    for (const watch of watches.values()) held += watch.waiters.size;
    return { heldRequests: held, listeners: watches.size, lingering, listenersOpened: opened, listenerErrors: failed };
  }
  return { join, stats };
}

// A connector re-holds at once after an answer, or after its 20 s failure back-off; 30 s covers both.
export const PROJECT_LISTENER_LINGER_MS = 30_000;
// The Firestore SDK runs each listener as its own Listen stream, 100 per client (c9). Lingering listeners are capped
// at one client's worth, so a busy process under random routing (≈710 active, ≈850 would linger at month 6) keeps
// today's behaviour instead of doubling its streams; one or two instances at launch stay well under it.
export const PROJECT_LISTENERS_MAX_LINGERING = 100;
const projectWatches = createSharedWatches<ProjectRecord>((id, next, fail) =>
  projects.doc(id).onSnapshot(snapshot => next(snapshot.data()), fail), PROJECT_LISTENER_LINGER_MS, PROJECT_LISTENERS_MAX_LINGERING);
/** Held project-control load on the replica that answers, for the platform health read. */
export const projectControlStats = () => projectWatches.stats();

// Held requests end early when this process shuts down (drainProjectControl). An early answer is the same as an
// unchanged timeout, which the connector simply re-holds; a reset connection would instead cost every holder its
// 20 s failure back-off at the same moment, during which it sees no pause, close or steering.
const DRAINING_HOLD_MS = 1_000;
// Answers are spread over this window, so the instance's holders re-hold elsewhere as a ramp rather than in one
// instant. It ends well inside the engine's shutdown.
export const DRAIN_SPREAD_MS = 3_000;
const releases = new Set<() => void>();
let draining = false;
/** Answers every held request in this process with its current state, and holds later ones only briefly. */
export function drainProjectControl(spreadMs = DRAIN_SPREAD_MS) {
  draining = true;
  for (const release of [...releases]) setTimeout(release, Math.random() * spreadMs).unref?.();
}

/** A bounded held request wakes on a committed project change, without a model turn.
 * The caller checks run authority before opening and again before delivering it. */
export function waitForProjectControl(afterRevision: number | undefined, signal: AbortSignal, timeoutMs = 25000,
  watches: { join(key: string, waiter: Waiter<ProjectRecord>): () => void } = projectWatches) {
  const key = currentProjectId();
  return new Promise<ReturnType<typeof projectControl>>((resolve, reject) => {
    let latest: ProjectRecord | undefined, leave: (() => void) | undefined, settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); leave?.(); signal.removeEventListener('abort', abort); releases.delete(release);
      if (error) reject(error);
      else if (latest) resolve(projectControl(latest));
      else reject(new Refusal('not_found', 'Project control is unavailable.'));
    };
    const abort = () => finish(new Refusal('bad_input', 'Project control connection closed.'));
    // A waiter still without its first snapshot gets the short draining hold instead.
    const release = () => { if (latest) finish(); else { clearTimeout(timer); timer = setTimeout(() => finish(), DRAINING_HOLD_MS); } };
    let timer = setTimeout(() => finish(), draining ? Math.min(timeoutMs, DRAINING_HOLD_MS) : timeoutMs);
    releases.add(release);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    leave = watches.join(key, (value, error) => {
      if (error) { finish(error); return; }
      latest = value;
      // Revisions only increase. A snapshot older than the caller's revision (this process's listener lagging
      // behind another instance) keeps holding instead of answering stale and costing the caller a re-sync.
      if (!latest || afterRevision === undefined || latest.revision > afterRevision) finish();
    });
  });
}

/** One held request: check run authority, hold, and check again before delivering new project state.
 * An unchanged timeout returns the revision the caller already sent, so it needs no second check
 * (about 10 reads); a revoked run is refused on its next open and by its own periodic contact. */
export async function heldProjectControl(afterRevision: number | undefined, signal: AbortSignal, checkRun: () => Promise<unknown>,
  timeoutMs = 25000, watches?: { join(key: string, waiter: Waiter<ProjectRecord>): () => void }) {
  await checkRun();
  const project = await waitForProjectControl(afterRevision, signal, timeoutMs, watches);
  if (afterRevision === undefined || project.revision !== afterRevision) await checkRun();
  return project;
}
