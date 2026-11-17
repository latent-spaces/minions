// Canonical status serving: one bounded per-project projection, refreshed by a snapshot-isolated
// progress transaction on every request. Quiet polls read only the revision vector. Changed shards replay
// coalesced durable agent IDs and canonical heads. Request-time authority, viewer privacy, pinned paging and
// timer derivation remain independent of the cache. Historical records need no migration (owner, 27 Oct).
import { createHash, randomBytes } from 'node:crypto';
import type { QuerySnapshot, Timestamp } from '../firestore.js';
import { personaChoice, type CommunicationAgent } from '@minions/contracts';
import { agents, currentProjectId, db, type Agent } from '../firestore.js';
import { Refusal } from '../errors.js';
import { activeRecipientOperators, connectionAllowed } from '../projects/access.js';
import { humanRequests } from '../projects/human-requests.js';
import { projects } from '../projects/records.js';
import { webAgentStarts } from '../owner/web-agent-starts.js';
import { type Presence, type Run } from '../v2/records.js';
import type { WorkerSummary } from '../projects/worker-sessions.js';
import { deriveAgentState, type AgentStateSources, type DerivedAgentState } from './communication-agents.js';
import { createProjection, rev, type Answer, type Change, type Rev } from './current-state-core.js';
import { sourcesFromStatusDoc, statusRunComplete, type AgentStatusDoc } from './agent-status-doc.js';
import { readCurrentStateRefresh, progressReadStats, resetProgressReadStats, type ProgressFence } from './current-state-progress-reader.js';
import { requireCurrentStateCutover } from './current-state-cutover.js';

// Cached projects linger after their last reader. Overflow projections are separately byte-budgeted.
export const CURRENT_STATE_LINGER_MS = 30_000;
export const CURRENT_STATE_MAX_PROJECTS = 100;
// Additional projections use the same core/lifecycle, with a byte budget.
// This is estimated retained JS, not RSS. A base charge also bounds empty project entries (at most 512 extra).
export const CURRENT_STATE_CURRENT_BYTES = 32 * 1024 * 1024;
const WATCH_BYTES = 64 * 1024;
// Retained incomplete one-shot snapshots only. This bounds estimated retained JS storage, not process RSS or
// transient SDK query memory. Oversized snapshots still serve by fresh-read continuation (counted, no admission cap).
export const CURRENT_STATE_OWNED_BYTES = 32 * 1024 * 1024;
// Maximum retention age for an incomplete immutable page chain; never a freshness permission.
export const CURRENT_STATE_STALL_MS = 10_000;

// The field groups C3 assigns to writers; nothing else in the document is read (c1: whitelist, never spread).
const RUN_FIELDS = ['runId', 'lastContactAt', 'phase', 'phaseAt', 'acceptingWork', 'runEndedAt', 'runMode'] as const;
type StatusDoc = Partial<Pick<Presence, 'runId' | 'lastContactAt' | 'phase' | 'phaseAt' | 'acceptingWork'>> & {
  runEndedAt?: number | null; runMode?: Run['mode'];
  agent?: { name: string; ownerProfileId: string; connectionEpoch?: number; revokedAt: number | null;
    focus: { text: string; updatedAt: number } | null; personaText?: string; lastSendAt?: number | null };
  worker?: WorkerSummary;
};
function whitelist(data: Record<string, unknown>): StatusDoc {
  const doc: Record<string, unknown> = {};
  for (const key of RUN_FIELDS) if (data[key] !== undefined) doc[key] = data[key];
  const select = (value: unknown, keys: string[]) => Object.fromEntries(keys.flatMap(key =>
    value && typeof value === 'object' && (value as Record<string, unknown>)[key] !== undefined
      ? [[key, (value as Record<string, unknown>)[key]]] : []));
  if (data.agent) doc.agent = select(data.agent, ['name', 'ownerProfileId', 'connectionEpoch', 'revokedAt', 'focus', 'personaText', 'lastSendAt']);
  if (data.worker) doc.worker = select(data.worker, ['runId', 'phase', 'lastContactAt', 'deadlineAt', 'projectPauseRevision']);
  return doc as StatusDoc;
}
// One shared agent/run coverage rule. Only explicit null/null proves never-run; group-only legacy records
// are unobserved inputs; no historical source reconstruction occurs.
const complete = statusRunComplete;
const toRev = (time: Timestamp) => rev(time.seconds, time.nanoseconds);

type Entry = { projection: ReturnType<typeof createProjection<StatusDoc>>;
  readers: number; linger?: ReturnType<typeof setTimeout>; failed?: unknown;
  // Process clock of the last successful proof; never compared with commit times.
  deliveredAt: number;
  // The live status documents (for re-deriving held rows without a read) and how many complete ones each owner has.
  docs: Map<string, { rev: Rev; data: StatusDoc }>;
  overflow?: boolean; bytes: number; rowBytes: Map<string, number>;
  progress?: ProgressFence; refreshing?: Promise<boolean> };
const entries = new Map<string, Entry>();
let currentBytes = 0;
// maxProjects: a test override only (c11's scaled-cap fixture); production keeps CURRENT_STATE_MAX_PROJECTS.
const defaults = { stallMs: CURRENT_STATE_STALL_MS, lingerMs: CURRENT_STATE_LINGER_MS, clock: () => Date.now(), pageSize: 500,
  maxProjects: CURRENT_STATE_MAX_PROJECTS, ownedBytes: CURRENT_STATE_OWNED_BYTES, currentBytes: CURRENT_STATE_CURRENT_BYTES,
  refresh: readCurrentStateRefresh,
  afterDepsRead: async (): Promise<void> => {} };
let liveness = { ...defaults };
// Cache and canonical-input work are counted separately from SDK reads and writer transaction attempts.
const counts = { reattaches: 0, reattachServed: 0, reattachOneShot: 0, oneShots: 0, oneShotDocs: 0, oneShotShared: 0,
  depsReads: 0, rederived: 0, invalidated: 0, sourceRows: 0,
  ownedStarted: 0, ownedPages: 0, ownedEvictions: 0, ownedMiss: 0, ownedBypass: 0, ownedPeakBytes: 0,
  coldSeeds: 0, ignoredSnapshots: 0, currentEvictions: 0, currentBypass: 0, currentOversized: 0,
  currentPeakBytes: 0, currentObservedPeakBytes: 0, cachePeak: 0, attaches: 0, listenerSnapshots: 0, listenerDocs: 0,
  listenerSeedDocs: 0, listenerErrors: 0, oneShotAttempts: 0, oneShotErrors: 0,
  progressQuiet: 0, progressSeeds: 0, progressDeltas: 0, progressRaces: 0, progressRecoveries: 0 };
/** Tests: deterministic clocks, budgets, transactional refresh/dependency race injection. */
export function configureCurrentState(overrides: Partial<typeof defaults>) {
  liveness = { ...liveness, ...overrides };
  return () => { liveness = { ...defaults }; };
}

function detach(projectId: string, entry: Entry) {
  if (entries.get(projectId) !== entry) return;
  entries.delete(projectId);
  if (entry.overflow) currentBytes -= entry.bytes;
  clearTimeout(entry.linger);
}
// LRU among overflow projects only; active readers cannot be displaced.
function makeRoom(bytes: number, except?: Entry) {
  while (currentBytes + bytes > liveness.currentBytes) {
    const victim = [...entries].find(([, e]) => e.overflow && e !== except && e.readers === 0);
    if (!victim) return false;
    detach(...victim); counts.currentEvictions++;
  }
  return true;
}
function accountCurrent(entry: Entry, before: number) {
  if (!entry.overflow || ![...entries.values()].includes(entry)) return;
  currentBytes += entry.bytes - before;
  counts.currentObservedPeakBytes = Math.max(counts.currentObservedPeakBytes, currentBytes);
  if (entry.bytes > liveness.currentBytes || !makeRoom(0, entry)) {
    // An oversized callback is transient work, never retained authority. Its active reader can still finish;
    // the next request uses a counted fresh continuation at the original cursor floor.
    const found = [...entries].find(([, e]) => e === entry)!;
    detach(...found); counts.currentOversized++;
  }
  counts.currentPeakBytes = Math.max(counts.currentPeakBytes, currentBytes);
}
function attach(projectId: string): Entry | null {
  const known = entries.get(projectId);
  if (known && !known.failed) {
    if (known.overflow && [...entries.values()].filter(e => !e.overflow).length < liveness.maxProjects) {
      currentBytes -= known.bytes; known.overflow = false; // use a free primary slot before overflow capacity
    }
    entries.delete(projectId); entries.set(projectId, known); return known;
  }
  if (known) detach(projectId, known);
  const overflow = [...entries.values()].filter(e => !e.overflow).length >= liveness.maxProjects;
  if (overflow && !makeRoom(WATCH_BYTES)) { counts.currentBypass++; return null; }
  const entry: Entry = { projection: createProjection<StatusDoc>({ pageSize: liveness.pageSize }),
    readers: 0, deliveredAt: liveness.clock(), docs: new Map(),
    overflow, bytes: WATCH_BYTES, rowBytes: new Map() };
  entries.set(projectId, entry);
  if (overflow) currentBytes += entry.bytes;
  counts.attaches++; counts.cachePeak = Math.max(counts.cachePeak, entries.size);
  counts.currentPeakBytes = Math.max(counts.currentPeakBytes, currentBytes);
  return entry;
}
// One snapshot into an entry's projection and live documents (throws when the core refuses it).
function applySnapshot(entry: Entry, snapshot: QuerySnapshot, full = false) {
  const readTime = toRev(snapshot.readTime), before = entry.projection.watermark;
  if (before !== null && readTime < before) return false;
  const present = full ? new Set(snapshot.docs.map(doc => doc.id)) : undefined;
  const removedIds = full ? new Set(snapshot.docChanges().filter(c => c.type === 'removed').map(c => c.doc.id)) : undefined;
  const changes: Change<StatusDoc>[] = full ? [
    ...snapshot.docChanges().filter(c => c.type === 'removed').map(c => ({ type: 'removed' as const, id: c.doc.id,
      ...(c.doc.updateTime ? { updateTime: toRev(c.doc.updateTime) } : {}) })),
    ...snapshot.docs.map(doc => ({ type: 'added' as const, id: doc.id, updateTime: toRev(doc.updateTime), data: whitelist(doc.data()) })),
    ...[...entry.docs.keys()].filter(id => !present!.has(id) && !removedIds!.has(id))
      .map(id => ({ type: 'removed' as const, id })),
  ] : snapshot.docChanges().map(change => change.type === 'removed'
    ? { type: 'removed' as const, id: change.doc.id, ...(change.doc.updateTime ? { updateTime: toRev(change.doc.updateTime) } : {}) }
    : { type: change.type, id: change.doc.id, updateTime: toRev(change.doc.updateTime), data: whitelist(change.doc.data()) });
  entry.projection.apply(changes, readTime);
  const beforeBytes = entry.bytes;
  if (before === null || readTime >= before) for (const change of changes) {
    const known = entry.docs.get(change.id);
    if (change.type !== 'removed' && known && known.rev > change.updateTime) continue;
    if (change.type === 'removed' && change.updateTime && known && known.rev > change.updateTime) continue;
    if (change.type === 'removed') entry.docs.delete(change.id);
    else entry.docs.set(change.id, { rev: change.updateTime, data: change.data });
    const bytes = change.type === 'removed' ? 256 + 2 * change.id.length
      : 768 + 2 * (change.id.length + JSON.stringify(change.data).length);
    entry.bytes += bytes - (entry.rowBytes.get(change.id) ?? 0);
    entry.rowBytes.set(change.id, bytes); // deleted ids still occupy core tombstone/index storage
  }
  accountCurrent(entry, beforeBytes);
  return true;
}
// Budget refusal, cold recovery and owned-page misses read the same canonical input. Never share a
// pre-request transaction with a later request: that would break acknowledged-write -> immediate-read freshness.
async function oneShot(_projectId: string): Promise<Entry> {
  const entry: Entry = { projection: createProjection<StatusDoc>({ pageSize: liveness.pageSize }), readers: 0, deliveredAt: liveness.clock(), docs: new Map(), bytes: WATCH_BYTES, rowBytes: new Map() };
  counts.oneShotAttempts++;
  try { await refreshProgress(entry); } catch (error) { counts.oneShotErrors++; throw error; }
  counts.oneShots++; counts.oneShotDocs += entry.docs.size;
  return entry;
}

// Every request first obtains its own strong fence. Work may be shared only after that fence, so a read following
// an acknowledged write cannot join an older in-flight proof and silently miss it. No timer grants currentness.
async function refreshProgress(entry: Entry): Promise<boolean> {
  // Waiters perform their OWN transaction after the prior refresh. A later request must never join a proof
  // started before its acknowledged write. SDK retries rerun the entire read-only snapshot and are metered.
  while (entry.refreshing) await entry.refreshing;
  const work = (async () => {
    const result = await liveness.refresh(entry.progress);
    if (!result.fence.active) throw new Error('Canonical current-state progress is malformed.');
    if (entry.failed) return false;
    if (result.snapshot) {
      applySnapshot(entry, result.snapshot, result.full);
      if (result.full) counts.progressSeeds++; else counts.progressDeltas++;
    } else counts.progressQuiet++;
    entry.projection.apply([], toRev(result.fence.readTime));
    entry.progress = result.fence; entry.deliveredAt = liveness.clock();
    return true;
  })();
  entry.refreshing = work;
  try { return await work; } finally { if (entry.refreshing === work) entry.refreshing = undefined; }
}

// An ownership token names one process epoch and one viewer's independent cursor progression. Only immutable
// one-shot inputs are retained; no derived rows, authority/dependencies or private Needs you are cached here.
// Four viewers sharing one in-flight query reference one snapshot, charged once plus bounded per-chain metadata.
type Owned = { projectId: string; viewer: string; source: Entry; cursor: string; busy: boolean };
const owned = new Map<string, Owned>();
const ownedSources = new Map<Entry, { bytes: number; references: number }>();
const sourceSizes = new WeakMap<Entry, number>();
const ownershipEpoch = randomBytes(8).toString('hex');
let ownershipSequence = 0, ownedBytes = 0;
const CHAIN_BYTES = 1024;
function dropOwned(token: string, eviction = false) {
  const chain = owned.get(token);
  if (!chain) return;
  owned.delete(token); ownedBytes -= CHAIN_BYTES;
  const charge = ownedSources.get(chain.source)!;
  if (--charge.references === 0) { ownedSources.delete(chain.source); ownedBytes -= charge.bytes; }
  if (eviction) counts.ownedEvictions++;
}
function retainOwned(projectId: string, viewer: string, source: Entry): string | undefined {
  let bytes = sourceSizes.get(source);
  if (bytes === undefined) {
    // UTF-16 payload plus conservative per-row map/projection/index overhead. Measured RSS remains a separate gate.
    bytes = 512;
    for (const [id, doc] of source.docs) bytes += 512 + 2 * (id.length + JSON.stringify(doc).length);
    sourceSizes.set(source, bytes);
  }
  if (bytes + CHAIN_BYTES > liveness.ownedBytes) { counts.ownedBypass++; return undefined; }
  for (const [token, chain] of owned) {
    if (!chain.busy && liveness.clock() - chain.source.deliveredAt >= liveness.stallMs) dropOwned(token, true);
  }
  // Evict oldest idle chains, never an answer currently deriving. A missing chain resumes with a counted fresh read.
  while (ownedBytes + CHAIN_BYTES + (ownedSources.has(source) ? 0 : bytes) > liveness.ownedBytes) {
    const victim = [...owned].find(([, chain]) => !chain.busy);
    if (!victim) { counts.ownedBypass++; return undefined; }
    dropOwned(victim[0], true);
  }
  const token = ownershipEpoch + (++ownershipSequence).toString(16).padStart(16, '0');
  const charge = ownedSources.get(source);
  if (charge) charge.references++;
  else { ownedSources.set(source, { bytes, references: 1 }); ownedBytes += bytes; }
  ownedBytes += CHAIN_BYTES;
  owned.set(token, { projectId, viewer, source, cursor: '', busy: false });
  counts.ownedStarted++; counts.ownedPeakBytes = Math.max(counts.ownedPeakBytes, ownedBytes);
  return token;
}
function claimOwned(token: string, projectId: string, viewer: string, cursor: unknown) {
  const chain = owned.get(token);
  if (!chain || chain.projectId !== projectId || chain.viewer !== viewer || chain.cursor !== cursor || chain.busy
    || liveness.clock() - chain.source.deliveredAt >= liveness.stallMs) {
    // A wrong viewer or replay must not invalidate another viewer's live chain.
    if (chain && !chain.busy && chain.projectId === projectId && chain.viewer === viewer
      && liveness.clock() - chain.source.deliveredAt >= liveness.stallMs) dropOwned(token, true);
    // Owner decision, 27 Oct 2026 (Needs you 2d0b2753): the suffix is only an optimization. A retry, eviction or
    // another process must still progress from the original floor through the same new-path fresh read. Returning
    // 400 here would restart the snapshot and can livelock under random routing. Malformed cursors still get 400.
    counts.ownedMiss++;
    return undefined;
  }
  owned.delete(token); owned.set(token, chain);  // least-recently-used order
  chain.busy = true; counts.ownedPages++;
  return chain;
}
function release(projectId: string, entry: Entry) {
  if (--entry.readers > 0 || entry.failed || entries.get(projectId) !== entry) return;
  linger(projectId, entry);
}
// An idle entry expires after the linger, releasing its retained budget.
function linger(projectId: string, entry: Entry) {
  clearTimeout(entry.linger);
  entry.linger = setTimeout(() => {
    if (entry.readers > 0 || entries.get(projectId) !== entry) return;
    detach(projectId, entry);
  }, liveness.lingerMs);
  entry.linger.unref?.();
}
/** Cache occupancy and logical work; this implementation opens zero status listeners. */
export const currentStateStats = () => ({ listeners: 0, cachedProjects: entries.size, ownedChains: owned.size, ownedSnapshots: ownedSources.size,
  primaryProjects: [...entries.values()].filter(e => !e.overflow).length,
  overflowProjects: [...entries.values()].filter(e => e.overflow).length, currentBytes,
  ownedBytes, ...counts, ...progressReadStats });
/** Releases projections and owned paging inputs (tests, shutdown). */
export function stopCurrentState() {
  for (const [id, entry] of entries) detach(id, entry);
  currentBytes = 0;
  resetProgressReadStats();
  owned.clear(); ownedSources.clear(); ownedBytes = 0;
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
}

export type CurrentStateRow = (CommunicationAgent & { rev: Rev; evaluatedAt: number }) | { id: string; rev: Rev; removed: true };
export type CurrentStateAnswer = { rows: CurrentStateRow[]; cursor: string; more: boolean; notReady: boolean; complete: boolean;
  pause: { revision: number; requestedAt: number } | null; watermark: Rev | null; watermarkAgeMs: number | null;
  needsYou: string[]; needsYouComplete: boolean; serverTime: number };

const NEEDS_YOU_LIMIT = 200;

// What a complete row's derivation reads besides its own document (C7): the project pause, the owners' access and the
// project's open web starts. Read on every answer that derives rows, in one read-only transaction, with the authority's
// own code (c1, c14: revocation never rests on a cache's currentness). "Queued" comes from the open starts, not from the
// status document's start group, until that group is trusted (contract C3 7cddc86d, gate (a)/(b) of 0f8979cb): an agent
// is queued while a pending or accepted start names it and was requested by its owner, today's rule. `hash` is the same
// on every process for the same inputs, so a cursor from any process says what its held rows were derived from.
type Deps = { pause?: { revision: number; requestedAt: number }; operators: Awaited<ReturnType<typeof activeRecipientOperators>>;
  open: Set<string>; hash: string; owners: Set<string> };
const openStart = (agentId: string, profileId: string) => `${agentId}/${profileId}`;
async function readDeps(projectId: string, owners: string[]): Promise<Deps> {
  counts.depsReads++;
  const [operators, project, starts] = await db.runTransaction(async tx => [await activeRecipientOperators(tx, owners),
    await tx.get(projects.doc(projectId)),
    // Every open start, however many (a project normally has a few, at most 8 per computer): none is dropped (card v19).
    await tx.get(webAgentStarts.where('projectId', '==', projectId).where('state', 'in', ['pending', 'accepted']))] as const,
    { readOnly: true });
  const open = new Set(starts.docs.flatMap(doc => doc.get('agentId') ? [openStart(doc.get('agentId'), doc.get('profileId'))] : []));
  await liveness.afterDepsRead();
  const execution = project.data()?.execution;
  const pause = execution?.paused && execution.completedAt === null && execution.pauseRequest
    ? { revision: execution.pauseRequest.revision, requestedAt: execution.pauseRequest.requestedAt } : undefined;
  const key = JSON.stringify({ pause: pause ?? null, operators: [...operators].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, o]) => [id, o.epoch]),
    open: [...open].sort() });
  return { pause, operators, open, hash: createHash('sha256').update(key).digest('base64url').slice(0, 16), owners: new Set(owners) };
}

// The endpoint's cursor wraps the core's (c2): `project:core:D:E:D1:T1` (contract v2.3).
// - project: a tag of the project it was issued for. The core's cursor carries commit times and ids only, so a cursor from
//   another project could skip this project's older rows and complete falsely (codex-3); one that names another project
//   is refused like any cursor this read did not return, and the client starts a fresh first read.
// - D and E: the dependencies' hash and the evaluation time of the client's last complete answer. Every row it holds
//   is as derived from D at E.
// - D1 and T1: the same for the first page of the answer in progress. Every page of an answer is derived at T1, so a
//   process whose clock is below T1 never serves it (notReady), and no cursor is ever below an evaluatedAt the client
//   holds (c7, c5). A dependency change between pages marks D1 as moved.
// A complete answer advances all four to its own D and now.
// An optional final ownership token binds an incomplete one-shot chain to this process epoch and its exact emitted
// cursor. Eviction, expiry, replay or another process causes a counted fresh-read continuation from the same floor.
// Legacy/listener cursors retain that behavior too; completed cursors have no token. Only malformed cursors get 400.
const CURSOR = /^([A-Za-z0-9_-]{12}):([0-9A-Za-z_.~-]{1,260}):([A-Za-z0-9_-]{16}):(\d{1,16}):([A-Za-z0-9_-]{16}):(\d{1,16})(?::([0-9a-f]{32}))?$/;
const projectTag = (projectId: string) => createHash('sha256').update(projectId).digest('base64url').slice(0, 12);
const MOVED = '-'.repeat(16);
type Pin = { deps: string; at: number };
function parseCursor(value: unknown, projectId: string) {
  if (value === undefined) return undefined;
  const m = typeof value === 'string' ? CURSOR.exec(value) : null;
  if (!m || m[1] !== projectTag(projectId)) return null;
  return { core: m[2]!, held: { deps: m[3]!, at: Number(m[4]) }, first: { deps: m[5]!, at: Number(m[6]) }, owned: m[7] };
}
const coreComplete = (core: string) => core.endsWith('.~');
// The base B of a core delta page `B.P.id` (its rows were committed after B); null for a first read's `s.P.id`.
const coreBase = (core: string): Rev | null => core.startsWith('s.') ? null : core.split('.').slice(0, 2).join('.');
const encodeCursor = (projectId: string, core: string, held: Pin, first: Pin) =>
  `${projectTag(projectId)}:${core}:${held.deps}:${Math.floor(held.at)}:${first.deps}:${Math.floor(first.at)}`;

/** One answer for one viewer: a snapshot (no cursor) or the changes since `cursor`, plus the viewer's own Needs you. */
export async function readCurrentState(viewer: string, ownerRole: boolean, cursor: unknown, now: number): Promise<CurrentStateAnswer> {
  const projectId = currentProjectId();
  const parsed = parseCursor(cursor, projectId);
  if (parsed === null) throw new Refusal('bad_input', 'Use a cursor this status read returned.');
  const needs = viewerNeedsYou(viewer, ownerRole);
  needs.catch(() => {});  // awaited on every path below; this only keeps an early refusal from leaving it unhandled (c1)
  const empty = async (fields: Pick<CurrentStateAnswer, 'more' | 'notReady'>) => {
    const own = await needs;
    return { rows: [], cursor: typeof cursor === 'string' ? cursor : '', ...fields, complete: false, pause: null, watermark: null,
      watermarkAgeMs: null, needsYou: own.ids, needsYouComplete: own.complete, serverTime: now };
  };
  // A process whose clock is behind the cursor's evaluation time would derive rows the client has already seen move on:
  // "not yet", with the same cursor, never clamped (contract v2.3, c7).
  if (parsed && now < Math.max(parsed.held.at, parsed.first.at)) return empty({ more: !coreComplete(parsed.core), notReady: true });
  // Retained canonical projection, or an immutable canonical seed when the memory budget refuses retention.
  let token = parsed?.owned;
  const chain = token ? claimOwned(token, projectId, viewer, cursor) : undefined;
  if (!chain) token = undefined;
  let entry = chain ? null : attach(projectId), source: Entry | undefined = chain?.source ?? entry ?? undefined;
  if (entry) { entry.readers++; clearTimeout(entry.linger); }
  try {
    if (chain) {
      const readiness = await db.runTransaction(tx => {
        progressReadStats.readinessReads++;
        return requireCurrentStateCutover(tx);
      }, { readOnly: true });
      if (source!.progress?.readiness !== readiness) {
        if (token) dropOwned(token);
        token = undefined;
        source = await oneShot(projectId);
      }
    }
    if (entry) {
      try {
        if (!await refreshProgress(entry)) source = await oneShot(projectId);
      } catch (error) {
        entry.failed = error; detach(projectId, entry);
        throw error;
      }
    }
    source ??= await oneShot(projectId);
    let answer: Answer<StatusDoc>;
    try { answer = source.projection.read(parsed?.core); } catch (error) {
      if (error instanceof RangeError) throw new Refusal('bad_input', 'Use a cursor this status read returned.');
      // A broken retained projection is detached; answer from a fresh canonical one-shot.
      // A one-shot projection the core refuses is an error answer.
      if (source !== entry || !entry) throw error;
      counts.invalidated++;
      entry.failed = error; detach(projectId, entry);
      source = await oneShot(projectId);
      answer = source.projection.read(parsed?.core);
    }
    if (answer.notReady) return await empty({ more: answer.more, notReady: true });
    // Dependencies are never older than the documents they are applied to (contract C7; codex-1's races, c2's read-point
    // rule): the documents this answer derives are fixed now, with no await since the core read, and the one dependency
    // read (access, pause, open web starts) starts after, so its read time is at or after their watermark. A document or a
    // start committed later reaches the next answer; this one never mixes an older dependency read with a newer document.
    // The owners are those of every live document at that instant (not only this page's), so D is the same on every page.
    const snapshot = [...source.docs];
    const watermark = source.projection.watermark, deliveredAt = source.deliveredAt;
    const completing = !answer.more && parsed !== undefined;
    const docs = completing ? snapshot : [];
    const owners = new Set([...answer.rows, ...snapshot.map(([id, doc]) => ({ id, ...doc }))]
      .flatMap(row => 'data' in row && row.data.agent?.ownerProfileId ? [row.data.agent.ownerProfileId] : []));
    const deps = await readDeps(projectId, [...owners]);
    // The answer in progress: its first page fixes D1 and T1, which later pages carry. Every page but the last is
    // derived at T1; the last at now, since completing brings every row up to now.
    const mid = parsed !== undefined && !coreComplete(parsed.core);
    const first: Pin = mid ? { deps: parsed.first.deps === deps.hash ? parsed.first.deps : MOVED, at: parsed.first.at } : { deps: deps.hash, at: now };
    const held: Pin = parsed && !(mid && coreBase(parsed.core) === null) ? parsed.held : first;
    const rows = await deriveRows(answer.rows, deps, viewer, answer.more ? first.at : now);
    // Complete: the rows the client already held (every live document not in this page) are brought up to now. A row
    // derived from other dependencies (a pause, an access change) or one whose derivation changed with the clock alone
    // (Offline, Completed, pause_unconfirmed; c1, codex-1, c10) is re-sent with its source rev and a newer evaluatedAt.
    if (!answer.more && parsed) {
      const ours = mid ? coreBase(parsed.core) : undefined;  // rows of this answer's earlier pages: rev > B, or all for a first read
      rows.push(...await heldRows(docs, deps, new Set(answer.rows.map(row => row.id)), { held, first, ours }, viewer, now));
    }
    const own = await needs;
    let cursorOut = answer.more ? encodeCursor(projectId, answer.cursor, held, first) : encodeCursor(projectId, answer.cursor, { deps: deps.hash, at: now }, { deps: deps.hash, at: now });
    if (answer.more && (source !== entry || entries.get(projectId) !== entry)) {
      token ??= retainOwned(projectId, viewer, source);
      if (token) { cursorOut += `:${token}`; owned.get(token)!.cursor = cursorOut; }
    } else if (token) { dropOwned(token); token = undefined; }
    return { rows, cursor: cursorOut, more: answer.more, notReady: false,
      complete: !answer.more, pause: deps.pause ?? null, watermark,
      watermarkAgeMs: Math.max(0, liveness.clock() - deliveredAt), needsYou: own.ids, needsYouComplete: own.complete, serverTime: now };
  } catch (error) {
    if (token) dropOwned(token);
    throw error;
  } finally {
    if (chain) chain.busy = false;
    if (entry) release(projectId, entry);
  }
}

// A complete document's derivation sources, from the document and the answer's dependencies alone: the one status-document
// mapping (agent-status-doc.ts), with access, queued and pause from this answer's dependency read.
function docSources(id: string, d: StatusDoc, deps: Deps): AgentStateSources {
  return sourcesFromStatusDoc(id, d as AgentStatusDoc, { allowed: agent => connectionAllowed(agent as Agent, deps.operators),
    queued: deps.open.has(openStart(id, d.agent!.ownerProfileId)), ...(deps.pause ? { pause: deps.pause } : {}) })!;
}
const same = (a: DerivedAgentState, b: DerivedAgentState) => JSON.stringify(a) === JSON.stringify(b);
// Held rows to re-send. No boundary constants (contract v2.3): the derivation itself decides, by comparing its answer at
// the time a row was evaluated with its answer now. A row the client holds from its last complete answer equals derive(E);
// one sent on an earlier page of this answer equals derive(T1) (c7's quiet-client case: a contact inside (E, T1) is
// Working at T1 but Offline at both E and now). It is stale exactly when that differs from derive(now). Incomplete
// documents depend on sources this process does not listen to, so they are read again on every complete answer, as
// today's map reads them (the activation fence, until the CS2a writers).
async function heldRows(docs: [string, { rev: Rev; data: StatusDoc }][], deps: Deps, sent: Set<string>,
  pins: { held: Pin; first: Pin; ours: Rev | null | undefined }, viewer: string, now: number) {
  const due: { id: string; rev: Rev; data: StatusDoc }[] = [];
  for (const [id, doc] of docs) {
    if (sent.has(id)) continue;
    const ours = pins.ours === null || (pins.ours !== undefined && doc.rev > pins.ours);
    const from = ours ? pins.first : pins.held;
    if (!complete(doc.data) || from.deps !== deps.hash) { due.push({ id, ...doc }); continue; }
    const s = docSources(id, doc.data, deps);
    if (!same(deriveAgentState(s, from.at), deriveAgentState(s, now))) due.push({ id, ...doc });
  }
  counts.rederived += due.length;
  return due.length ? deriveRows(due, deps, viewer, now) : [];
}

// Rows derived at `now` (an answer's evaluation time), each carrying it as evaluatedAt.
async function deriveRows(rows: Answer<StatusDoc>['rows'], deps: Deps, viewer: string, now: number): Promise<CurrentStateRow[]> {
  const out: CurrentStateRow[] = [];
  for (const row of rows) {
    if (!('data' in row)) { out.push(row); continue; }
    const sources = complete(row.data) ? docSources(row.id, row.data, deps) : undefined;
    if (!sources) { out.push({ id: row.id, rev: row.rev, removed: true }); continue; }
    const { state, projectPause, reportedAt, lastContactAt, freshUntil } = deriveAgentState(sources, now);
    out.push({ id: row.id, rev: row.rev, evaluatedAt: now, name: sources.agent.name, mine: sources.agent.ownerProfileId === viewer, state,
      ...(projectPause ? { projectPause } : {}), personaChoice: personaChoice(sources.agent.persona?.text ?? ''),
      focus: sources.agent.focus ? { text: sources.agent.focus.text, updatedAt: sources.agent.focus.updatedAt } : null,
      reportedAt, lastContactAt, freshUntil });
  }
  return out;
}

// C7: the viewer's own open requests, read in ascending order from humanRequests,
// with today's askable rule (own agents, or any agent for the project owner). Never part of shared state.
async function viewerNeedsYou(viewer: string, owner: boolean) {
  const rows = await humanRequests.where('projectId', '==', currentProjectId()).where('assigneeProfileId', '==', viewer)
    .where('visibility', 'in', ['private', 'project']).where('status', '==', 'open').orderBy('createdAt')
    .select('agentId').limit(NEEDS_YOU_LIMIT).get();
  let ids = [...new Set(rows.docs.map(row => row.get('agentId') as string).filter(Boolean))];
  if (!owner && ids.length) {
    const docs = await db.getAll(...ids.map(id => agents().doc(id)), { fieldMask: ['ownerProfileId'] });
    const mine = new Set(docs.filter(doc => doc.exists && doc.get('ownerProfileId') === viewer).map(doc => doc.id));
    ids = ids.filter(id => mine.has(id));
  }
  return { ids, complete: rows.size < NEEDS_YOU_LIMIT };
}
