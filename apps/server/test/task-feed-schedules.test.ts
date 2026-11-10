// T2 change feed under adversarial schedules, model-free. The real readNativeTaskChanges (cursor, overlap, floor,
// startAfter tie-breaker, paging) runs against an in-memory store in which every write has a stamp s (its changedAt)
// and a time v ≥ s at which it becomes visible to reads. Writes, polls and pages interleave on one database clock.
// It checks what the feed's own logic guarantees; production stamp semantics and real contention stay with the
// emulator suite and cloud evidence.
import { beforeEach, expect, test, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';

type Version = { revision: number; stamp: number; visibleAt: number };
const db = vi.hoisted(() => ({ now: 0, tasks: new Map<string, Version[]>() }));
vi.mock('../src/projects/access.js', () => ({
  assertMembership: async () => 'owner', assertAgentMembership: async () => 'owner', assertProjectWritable: async () => undefined,
}));
vi.mock('../src/firestore.js', async () => {
  // Database operations stay in memory; SDK value helpers (FieldPath, Timestamp, ...) are the real ones.
  const { FieldPath, FieldValue, Filter, Timestamp } = await import('firebase-admin/firestore');
  type Clause = { where?: number; startAfter?: [number, string]; limit?: number; desc?: boolean };
  const query = (clause: Clause): unknown => ({
    _feed: clause,
    orderBy: (_field: unknown, dir?: string) => query({ ...clause, desc: clause.desc || dir === 'desc' }),
    where: (_field: string, _op: string, value: Timestamp) => query({ ...clause, where: value.toMillis() }),
    startAfter: (at: Timestamp, id: string) => query({ ...clause, startAfter: [at.toMillis(), id] }),
    limit: (n: number) => query({ ...clause, limit: n }),
    select: () => query(clause),
  });
  const visible = (versions: { stamp: number; visibleAt: number; revision: number }[], at: number) =>
    versions.filter(version => version.visibleAt <= at).at(-1);
  const read = (clause: Clause) => {
    const at = db.now;
    let rows = [...db.tasks].flatMap(([id, versions]) => {
      const version = visible(versions, at);
      return version ? [{ id, ...version }] : [];
    }).sort((a, b) => a.stamp - b.stamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (clause.desc) rows.reverse();
    if (clause.where !== undefined) rows = rows.filter(row => row.stamp > clause.where!);
    if (clause.startAfter) {
      const [stamp, id] = clause.startAfter;
      rows = rows.filter(row => row.stamp > stamp || (row.stamp === stamp && row.id > id));
    }
    if (clause.limit !== undefined) rows = rows.slice(0, clause.limit);
    const docs = rows.map(row => {
      const data = { id: row.id, title: row.id, status: 'backlog', assignedAgentId: null, priority: 'normal', revision: row.revision,
        changedAt: Timestamp.fromMillis(row.stamp) };
      return { id: row.id, data: () => data, get: (field: string) => (data as Record<string, unknown>)[field] };
    });
    return { docs, size: docs.length, readTime: Timestamp.fromMillis(at), empty: docs.length === 0 };
  };
  const anyDoc = (): unknown => ({ get: async () => ({ data: () => undefined, exists: false }), collection: () => anyCollection(), id: 'x', path: 'x' });
  const anyCollection = (): unknown => ({ ...(query({}) as object), doc: anyDoc, path: 'x' });
  return {
    FieldPath, FieldValue, Filter, Timestamp,
    db: { runTransaction: async (work: (tx: unknown) => unknown) => work({
      get: async (target: { _feed?: Clause }) => target._feed ? read(target._feed) : { data: () => undefined, exists: false },
    }) },
    collection: anyCollection, validatedCollection: anyCollection, projectCollection: anyCollection,
    projectDocument: anyDoc, projectDoc: anyDoc, agents: anyCollection, profiles: anyCollection(), githubAccounts: anyCollection(),
    currentProjectId: () => 'p'.repeat(64), inProject: (_id: string, work: () => unknown) => work(),
  };
});
import { FEED_OVERLAP_MS, listNativeTaskSummaryChanges } from '../src/projects/native-tasks.js';

// Deterministic PRNG (mulberry32) so every schedule replays exactly.
function prng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const person = (skewMs: number) => ({ actor: { kind: 'person', person: { id: 'owner' } } as never, now: () => Date.now() + skewMs });

// Database time starts at a real epoch (27 Oct 2026), so stamps behind it stay valid Firestore times.
const BASE = Date.UTC(2026, 9, 27);
type Schedule = { pageDelayMs?: number; seed: number; maxGapMs: number; tieStampMs: number; pageLimit: number; instances: number; tasks: number; writes: number };
type Event = { at: number; kind: 'write'; task: string; stamp: number } | { at: number; kind: 'poll'; instance: number };

// One run: random writes and polls over 60 s of database time, then one final poll after the last write is visible.
async function run(s: Schedule) {
  const random = prng(s.seed);
  db.tasks.clear(); db.now = BASE;
  const events: Event[] = [];
  for (let i = 0; i < s.writes; i++) {
    const at = BASE + Math.floor(random() * 60_000) + 1000;  // visibility (commit) time
    // The stamp trails visibility by up to maxGapMs: a slow commit, or a transaction whose final attempt committed late.
    let stamp = at - Math.floor(random() * (s.maxGapMs + 1));
    // Coarse stamps force equal values across tasks, without stretching a gap past maxGapMs.
    if (s.tieStampMs && at - (stamp - stamp % s.tieStampMs) <= s.maxGapMs) stamp -= stamp % s.tieStampMs;
    events.push({ at, kind: 'write', task: `task_${String(Math.floor(random() * s.tasks)).padStart(2, '0')}`, stamp });
  }
  for (let at = BASE + 500; at < BASE + 61_000 + s.maxGapMs; at += 500 + Math.floor(random() * 4000)) {
    events.push({ at, kind: 'poll', instance: Math.floor(random() * s.instances) });
  }
  events.sort((a, b) => a.at - b.at || (a.kind === 'write' ? -1 : 1));
  const skews = Array.from({ length: s.instances }, () => Math.floor((random() - 0.5) * 600_000));  // ±5 min process clocks
  // The client: one cursor, shared across instances (any instance may answer), and the highest revision per task.
  db.now = BASE;
  const seen = new Map<string, number>();
  let cursor = (await listNativeTaskSummaryChanges(person(skews[0]).actor, {}, person(skews[0]).now)).cursor;
  const drain = async (instance: number) => {
    let more = true;
    while (more) {
      const { actor, now } = person(skews[instance]);
      const page = await listNativeTaskSummaryChanges(actor, { since: cursor, limit: s.pageLimit }, now);
      for (const task of page.tasks) seen.set(task.id, Math.max(seen.get(task.id) ?? 0, task.revision));
      cursor = page.cursor; more = page.more;
      // Pages are separate requests; time (and writes) move between them. A slow client or a long drain spreads them out.
      db.now += 1 + Math.floor(random() * (s.pageDelayMs ?? 30));
      applyDue();
    }
  };
  const gaps = new Map<string, number[]>();
  let next = 0;
  function applyDue() {
    while (next < events.length && events[next].at <= db.now) {
      const event = events[next++];
      if (event.kind !== 'write') continue;
      const versions = db.tasks.get(event.task) ?? [];
      versions.push({ revision: versions.length + 1, stamp: event.stamp, visibleAt: event.at });
      db.tasks.set(event.task, versions);
      gaps.set(event.task, [...(gaps.get(event.task) ?? []), event.at - event.stamp]);
    }
  }
  for (const event of events) {
    if (event.kind !== 'poll' || event.at < db.now) continue;
    db.now = event.at; applyDue();
    await drain(event.instance);
  }
  db.now = Math.max(db.now, ...events.map(event => event.at)) + 1; applyDue();
  await drain(0);
  const lost = [...db.tasks].filter(([id, versions]) => (seen.get(id) ?? 0) < versions.length).map(([id]) => id);
  const overGap = lost.filter(id => gaps.get(id)!.some(gap => gap > FEED_OVERLAP_MS));
  return { lost, overGap, writes: s.writes, tasks: db.tasks.size, lostGaps: lost.map(id => gaps.get(id)) };
}

beforeEach(() => { db.tasks.clear(); db.now = 0; });

test('with every stamp within the overlap of its visibility, no final revision is ever missed (300 schedules)', async () => {
  let checked = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const schedule = { seed, maxGapMs: FEED_OVERLAP_MS, tieStampMs: seed % 3 === 0 ? 1000 : 0, pageLimit: 1 + (seed % 3),
      instances: 1 + (seed % 4), tasks: 4 + (seed % 9), writes: 20 + (seed % 60) };
    const result = await run(schedule);
    expect(result.lost, `seed ${seed} gaps ${JSON.stringify(result.lostGaps)}`).toEqual([]);
    checked += result.tasks;
  }
  expect(checked).toBeGreaterThan(1500);
}, 120_000);

test('beyond the overlap a final revision can be missed, and only a write whose gap exceeded it is ever lost', async () => {
  let lostRuns = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const result = await run({ seed, maxGapMs: 3 * FEED_OVERLAP_MS, tieStampMs: 0, pageLimit: 2, instances: 3, tasks: 6, writes: 40 });
    expect(result.overGap, `seed ${seed}: every lost task had a gap above the overlap`).toEqual(result.lost);
    if (result.lost.length) lostRuns++;
  }
  // The documented limit is real: some schedules lose a final revision, and nothing in the response says so.
  expect(lostRuns).toBeGreaterThan(0);
}, 120_000);

test('equal stamps across many tasks, a page limit of 1 and writes landing between pages lose nothing', async () => {
  for (let seed = 1000; seed <= 1100; seed++) {
    const result = await run({ seed, maxGapMs: 2000, tieStampMs: 5000, pageLimit: 1, instances: 2, tasks: 12, writes: 80 });
    expect(result.lost, `seed ${seed}`).toEqual([]);
  }
}, 120_000);

test('a long drain (pages seconds apart) still loses nothing: the floor stays at the first page\'s read time', async () => {
  for (let seed = 2000; seed <= 2150; seed++) {
    const result = await run({ seed, maxGapMs: FEED_OVERLAP_MS, tieStampMs: 0, pageLimit: 1, pageDelayMs: 4000, instances: 2, tasks: 10, writes: 60 });
    expect(result.lost, `seed ${seed}`).toEqual([]);
  }
}, 120_000);
