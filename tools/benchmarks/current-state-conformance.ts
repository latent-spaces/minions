// Model-free conformance harness for the current-state contract (card v10; task_a1a5d71a). PROVISIONAL interface,
// to be aligned with c2's frozen contract. A shared durable store stands in for Firestore: every committed change gets
// a per-project monotonic sequence. Adapters serve viewers from any replica (random routing, no affinity), and the
// harness checks each viewer's materialized view against the store after every step. Broken adapters model the
// failure classes the real design must avoid; the tests require the harness to catch each one.

// privateTo: a private Needs-you item visible only to that viewer (its person); others must never receive it.
export type Row = { agentId: string; phase: string; revision: number; freshUntil: number; privateTo?: string; removed?: true };
export type Viewer = { id: string; project: string };
export type Snapshot = { rows: Row[]; cursor: number };
export type Delta = { changes: Row[]; cursor: number } | { resync: true };
export type Forbidden = 'forbidden';

export class Store {
  private log = new Map<string, { seq: number; row: Row }[]>();
  private seq = new Map<string, number>();
  private compactedBefore = new Map<string, number>();
  private allowed = new Set<string>();
  rowReads = 0;
  // Called between a snapshot's row read and its cursor read, to model a concurrent commit.
  onBetweenReads?: () => void;
  grant(viewer: Viewer) { this.allowed.add(`${viewer.project}/${viewer.id}`); }
  revoke(viewer: Viewer) { this.allowed.delete(`${viewer.project}/${viewer.id}`); }
  canSee(viewer: Viewer) { return this.allowed.has(`${viewer.project}/${viewer.id}`); }
  head(project: string) { return this.seq.get(project) ?? 0; }
  commit(project: string, row: Row) {
    const seq = this.head(project) + 1;
    this.seq.set(project, seq);
    (this.log.get(project) ?? this.log.set(project, []).get(project)!).push({ seq, row: { ...row } });
    return seq;
  }
  // Rows as of `upTo` (inclusive), latest revision per agent.
  current(project: string, upTo = this.head(project)) {
    const rows = new Map<string, Row>();
    for (const entry of this.log.get(project) ?? []) if (entry.seq <= upTo) rows.set(entry.row.agentId, entry.row);
    return rows;
  }
  readCurrent(project: string, upTo?: number) { const rows = this.current(project, upTo); this.rowReads += rows.size; return rows; }
  since(project: string, cursor: number) {
    if (cursor < (this.compactedBefore.get(project) ?? 0)) return null;
    const entries = (this.log.get(project) ?? []).filter(entry => entry.seq > cursor);
    this.rowReads += entries.length;
    return entries;
  }
  compact(project: string, before: number) { this.compactedBefore.set(project, before); }
}

export interface Adapter {
  snapshot(replica: number, viewer: Viewer): Snapshot | Forbidden;
  changesSince(replica: number, viewer: Viewer, cursor: number): Delta | Forbidden;
}

// Reference: the cursor is the store sequence read atomically with the rows, so it is valid on every replica.
export function referenceAdapter(store: Store): Adapter {
  return {
    snapshot(_replica, viewer) {
      if (!store.canSee(viewer)) return 'forbidden';
      const cursor = store.head(viewer.project);
      store.onBetweenReads?.();
      return { rows: [...store.readCurrent(viewer.project, cursor).values()], cursor };
    },
    changesSince(_replica, viewer, cursor) {
      if (!store.canSee(viewer)) return 'forbidden';
      const entries = store.since(viewer.project, cursor);
      if (!entries) return { resync: true };
      return { changes: entries.map(entry => entry.row), cursor: entries.at(-1)?.seq ?? cursor };
    },
  };
}

// Broken: reads rows, then takes the cursor afterwards, so a commit in between is never delivered.
export function snapshotRaceAdapter(store: Store): Adapter {
  const ref = referenceAdapter(store);
  return { ...ref, snapshot(_replica, viewer) {
    if (!store.canSee(viewer)) return 'forbidden';
    const rows = [...store.readCurrent(viewer.project).values()];
    store.onBetweenReads?.();
    return { rows, cursor: store.head(viewer.project) };
  } };
}

// Broken: each replica remembers what it already sent in memory; a delta through another replica misses changes.
export function perReplicaMemoryAdapter(store: Store): Adapter {
  const sent = new Map<string, number>();
  return {
    snapshot(replica, viewer) {
      if (!store.canSee(viewer)) return 'forbidden';
      const cursor = store.head(viewer.project);
      sent.set(`${replica}/${viewer.id}`, cursor);
      return { rows: [...store.readCurrent(viewer.project, cursor).values()], cursor };
    },
    changesSince(replica, viewer) {
      if (!store.canSee(viewer)) return 'forbidden';
      const from = sent.get(`${replica}/${viewer.id}`) ?? store.head(viewer.project);
      const entries = store.since(viewer.project, from) ?? [];
      sent.set(`${replica}/${viewer.id}`, store.head(viewer.project));
      return { changes: entries.map(entry => entry.row), cursor: store.head(viewer.project) };
    },
  };
}

// Broken: a compacted cursor returns an empty delta instead of asking for a resync.
export function noResyncAdapter(store: Store): Adapter {
  const ref = referenceAdapter(store);
  return { ...ref, changesSince(replica, viewer, cursor) {
    const delta = ref.changesSince(replica, viewer, cursor);
    return delta !== 'forbidden' && 'resync' in delta ? { changes: [], cursor: store.head(viewer.project) } : delta;
  } };
}

// Broken: checks access only at snapshot time, not on each delta.
export function noAuthOnDeltaAdapter(store: Store): Adapter {
  const ref = referenceAdapter(store);
  return { ...ref, changesSince(_replica, viewer, cursor) {
    const entries = store.since(viewer.project, cursor) ?? [];
    return { changes: entries.map(entry => entry.row), cursor: entries.at(-1)?.seq ?? cursor };
  } };
}

// A viewer client: applies a snapshot, then deltas in order of row revision (never wall clock), and resyncs on request.
export class Client {
  rows = new Map<string, Row>();
  cursor: number | null = null;
  denied = false;
  resyncs = 0;
  constructor(readonly viewer: Viewer, private adapter: Adapter) {}
  // Highest revision seen per agent, including removals, so a stale replay cannot resurrect a removed agent.
  private seen = new Map<string, number>();
  private apply(rows: Row[]) {
    for (const row of rows) {
      if (row.revision <= (this.seen.get(row.agentId) ?? 0)) continue;
      this.seen.set(row.agentId, row.revision);
      if (row.removed) this.rows.delete(row.agentId); else this.rows.set(row.agentId, row);
    }
  }
  bootstrap(replica: number) {
    const snap = this.adapter.snapshot(replica, this.viewer);
    if (snap === 'forbidden') { this.denied = true; this.rows.clear(); this.cursor = null; return; }
    this.rows.clear(); this.seen.clear(); this.apply(snap.rows); this.cursor = snap.cursor;
  }
  poll(replica: number) {
    if (this.cursor === null) return this.bootstrap(replica);
    const delta = this.adapter.changesSince(replica, this.viewer, this.cursor);
    if (delta === 'forbidden') { this.denied = true; this.rows.clear(); this.cursor = null; return; }
    if ('resync' in delta) { this.resyncs++; return this.bootstrap(replica); }
    this.apply(delta.changes); this.cursor = delta.cursor;
  }
  // Liveness is derived from data the viewer already holds: no write is needed for an agent to show offline.
  status(agentId: string, now: number) {
    const row = this.rows.get(agentId);
    return !row ? 'unknown' : now >= row.freshUntil ? 'offline' : row.phase;
  }
}

// Same-content comparison between a client's view and the store's committed state.
export function matches(store: Store, client: Client) {
  const truth = new Map([...store.current(client.viewer.project)].filter(([, row]) => !row.removed));
  if (truth.size !== client.rows.size) return false;
  for (const [id, row] of truth) if (client.rows.get(id)?.revision !== row.revision) return false;
  return true;
}

// c2's contract C4 (70097df4): each replica serves from its own listener read point W, which may lag the store.
// A snapshot is taken at W with cursor W; since → changes in (since, W] with cursor max(since, W), so a lagging
// replica never rewinds a cursor and never claims changes it has not seen. `lag[replica]` is how many commits behind.
export function listenerReadPointAdapter(store: Store, lag: number[], jumpCursorToHead = false): Adapter {
  const readPoint = (replica: number, project: string) => Math.max(0, store.head(project) - (lag[replica] ?? 0));
  return {
    snapshot(replica, viewer) {
      if (!store.canSee(viewer)) return 'forbidden';
      const w = readPoint(replica, viewer.project);
      return { rows: [...store.readCurrent(viewer.project, w).values()], cursor: w };
    },
    changesSince(replica, viewer, cursor) {
      if (!store.canSee(viewer)) return 'forbidden';
      const w = readPoint(replica, viewer.project);
      const entries = store.since(viewer.project, cursor);
      if (!entries) return { resync: true };
      const seen = entries.filter(entry => entry.seq <= w);
      // Broken variant: reports the store head as the cursor although this replica has only seen up to W.
      return { changes: seen.map(entry => entry.row), cursor: jumpCursorToHead ? store.head(viewer.project) : Math.max(cursor, w) };
    },
  };
}

// Per-viewer visibility: the reference filters private rows on every snapshot and delta. A leaking variant does not.
export const visibleTo = (viewer: Viewer, rows: Row[]) => rows.filter(r => r.privateTo === undefined || r.privateTo === viewer.id);
export function privateFilteredAdapter(store: Store, leak = false): Adapter {
  const ref = referenceAdapter(store);
  return {
    snapshot(replica, viewer) { const s = ref.snapshot(replica, viewer); return s === 'forbidden' || leak ? s : { ...s, rows: visibleTo(viewer, s.rows) }; },
    changesSince(replica, viewer, cursor) {
      const d = ref.changesSince(replica, viewer, cursor);
      return d === 'forbidden' || 'resync' in d || leak ? d : { ...d, changes: visibleTo(viewer, d.changes) };
    },
  };
}

// c6's review of contract 70097df4, point 2: a process that is at its listener cap for a project falls back to a
// full current read for that project and flags it, instead of serving deltas it cannot track. Correctness must hold;
// the fallback's cost is the roster per request, so the flag lets the caller and measurements see it.
export function listenerCapAdapter(store: Store, cappedReplicas: Set<number>, serveStaleDelta = false): Adapter & { fallbacks: number } {
  const ref = referenceAdapter(store);
  const adapter = {
    fallbacks: 0,
    snapshot: ref.snapshot,
    changesSince(replica: number, viewer: Viewer, cursor: number): Delta | Forbidden {
      if (!cappedReplicas.has(replica)) return ref.changesSince(replica, viewer, cursor);
      if (!store.canSee(viewer)) return 'forbidden';
      // Broken variant: without a listener it has no read point, so it answers "nothing changed".
      if (serveStaleDelta) return { changes: [], cursor };
      adapter.fallbacks++;
      const head = store.head(viewer.project);
      return { changes: [...store.readCurrent(viewer.project, head).values()], cursor: head };
    },
  };
  return adapter;
}

// A replica started cold at head W0 keeps change history only after W0 (no durable tombstones from before it).
// Correct: a cursor older than W0 gets reset:true. Broken variant: serves only what it holds and advances the cursor,
// so a removal committed before W0 is never delivered and the removed agent stays visible.
export function coldReplicaAdapter(store: Store, startedAt: Map<number, number>, broken = false): Adapter {
  const ref = referenceAdapter(store);
  return { ...ref, changesSince(replica, viewer, cursor) {
    const w0 = startedAt.get(replica);
    if (w0 === undefined || cursor >= w0) return ref.changesSince(replica, viewer, cursor);
    if (!store.canSee(viewer)) return 'forbidden';
    if (!broken) return { resync: true };
    const held = (store.since(viewer.project, w0) ?? []);
    return { changes: held.map(entry => entry.row), cursor: store.head(viewer.project) };
  } };
}

// ---- Latest-state model (c1 review of 51d84407): the contract serves from per-document latest state with an
// updateTime, not a durable log. A replica holds a copy of the docs it has seen up to its read point W, and only
// docs as of its start W0 if it restarted. Cursor = (updateTime, docId), so equal commit times cannot drop a row.
export type Doc = { row: Row; updateTime: number };
export type Cursor = { t: number; id: string };
const after = (doc: Doc, c: Cursor) => doc.updateTime > c.t || (doc.updateTime === c.t && doc.row.agentId > c.id);

export class LatestStore {
  docs = new Map<string, Doc>();
  clock = 0;
  docReads = 0;
  // One batch shares one commit time (ties), as a Firestore batch does.
  commitBatch(rows: Row[], hardDelete: string[] = []) {
    const t = ++this.clock;
    for (const row of rows) this.docs.set(row.agentId, { row: { ...row }, updateTime: t });
    for (const id of hardDelete) this.docs.delete(id);
    return t;
  }
}

export class Replica {
  private view = new Map<string, Doc>();
  w = 0;
  constructor(private store: LatestStore, readonly w0 = 0) { this.catchUp(); }
  // A listener catching up to the store's current state (a lagging replica simply has not called this yet).
  catchUp() { this.view = new Map([...this.store.docs].map(([id, doc]) => [id, { ...doc }])); this.w = this.store.clock; }
  snapshot(): { rows: Row[]; cursor: Cursor } {
    this.store.docReads += this.view.size;
    return { rows: [...this.view.values()].map(d => d.row), cursor: { t: this.w, id: '￿' } };
  }
  // Docs after the cursor, ordered by (updateTime, docId), at most `limit`; cursor = last delivered, else max(since, W).
  since(c: Cursor, limit = Infinity, { hardDeletes = false, timeOnlyCursor = false } = {}): { changes: Row[]; cursor: Cursor } | { resync: true } {
    if (hardDeletes && c.t < this.w0) return { resync: true };
    const isAfter = timeOnlyCursor ? (d: Doc) => d.updateTime > c.t : (d: Doc) => after(d, c);
    const page = [...this.view.values()].filter(isAfter)
      .sort((a, b) => a.updateTime - b.updateTime || (a.row.agentId < b.row.agentId ? -1 : 1)).slice(0, limit);
    this.store.docReads += page.length;
    if (page.length === limit) { const last = page.at(-1)!; return { changes: page.map(d => d.row), cursor: { t: last.updateTime, id: last.row.agentId } }; }
    // Complete range: max of the cursor and (W, end) by the full tuple, so a mid-tie cursor at t = W still advances (codex-1).
    return { changes: page.map(d => d.row), cursor: c.t > this.w ? c : { t: this.w, id: '￿' } };
  }
}
