// Current-state acceptance harness (card v10/v11), model-free and deterministic. It checks a map/status design for
// correctness, freshness and work on the same seeded schedule. A design is accepted only if every viewer ends with the
// latest revision of every agent it may see, never sees a private Needs you meant for someone else, and receives
// nothing after it loses access. Its source-commit → client lag is then compared with today's sweep.
//
// The store separates a write's stamp (request time, like a server timestamp) from its commit time, when it becomes
// visible. Each agent's record revision rises by one per committed write, in commit order. Designs:
//   sweep      today's map: each viewer reads 60 agents per 3 s poll (one pass covers the roster).
//   stamp      changes since the highest stamp seen, minus an overlap (the T2 pattern). Negative control: a commit that
//              lags its stamp by more than the overlap is lost.
//   log        a sharded sequence log written in the source transaction: seq is assigned in commit order per shard,
//              each process syncs it at most every syncMs and shares it; viewers keep a per-shard cursor that any
//              process can serve. A cursor below what is retained gets an explicit resync.
//   log-prealloc  negative control: seq is allocated at request time, so a later seq can be visible first.
//   push       one listener per process over the projection (consistent snapshot, then every later commit, delivered
//              late, out of order or twice), fanned out to held viewer streams that recycle every 55 s.
//   push-naive negative control: the snapshot is read before the listener attaches, so commits in between are missed.
//   push-noreauth / push-leak  negative controls: streams survive access loss / Needs you is sent unfiltered.
// Times are simulated milliseconds. Reads and writes are model counts (one per document returned, one for an empty
// query), not billed figures, and nothing here exercises Firestore itself.

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Commit = { i: number; agent: number; rev: number; stampMs: number; commitMs: number; phase: number;
  deleted: boolean; needsYouFor: string | null };
export type Viewer = { id: number; person: string; joinMs: number; revokeMs: number | null };
export type Schedule = { agents: number; commits: Commit[]; viewers: Viewer[]; instances: number;
  restarts: { instance: number; atMs: number }[]; durationMs: number; endMs: number };
export type ScheduleOptions = { agents: number; writes: number; durationMs: number; viewers: number; instances: number;
  people: number; maxLagMs: number; longLagFraction: number; revokeFraction: number; deleteFraction: number;
  restarts: number; settleMs?: number };

export function generateSchedule(seed: number, o: ScheduleOptions): Schedule {
  const r = mulberry32(seed), int = (n: number) => Math.floor(r() * n);
  const draft = Array.from({ length: o.writes }, () => {
    const stampMs = int(o.durationMs);
    const lag = r() < o.longLagFraction ? int(o.maxLagMs) : 1 + int(30);
    return { agent: int(o.agents), stampMs, commitMs: stampMs + lag, phase: int(5), deleted: r() < o.deleteFraction,
      needsYouFor: r() < 0.3 ? `p${int(o.people)}` : null };
  }).sort((a, b) => a.commitMs - b.commitMs);
  // Writes to one agent commit one after another (its record is read and written in a transaction).
  const last = new Map<number, number>();
  for (const d of draft) { const prev = last.get(d.agent); if (prev !== undefined && d.commitMs <= prev) d.commitMs = prev + 1; last.set(d.agent, d.commitMs); }
  draft.sort((a, b) => a.commitMs - b.commitMs);
  // A deletion of an agent that is already deleted is not a change (a hard delete of a missing document).
  const revs = new Map<number, number>(), gone = new Set<number>();
  const commits = draft.map((d, i) => {
    if (d.deleted && gone.has(d.agent)) d.deleted = false;
    if (d.deleted) gone.add(d.agent); else gone.delete(d.agent);
    const rev = (revs.get(d.agent) ?? 0) + 1; revs.set(d.agent, rev); return { i, rev, ...d };
  });
  const viewers = Array.from({ length: o.viewers }, (_, id) => {
    const joinMs = int(o.durationMs / 2);
    return { id, person: `p${id % o.people}`, joinMs,
      revokeMs: r() < o.revokeFraction ? joinMs + 1 + int(o.durationMs - joinMs) : null };
  });
  const restarts = Array.from({ length: o.restarts }, () => ({ instance: int(o.instances), atMs: int(o.durationMs) }));
  const endMs = o.durationMs + o.maxLagMs + (o.settleMs ?? 40_000);
  return { agents: o.agents, commits, viewers, instances: o.instances, restarts, durationMs: o.durationMs, endMs };
}

// What a viewer may hold for one agent. A server must replace another person's Needs you with null.
export type Rec = { agent: number; rev: number; phase: number; deleted: boolean; needsYouFor: string | null };
const view = (c: Commit, person: string, leak = false): Rec =>
  ({ agent: c.agent, rev: c.rev, phase: c.phase, deleted: c.deleted, needsYouFor: leak || c.needsYouFor === person ? c.needsYouFor : null });

// The store: per agent its commits in revision order; a read at R sees the newest commit with commitMs <= R.
class Store {
  readonly byAgent: Commit[][];
  constructor(readonly s: Schedule) {
    this.byAgent = Array.from({ length: s.agents }, () => []);
    for (const c of s.commits) this.byAgent[c.agent].push(c);
  }
  at(agent: number, R: number): Commit | null {
    const list = this.byAgent[agent];
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].commitMs <= R) lo = mid + 1; else hi = mid; }
    return lo ? list[lo - 1] : null;
  }
}

class Heap {
  private a: { t: number; n: number; fn: () => void }[] = [];
  private n = 0;
  push(t: number, fn: () => void) {
    const a = this.a; a.push({ t, n: this.n++, fn });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (less(a[p], a[i])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], end = a.pop()!;
    if (a.length) {
      a[0] = end; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && less(a[l], a[m])) m = l; if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; }
    }
    return top;
  }
  get size() { return this.a.length; }
}
const less = (x: { t: number; n: number }, y: { t: number; n: number }) => x.t < y.t || (x.t === y.t && x.n < y.n);

// The pure current-state core under test (design 'core'): c2's createProjection and rev from
// apps/server/src/view/current-state-core.ts, injected so this harness does not depend on an unintegrated file.
type CoreAnswer = { rows: ({ id: string; rev: string; data: Commit } | { id: string; rev: string; removed: true })[];
  cursor: string; more: boolean; reset: boolean };
export type CoreModule = {
  createProjection: (o: { pageSize?: number; hardDeletes?: boolean }) => {
    apply(changes: ({ type: 'added' | 'modified'; id: string; updateTime: string; data: Commit } | { type: 'removed'; id: string })[], readTime: string): void;
    read(cursor?: unknown): CoreAnswer;
  };
  rev: (seconds: number, nanoseconds: number) => string;
};
export type DesignName = 'sweep' | 'stamp' | 'log' | 'log-prealloc' | 'push' | 'push-naive' | 'push-noreauth' | 'push-leak'
  | 'wm' | 'wm-ids' | 'wm-memtomb' | 'wm-paged' | 'wm-paged-filter' | 'wm-paged-anyreplica' | 'core';
export type DesignOptions = { pollMs: number; sweepBatch: number; overlapMs: number; shards: number; syncMs: number;
  retainMs: number; notifyMaxMs: number; duplicateFraction: number; recycleMs: number; accessCheckMs: number;
  attachGapMs: number; lingerMs: number; pageSize: number; pageGapMs: number; hardDeletes: boolean; core?: CoreModule };
export const DEFAULTS: DesignOptions = { pollMs: 3_000, sweepBatch: 60, overlapMs: 10_000, shards: 4, syncMs: 250,
  retainMs: 300_000, notifyMaxMs: 200, duplicateFraction: 0.05, recycleMs: 55_000, accessCheckMs: 1_000, attachGapMs: 300,
  // Contract C6 forbids hard deletes (removals are tombstones); set hardDeletes only to reproduce that mode.
  lingerMs: 30_000, pageSize: 50, pageGapMs: 100, hardDeletes: false };

export type Result = { design: DesignName; commits: number; checked: number; lost: number; finalMismatch: number; regressions: number;
  revocationLeaks: number; privacyLeaks: number; staleDeliveries: number; resyncs: number; requests: number; coldRequests: number; incompleteSnapshots: number; belowFloor: number; stuckAnswers: number;
  lagMs: { p50: number; p95: number; p99: number; max: number }; reads: number; writes: number;
  readsPerChange: number; writesPerChange: number; recordsSentPerViewer: number; heldStreams: number };

type Client = { recs: Map<number, Rec>; covered: Map<number, number>; connected: boolean };

export function simulate(s: Schedule, design: DesignName, opts: Partial<DesignOptions> = {}, seed = 1): Result {
  const o = { ...DEFAULTS, ...opts }, r = mulberry32(seed ^ 0x9e3779b9), store = new Store(s), heap = new Heap();
  let reads = 0, writes = 0, sent = 0, stale = 0, resyncs = 0, revocationLeaks = 0, privacyLeaks = 0, regressions = 0, requests = 0, coldRequests = 0, incompleteSnapshots = 0, belowFloor = 0, stuckAnswers = 0;
  // The highest revision each viewer has held per agent, kept apart from the client's own rule.
  const highest = s.viewers.map(() => new Map<number, number>());
  const lags: number[] = [];
  const clients: Client[] = s.viewers.map(() => ({ recs: new Map(), covered: new Map(), connected: true }));
  const has = (v: Viewer, t: number) => t >= v.joinMs && (v.revokeMs === null || t < v.revokeMs);

  // Deliver records to a viewer's client: apply higher revisions only and record when each commit became covered.
  function deliver(v: Viewer, recs: Rec[], t: number, resync = false) {
    const c = clients[v.id];
    if (resync) resyncs++;
    if (v.revokeMs !== null && t >= v.revokeMs + o.accessCheckMs + o.notifyMaxMs) { if (recs.length) revocationLeaks++; return; }
    for (const rec of recs) {
      sent++;
      if (rec.needsYouFor !== null && rec.needsYouFor !== v.person) privacyLeaks++;
      const held = c.recs.get(rec.agent);
      if (held && held.rev >= rec.rev) { if (held.rev > rec.rev) stale++; continue; }
      c.recs.set(rec.agent, rec);
      const top = highest[v.id].get(rec.agent) ?? 0;
      if (rec.rev < top) regressions++; else highest[v.id].set(rec.agent, rec.rev);
      cover(v, rec.agent, rec.rev, t);
    }
  }
  // Record when each commit up to rev became visible to the viewer.
  function cover(v: Viewer, agent: number, rev: number, t: number) {
    const c = clients[v.id], list = store.byAgent[agent];
    let k = c.covered.get(agent) ?? 0;
    while (k < list.length && list[k].rev <= rev) {
      const cm = list[k];
      if (cm.commitMs >= v.joinMs && has(v, cm.commitMs)) lags.push(t - cm.commitMs);
      k++;
    }
    c.covered.set(agent, k);
  }
  const refuse = (v: Viewer) => { clients[v.id].recs.clear(); highest[v.id].clear(); clients[v.id].connected = false; };
  const snapshot = (R: number, person: string, leak = false) => {
    const out: Rec[] = [];
    for (let a = 0; a < s.agents; a++) { const c = store.at(a, R); if (c) out.push(view(c, person, leak)); }
    return out;
  };

  const polling = design === 'sweep' || design === 'stamp' || design === 'log' || design === 'log-prealloc';
  const watermark = design.startsWith('wm');
  if (polling) {
    // Every viewer polls every pollMs from a random phase; each poll goes to a random process.
    const offset = new Map<number, number>(), stampCursor = new Map<number, number>();
    const logCursor = new Map<number, number[]>();
    const shardOf = (a: number) => a % o.shards;
    // Sequence log: seq per shard in commit order (log) or in stamp order (log-prealloc).
    const shardLog: Commit[][] = Array.from({ length: o.shards }, () => []), seqOf = new Map<number, number>();
    if (design === 'log' || design === 'log-prealloc') {
      const ordered = [...s.commits].sort(design === 'log' ? (a, b) => a.commitMs - b.commitMs || a.i - b.i : (a, b) => a.stampMs - b.stampMs || a.i - b.i);
      for (const c of ordered) { const list = shardLog[shardOf(c.agent)]; list.push(c); seqOf.set(c.i, list.length); }
      writes += 2 * s.commits.length;  // a log entry and the shard head per change (model)
    } else if (design === 'stamp') writes += s.commits.length;  // the projection document's stamp
    // Entries a reader at R sees with seq > cursor; a log entry is visible at its commit.
    const logSince = (shard: number, cursor: number, R: number) => {
      const out: Commit[] = []; const list = shardLog[shard];
      for (let k = Math.max(cursor, floor(shard, R)); k < list.length; k++) if (list[k].commitMs <= R) out.push(list[k]);
      return out;
    };
    // The highest seq visible at R in a shard ("head"). With prealloc a lower seq may still be invisible.
    const head = (shard: number, R: number) => { let h = 0; const list = shardLog[shard]; for (let k = 0; k < list.length; k++) if (list[k].commitMs <= R) h = k + 1; return h; };
    const floor = (shard: number, R: number) => { const list = shardLog[shard]; let k = 0; while (k < list.length && list[k].commitMs < R - o.retainMs) k++; return k; };
    // A process keeps the projection, its per-shard cursor, the cursor its last snapshot started from (base) and the
    // log entries it actually read (seen); it serves viewers only from what it read.
    type Proc = { at: number; map: Map<number, Commit>; cursor: number[]; base: number[]; seen: Set<number>; ok: boolean };
    const procs: Proc[] = Array.from({ length: s.instances }, () => ({ at: -Infinity, map: new Map(), cursor: [], base: [], seen: new Set(), ok: false }));
    for (const x of s.restarts) heap.push(x.atMs, () => { const p = procs[x.instance]; p.ok = false; p.map.clear(); p.seen.clear(); });
    const syncProc = (p: Proc, t: number, force = false) => {
      if (!p.ok || p.cursor.some((c, sh) => c < floor(sh, t))) {
        // Consistent snapshot of the projection and every shard head in one read (resync of the process).
        p.map.clear();
        for (let a = 0; a < s.agents; a++) { const c = store.at(a, t); if (c) p.map.set(a, c); }
        reads += s.agents + o.shards;
        p.cursor = Array.from({ length: o.shards }, (_, sh) => head(sh, t)); p.base = [...p.cursor]; p.seen.clear();
        p.ok = true; p.at = t; return;
      }
      if (!force && t - p.at < o.syncMs) return;
      for (let sh = 0; sh < o.shards; sh++) {
        const got = logSince(sh, p.cursor[sh], t); reads += Math.max(1, got.length);
        for (const c of got) { p.seen.add(c.i); const held = p.map.get(c.agent); if (!held || held.rev < c.rev) p.map.set(c.agent, c); }
        // A reader advances to the highest seq it saw; with prealloc an invisible lower seq is skipped for good.
        if (got.length) p.cursor[sh] = Math.max(p.cursor[sh], ...got.map(c => seqOf.get(c.i)!));
      }
      p.at = t;
    };
    for (const v of s.viewers) {
      const first = v.joinMs + Math.floor(r() * o.pollMs);
      const poll = (t: number) => {
        if (t > s.endMs) return;
        if (!has(v, t)) { if (v.revokeMs !== null && t >= v.revokeMs) { refuse(v); return; } heap.push(t + o.pollMs, () => poll(t + o.pollMs)); return; }
        if (design === 'sweep') {
          const off = offset.get(v.id) ?? 0, out: Rec[] = [];
          for (let k = 0; k < Math.min(o.sweepBatch, s.agents); k++) { const a = (off + k) % s.agents, c = store.at(a, t); if (c) out.push(view(c, v.person)); }
          reads += 1 + Math.min(o.sweepBatch, s.agents); offset.set(v.id, (off + o.sweepBatch) % s.agents);
          deliver(v, out, t);
        } else if (design === 'stamp') {
          const cur = stampCursor.get(v.id);
          if (cur === undefined) { const snap = snapshot(t, v.person); reads += s.agents; deliver(v, snap, t, true);
            stampCursor.set(v.id, Math.max(0, ...snap.map(x => store.byAgent[x.agent][x.rev - 1].stampMs))); }
          else {
            const out: Rec[] = []; let hi = cur;
            for (let a = 0; a < s.agents; a++) { const c = store.at(a, t); if (c && c.stampMs >= cur - o.overlapMs) { out.push(view(c, v.person)); hi = Math.max(hi, c.stampMs); } }
            reads += Math.max(1, out.length); stampCursor.set(v.id, hi); deliver(v, out, t);
          }
        } else {
          const p = procs[Math.floor(r() * s.instances)], vc = logCursor.get(v.id);
          syncProc(p, t, !!vc && vc.some((c, sh) => c > (p.cursor[sh] ?? -1)));
          // A cursor this process cannot serve from what it read (below its snapshot, or compacted) gets a resync.
          if (!vc || vc.some((c, sh) => c < p.base[sh] || c < floor(sh, t))) {
            deliver(v, [...p.map.values()].map(c => view(c, v.person)), t, true);
          } else {
            // Changes after the viewer's cursor, from the shared process copy (served from memory, no reads).
            const out: Rec[] = [];
            for (let sh = 0; sh < o.shards; sh++) for (let k = vc[sh]; k < p.cursor[sh]; k++) { const c = shardLog[sh][k]; if (p.seen.has(c.i)) out.push(view(c, v.person)); }
            deliver(v, out, t, false);
          }
          logCursor.set(v.id, p.cursor.map((c, sh) => Math.max(c, vc?.[sh] ?? 0)));
        }
        heap.push(t + o.pollMs, () => poll(t + o.pollMs));
      };
      heap.push(first, () => poll(first));
    }
  } else if (design === 'core') {
    // c2's actual CS2b core: one projection per process, fed by a lagging listener (newest commit per agent since the
    // last snapshot, readTime W) and read with the cursor the client holds. An answer with more:true is continued on a
    // random process after pageGapMs. Removals are hard deletes when hardDeletes is set. After a reset answer's last
    // page the client drops agents the answer did not list. After every complete answer the client must hold exactly
    // the store at that process's W (c2's point-in-time claim; counted in incompleteSnapshots).
    if (!o.core) throw new Error("Design 'core' needs opts.core (the module under test).");
    const core = o.core, id = (a: number) => `a${String(a).padStart(6, '0')}`;
    const at = (ms: number) => core.rev(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
    type Proc = { live: boolean; epoch: number; W: number; ptr: number; proj: ReturnType<CoreModule['createProjection']>; lastUse: number };
    const fresh = () => core.createProjection({ pageSize: o.pageSize, hardDeletes: o.hardDeletes });
    const procs: Proc[] = Array.from({ length: s.instances }, () => ({ live: false, epoch: 0, W: 0, ptr: 0, proj: fresh(), lastUse: 0 }));
    writes += s.commits.length;
    const detach = (p: Proc) => { p.live = false; p.epoch++; };
    const attach = (p: Proc, t: number) => {
      p.live = true; p.epoch++; p.W = t; p.proj = fresh();
      const first = [];
      for (let a = 0; a < s.agents; a++) { const c = store.at(a, t); if (c && !(o.hardDeletes && c.deleted)) first.push({ type: 'added' as const, id: id(a), updateTime: at(c.commitMs), data: c }); }
      p.proj.apply(first, at(t)); reads += Math.max(1, first.length);
      p.ptr = 0; while (p.ptr < s.commits.length && s.commits[p.ptr].commitMs <= t) p.ptr++;
      const epoch = p.epoch;
      const tick = (now: number) => {
        if (p.epoch !== epoch || now > s.endMs) return;
        if (now - p.lastUse > o.lingerMs) { detach(p); return; }
        const W = Math.max(p.W, now - Math.floor(r() * o.notifyMaxMs)), newest = new Map<number, Commit>();
        while (p.ptr < s.commits.length && s.commits[p.ptr].commitMs <= W) { const c = s.commits[p.ptr++]; newest.set(c.agent, c); }
        const changes = [...newest.values()].map(c => o.hardDeletes && c.deleted ? { type: 'removed' as const, id: id(c.agent) }
          : { type: 'modified' as const, id: id(c.agent), updateTime: at(c.commitMs), data: c });
        reads += changes.length; p.proj.apply(changes, at(W)); p.W = W;
        const next = now + 50 + Math.floor(r() * o.notifyMaxMs); heap.push(next, () => tick(next));
      };
      heap.push(t + 50, () => tick(t + 50));
    };
    for (const x of s.restarts) heap.push(x.atMs, () => detach(procs[x.instance]));
    const cursors = new Map<number, string>();
    const maxPages = 20 + 40 * Math.ceil(s.agents / o.pageSize);
    for (const v of s.viewers) {
      let listed: Set<number> | null = null, pages = 0;
      const ask = (t: number) => {
        if (t > s.endMs) return;
        if (!has(v, t)) { if (v.revokeMs !== null && t >= v.revokeMs) { refuse(v); cursors.delete(v.id); return; } heap.push(t + o.pollMs, () => ask(t + o.pollMs)); return; }
        const p = procs[Math.floor(r() * s.instances)];
        requests++;
        if (!p.live) { attach(p, t); coldRequests++; }
        p.lastUse = t;
        const ans = p.proj.read(cursors.get(v.id));
        if (ans.reset || !cursors.has(v.id)) { listed = new Set(); resyncs++; }
        const out: Rec[] = [];
        for (const row of ans.rows) {
          const a = Number(row.id.slice(1));
          listed?.add(a);
          if ('removed' in row) { const c = store.at(a, p.W); if (c) out.push(view(c, v.person)); }
          else out.push(view(row.data, v.person));
        }
        deliver(v, out, t);
        cursors.set(v.id, ans.cursor);
        if (ans.more && ++pages < maxPages) { heap.push(t + o.pageGapMs, () => ask(t + o.pageGapMs)); return; }
        if (ans.more) stuckAnswers++;
        if (listed) {
          // The end of a full or reset answer: agents it did not list are gone (deleted at this W).
          const drop: Rec[] = [];
          for (const a of clients[v.id].recs.keys()) if (!listed.has(a)) { const c = store.at(a, p.W); if (c) drop.push(view(c, v.person)); }
          deliver(v, drop, t);
          for (let a = 0; a < s.agents; a++) { const c = store.at(a, p.W); if (c?.deleted && !clients[v.id].recs.has(a)) cover(v, a, c.rev, t); }
        }
        // After a complete answer: exact = the client holds the store at the cut its cursor names (incompleteSnapshots, the
        // fixed-cut family); floor = no held row older than the cut (belowFloor, the pinned-floor family c2 chose).
        // A process behind the client's cursor keeps it, so the cut is the cursor's, not this process's W.
        const [sec, ns] = ans.cursor.split('.'), cut = Number(sec) * 1000 + Math.floor(Number(ns) / 1_000_000);
        if (!ans.more) for (let a = 0; a < s.agents; a++) {
          const want = store.at(a, cut), held = clients[v.id].recs.get(a);
          const wantRev = want && !(o.hardDeletes && want.deleted) ? want.rev : 0, heldRev = held && !(o.hardDeletes && held.deleted) ? held.rev : 0;
          if (wantRev !== heldRev) incompleteSnapshots++;
          // c2's pinned-floor guarantee (contract v2.2 C5, 67e82142): every row at its cut version or newer.
          if (heldRev < wantRev) belowFloor++;
        }
        listed = null; pages = 0;
        heap.push(t + o.pollMs, () => ask(t + o.pollMs));
      };
      const first = v.joinMs + Math.floor(r() * o.pollMs);
      heap.push(first, () => ask(first));
    }
  } else if (watermark) {
    // c2's contract C4/C5 (70097df4): one listener per project per process, attached on demand and closed lingerMs
    // after its last request. Its consistent snapshots advance a read point W; a deletion removes the document (a
    // hard delete) and is remembered as a tombstone only by a listener that saw it. A request with since gets the
    // documents and tombstones whose commit is in (since, W], and cursor = max(since, W). A since below what this
    // process can vouch for (its attach point W0, or retained tombstones) is the cold-replica case:
    //   wm         full snapshot with reset: the client drops agents absent from it.
    //   wm-ids     changes in (since, W] by commit plus the live id set; the client drops absent ids.
    //   wm-memtomb negative control: answers from in-memory tombstones anyway.
    type Proc = { live: boolean; epoch: number; W0: number; W: number; ptr: number; docs: Map<number, Commit>;
      tombs: Map<number, Commit>; lastUse: number };
    const procs: Proc[] = Array.from({ length: s.instances }, () => ({ live: false, epoch: 0, W0: 0, W: 0, ptr: 0,
      docs: new Map(), tombs: new Map(), lastUse: 0 }));
    writes += s.commits.length;  // the agentStatus document per change
    const cursor = new Map<number, number>();
    // Paged bootstrap (supervisor gate, c1/c7 fix): W_s is pinned by page 1; later pages, each on a random replica,
    // return the CURRENT head of every live doc after lastId in id order. wm-paged serves a page only from a replica
    // with W >= W_s ("not ready" otherwise, same token); wm-paged-filter keeps only docs committed at or before W_s
    // (the CS2b core at 9c3f6ad6); wm-paged-anyreplica lets a lagging replica finish the page. After the last page the
    // cursor is W_s, and every agent live at W_s must be held at its W_s revision or later.
    const paged = design.startsWith('wm-paged'), snaps = new Map<number, { Ws: number; lastId: number }>();
    const finishSnapshot = (v: Viewer, Ws: number, t: number) => {
      for (let a = 0; a < s.agents; a++) {
        const at = store.at(a, Ws), held = clients[v.id].recs.get(a);
        if (at?.deleted && !held) cover(v, a, at.rev, t);
        // An agent deleted at some point after W_s may correctly be missing from a later page.
        const deletedSince = store.byAgent[a].some(c => c.deleted && c.commitMs > Ws && c.commitMs <= t);
        if (at && !at.deleted && (!held || held.rev < at.rev) && !deletedSince) incompleteSnapshots++;
      }
    };
    const page = (v: Viewer, t: number) => {
      if (t > s.endMs) return;
      if (!has(v, t)) { if (v.revokeMs !== null && t >= v.revokeMs) { refuse(v); snaps.delete(v.id); return; } heap.push(t + o.pollMs, () => page(v, t + o.pollMs)); return; }
      const p = procs[Math.floor(r() * s.instances)];
      requests++;
      if (!p.live) { attach(p, t); coldRequests++; }
      p.lastUse = t;
      let st = snaps.get(v.id);
      if (!st) { st = { Ws: p.W, lastId: -1 }; snaps.set(v.id, st); }
      if (p.W >= st.Ws || design === 'wm-paged-anyreplica') {
        const rest = [...p.docs.keys()].filter(a => a > st!.lastId && (design !== 'wm-paged-filter' || p.docs.get(a)!.commitMs <= st!.Ws)).sort((x, y) => x - y);
        const ids = rest.slice(0, o.pageSize);
        deliver(v, ids.map(a => view(p.docs.get(a)!, v.person)), t, st.lastId === -1);
        if (ids.length) st.lastId = ids.at(-1)!;
        if (rest.length <= o.pageSize) {
          snaps.delete(v.id); finishSnapshot(v, st.Ws, t); cursor.set(v.id, st.Ws);
          const next = pollers.get(v.id)!; heap.push(t + o.pollMs, () => next(t + o.pollMs));
          return;
        }
      }
      heap.push(t + o.pageGapMs, () => page(v, t + o.pageGapMs));
    };
    const pollers = new Map<number, (t: number) => void>();
    const detach = (p: Proc) => { p.live = false; p.epoch++; p.docs.clear(); p.tombs.clear(); };
    const attach = (p: Proc, t: number) => {
      p.live = true; p.epoch++; p.W0 = p.W = t; p.docs.clear(); p.tombs.clear();
      for (let a = 0; a < s.agents; a++) { const c = store.at(a, t); if (c && !c.deleted) p.docs.set(a, c); }
      reads += Math.max(1, p.docs.size);
      p.ptr = 0; while (p.ptr < s.commits.length && s.commits[p.ptr].commitMs <= t) p.ptr++;
      const epoch = p.epoch;
      const tick = (at: number) => {
        if (p.epoch !== epoch || at > s.endMs) return;
        if (at - p.lastUse > o.lingerMs) { detach(p); return; }
        // The next consistent snapshot: every commit up to the new read point, newest per agent only.
        const W = Math.max(p.W, at - Math.floor(r() * o.notifyMaxMs));
        while (p.ptr < s.commits.length && s.commits[p.ptr].commitMs <= W) {
          const c = s.commits[p.ptr++];
          if (store.at(c.agent, W) !== c) continue;
          reads++;
          if (c.deleted) { p.docs.delete(c.agent); p.tombs.set(c.agent, c); } else { p.docs.set(c.agent, c); p.tombs.delete(c.agent); }
        }
        p.W = W;
        for (const [a, c] of p.tombs) if (c.commitMs < W - o.retainMs) p.tombs.delete(a);
        const next = at + 50 + Math.floor(r() * o.notifyMaxMs);
        heap.push(next, () => tick(next));
      };
      heap.push(t + 50, () => tick(t + 50));
    };
    for (const x of s.restarts) heap.push(x.atMs, () => detach(procs[x.instance]));
    // Dropping an agent is delivered as its deleted state at W, so the checker can see what the client now shows.
    const prune = (v: Viewer, W: number, keep: Map<number, Commit>, t: number) => {
      const out: Rec[] = [];
      for (const a of clients[v.id].recs.keys()) if (!keep.has(a)) { const c = store.at(a, W); if (c) out.push(view(c, v.person)); }
      deliver(v, out, t);
    };
    for (const v of s.viewers) {
      const first = v.joinMs + Math.floor(r() * o.pollMs);
      const pollV = (t: number) => {
        if (t > s.endMs) return;
        if (paged && !cursor.has(v.id)) { page(v, t); return; }
        if (!has(v, t)) { if (v.revokeMs !== null && t >= v.revokeMs) { refuse(v); cursor.delete(v.id); return; } heap.push(t + o.pollMs, () => pollV(t + o.pollMs)); return; }
        const p = procs[Math.floor(r() * s.instances)];
        requests++;
        if (!p.live) { attach(p, t); coldRequests++; }
        p.lastUse = t;
        const since = cursor.get(v.id), W = p.W;
        const vouch = Math.max(p.W0, W - o.retainMs);
        // A snapshot at W shows an agent deleted at W as absent, which is its current state.
        const absent = () => { for (let a = 0; a < s.agents; a++) if (!p.docs.has(a) && !clients[v.id].recs.has(a)) { const c = store.at(a, W); if (c?.deleted) cover(v, a, c.rev, t); } };
        if (since === undefined) {
          deliver(v, [...p.docs.values()].map(c => view(c, v.person)), t, true); absent();
        } else if (since < W) {
          const cold = since < vouch && design !== 'wm-memtomb';
          if (cold && design === 'wm') {
            deliver(v, [...p.docs.values()].map(c => view(c, v.person)), t, true);
            prune(v, W, p.docs, t); absent();
          } else {
            const out: Rec[] = [];
            for (const c of p.docs.values()) if (c.commitMs > since) out.push(view(c, v.person));
            for (const c of p.tombs.values()) if (c.commitMs > since) out.push(view(c, v.person));
            deliver(v, out, t, cold);
            if (cold) { prune(v, W, p.docs, t); absent(); }
          }
        }
        cursor.set(v.id, Math.max(since ?? -Infinity, W));
        heap.push(t + o.pollMs, () => pollV(t + o.pollMs));
      };
      pollers.set(v.id, pollV);
      heap.push(first, () => pollV(first));
    }
  } else {
    // Push: one listener per process; viewers hold a stream on one process and recycle it every recycleMs.
    type Proc = { live: boolean; startedAt: number; map: Map<number, Commit>; viewers: Set<Viewer>; epoch: number };
    const procs: Proc[] = Array.from({ length: s.instances }, () => ({ live: false, startedAt: 0, map: new Map(), viewers: new Set(), epoch: 0 }));
    writes += s.commits.length;  // the projection document per change (0 if it is the source document itself)
    const leak = design === 'push-leak';
    const start = (p: Proc, t: number) => {
      p.live = true; p.startedAt = t; p.epoch++; p.map.clear();
      for (let a = 0; a < s.agents; a++) { const c = store.at(a, t); if (c) p.map.set(a, c); }
      reads += s.agents;
      const attach = design === 'push-naive' ? t + o.attachGapMs : t, epoch = p.epoch;
      // The listener reports every commit after it attached, late, out of order and sometimes twice.
      for (const c of s.commits) {
        if (c.commitMs <= attach) continue;
        const copies = r() < o.duplicateFraction ? 2 : 1;
        for (let k = 0; k < copies; k++) heap.push(c.commitMs + 1 + Math.floor(r() * o.notifyMaxMs), () => {
          if (!p.live || p.epoch !== epoch) return;
          reads++;
          const held = p.map.get(c.agent);
          if (held && held.rev >= c.rev) return;
          p.map.set(c.agent, c);
          for (const v of p.viewers) deliver(v, [view(c, v.person, leak)], heap_t);
        });
      }
    };
    let heap_t = 0;
    // Each connection has a token, so a stale recycle or access check never closes a newer connection.
    const conn = new Map<number, number>();
    const connect = (v: Viewer, t: number) => {
      if (t > s.endMs) return;
      if (!has(v, t)) { if (v.revokeMs !== null && t >= v.revokeMs) refuse(v); else heap.push(v.joinMs, () => connect(v, v.joinMs)); return; }
      const p = procs[Math.floor(r() * s.instances)];
      if (!p.live) start(p, t);
      p.viewers.add(v);
      const token = (conn.get(v.id) ?? 0) + 1; conn.set(v.id, token);
      deliver(v, [...p.map.values()].map(c => view(c, v.person, leak)), t, true);
      const current = () => conn.get(v.id) === token;
      heap.push(t + o.recycleMs, () => { if (current()) { p.viewers.delete(v); connect(v, t + o.recycleMs); } });
      if (v.revokeMs !== null && design !== 'push-noreauth')
        heap.push(Math.max(t, v.revokeMs) + Math.floor(r() * o.accessCheckMs), () => { if (current()) { p.viewers.delete(v); conn.set(v.id, token + 1); refuse(v); } });
    };
    for (const x of s.restarts) heap.push(x.atMs, () => {
      const p = procs[x.instance]; p.live = false; p.epoch++;
      const dropped = [...p.viewers]; p.viewers.clear();
      for (const v of dropped) { const token = (conn.get(v.id) ?? 0) + 1, at = x.atMs + Math.floor(r() * 2_000);
        conn.set(v.id, token); heap.push(at, () => { if (conn.get(v.id) === token) connect(v, at); }); }
    });
    for (const v of s.viewers) heap.push(v.joinMs, () => connect(v, v.joinMs));
    while (heap.size) { const e = heap.pop(); if (e.t > s.endMs) break; heap_t = e.t; e.fn(); }
  }
  while (heap.size) { const e = heap.pop(); if (e.t > s.endMs) break; e.fn(); }

  // Final check: a viewer with access at the end holds the latest revision of every agent (Needs you filtered).
  let finalMismatch = 0, lost = 0, checked = 0;
  for (const v of s.viewers) {
    const c = clients[v.id], end = has(v, s.endMs);
    for (let a = 0; a < s.agents; a++) {
      const list = store.byAgent[a], k = c.covered.get(a) ?? 0, last = store.at(a, s.endMs);
      // An agent deleted by the end that the client never showed needs nothing.
      if (last?.deleted && !c.recs.has(a)) continue;
      for (const cm of list) if (cm.commitMs >= v.joinMs && has(v, cm.commitMs) && v.revokeMs === null) { checked++; if (cm.rev > (list[k - 1]?.rev ?? 0)) lost++; }
      if (!end) { if (v.revokeMs !== null && c.recs.has(a)) revocationLeaks++; continue; }
      const want = store.at(a, s.endMs), held = c.recs.get(a);
      if ((want?.rev ?? 0) !== (held?.rev ?? 0) || (held && held.needsYouFor !== (want!.needsYouFor === v.person ? v.person : null))) finalMismatch++;
    }
  }
  lags.sort((x, y) => x - y);
  const q = (p: number) => lags.length ? lags[Math.min(lags.length - 1, Math.floor(p * lags.length))] : 0;
  const n = s.commits.length;
  return { design, commits: n, checked, lost, finalMismatch, regressions, revocationLeaks, privacyLeaks, staleDeliveries: stale, resyncs, requests, coldRequests, incompleteSnapshots, belowFloor, stuckAnswers,
    lagMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lags.at(-1) ?? 0 }, reads, writes,
    readsPerChange: reads / Math.max(1, n), writesPerChange: writes / Math.max(1, n),
    recordsSentPerViewer: sent / Math.max(1, s.viewers.length), heldStreams: polling || watermark || design === 'core' ? 0 : s.viewers.length };
}
