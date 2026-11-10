// CS2b core (current-state contract C5/C6, gate 1 pinned cut): model-free tests of the per-process projection. A
// simulated store commits documents at increasing commit times; replicas see it through listeners that lag by different
// amounts. Cases from codex-1, codex-2 (8dfcbb64), c1, c8 (0ed7c5c1) and c9 (c383aea4, 4c33568f) run on this core.
import { expect, test } from 'vitest';
import { createProjection, decodeCursor, ProjectionConflict, rev, type Change, type Rev } from '../src/view/current-state-core.js';

type Projection = ReturnType<typeof createProjection<Doc>>;
const t = (n: number): Rev => rev(1_700_000_000 + Math.floor(n / 1000), (n % 1000) * 1_000_000);

// The store: every commit (time, id, value or removed). A replica at readTime R has applied every commit ≤ R.
// Removal is soft (contract C6): a commit with v = null, an ordinary modification the reader shows as absent.
type Doc = { v: number | null };
class Store {
  commits: { at: number; id: string; v: number | null }[] = [];
  write(at: number, id: string, v: number | null) { this.commits.push({ at, id, v }); }
  // The changes a listener reports between two readTimes: one per document, its latest state in (from, to].
  changes(from: number, to: number): Change<Doc>[] {
    const latest = new Map<string, { at: number; v: number | null }>();
    for (const c of this.commits) if (c.at > from && c.at <= to) latest.set(c.id, c);
    return [...latest].map(([id, c]) => ({ type: 'modified' as const, id, updateTime: t(c.at), data: { v: c.v } }));
  }
  stateAt(to: number) {
    const s = new Map<string, number>();
    for (const c of this.commits) if (c.at <= to) { if (c.v === null) s.delete(c.id); else s.set(c.id, c.v); }
    return s;
  }
  /** Each document's latest commit time at or before `to`. */
  versionsAt(to: number) {
    const s = new Map<string, number>();
    for (const c of this.commits) if (c.at <= to) s.set(c.id, c.at);
    return s;
  }
}
function replica(store: Store, readTime: number, opts: { pageSize?: number } = {}) {
  const p = createProjection<Doc>(opts);
  let seen = -1;
  const catchUp = (to: number) => { if (to > seen) { p.apply(store.changes(seen, to), t(to)); seen = to; } };
  catchUp(readTime);
  return { p, get seen() { return seen; }, catchUp };
}
// A client keeping the newest revision per document, removals included (contract C5), so an older row never comes back.
// It loops on `more` without delay (c1) and moves to the next replica on `notReady`.
function client() {
  const rows = new Map<string, { rev: Rev; v: number | null }>();
  let cursor: string | undefined;
  return {
    rows,
    get cursor() { return cursor; },
    set cursor(c) { cursor = c; },
    page(p: Projection) {
      const a = p.read(cursor);
      for (const r of a.rows) {
        const known = rows.get(r.id);
        if (known && known.rev >= r.rev) continue;
        rows.set(r.id, { rev: r.rev, v: 'removed' in r ? null : r.data.v });
      }
      cursor = a.cursor;
      return a;
    },
    /** One answer: pages until complete, across replicas (one per page, round robin), with `between` run after each page. */
    read(ps: Projection[], between: () => void = () => {}, maxPages = 1000) {
      let pages = 0, notReady = 0, k = 0;
      for (;;) {
        const a = this.page(ps[k++ % ps.length]!);
        if (a.notReady) { notReady++; if (notReady > maxPages) return { pages, notReady, complete: false }; continue; }
        pages++;
        between();
        if (!a.more) return { pages, notReady, complete: true };
        if (pages >= maxPages) return { pages, notReady, complete: false };
      }
    },
  };
}
const values = (m: Map<string, { v: number | null }>) => new Map([...m].filter(([, r]) => r.v !== null).map(([id, r]) => [id, r.v]));
const pinOf = (cursor: string | undefined) => decodeCursor(cursor)!.pin;
const ms = (r: Rev) => (Number(r.slice(0, 12)) - 1_700_000_000) * 1000 + Number(r.slice(13)) / 1_000_000;
// The pinned-cut guarantee: after a complete answer at P every document is held at its version at P or a newer one.
function heldAtOrAfter(c: ReturnType<typeof client>, s: Store, pin: Rev) {
  const late: string[] = [];
  for (const [id, when] of s.versionsAt(ms(pin))) {
    const held = c.rows.get(id);
    if (!held || held.rev < t(when)) late.push(id);
  }
  return late;
}

test('a snapshot, then only the changes since its cursor', () => {
  const s = new Store();
  s.write(1, 'a', 1); s.write(2, 'b', 1);
  const r = replica(s, 5), c = client();
  c.read([r.p]);
  expect(values(c.rows)).toEqual(new Map([['a', 1], ['b', 1]]));
  expect(c.cursor).toBe(`${t(5)}.~`);
  s.write(6, 'a', 2);
  r.catchUp(8);
  const delta = r.p.read(c.cursor);
  expect(delta).toEqual({ rows: [{ id: 'a', rev: t(6), data: { v: 2 } }], cursor: `${t(8)}.~`, more: false, notReady: false });
  // Idle: the same cursor back, nothing visited (codex-1's fast path), nothing repeated.
  expect(r.p.read(delta.cursor)).toEqual({ rows: [], cursor: delta.cursor, more: false, notReady: false });
});

test('termination under churn (c8, codex-2): a write between every page on 2 replicas, page 500, 3 s gaps', () => {
  // The 5,000-agent flagship under gate 2 (a): each agent's document changes every 20 s, 750 changes per 3 s gap.
  const s = new Store(), n = 5000, ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(4, '0')}`);
  for (const id of ids) s.write(1, id, 0);
  const a = replica(s, 1, { pageSize: 500 }), b = replica(s, 1, { pageSize: 500 }), c = client();
  let now = 1, w = 0;
  const gap = () => {
    for (let k = 0; k < 750; k++) s.write(now + 1 + Math.floor(k * 3000 / 750), ids[(w++ * 7) % n]!, w);
    now += 3000;
    a.catchUp(now); b.catchUp(now - 1000);  // b lags 1 s: it serves pins at least 1 s old
  };
  const first = c.read([a.p, b.p], gap);
  expect(first).toEqual({ pages: Math.ceil(n / 500), notReady: 0, complete: true });
  expect(heldAtOrAfter(c, s, pinOf(c.cursor))).toEqual([]);
  // After complete plus one delta from a caught-up replica, the client equals the source.
  c.read([a.p]);
  expect(values(c.rows)).toEqual(s.stateAt(now));
  // A pin moving with each page instead (the withdrawn (rev, id) order) never finished here: 750 > 500 per page.
});

test("codex-1's fast/slow handoff: a lagging replica answers not ready, never complete; the assembled state stays right", () => {
  const s = new Store();
  s.write(1, 'a', 1); s.write(2, 'b', 2); s.write(20, 'a', 20); s.write(21, 'b', 21);
  const fast = replica(s, 30, { pageSize: 1 }), slow = replica(s, 10, { pageSize: 1 }), c = client();
  const p1 = c.page(fast.p);
  expect([p1.rows.map(r => [r.id, r.rev]), p1.more, p1.cursor]).toEqual([[['a', t(20)]], true, `s.${t(30)}.a`]);
  const p2 = c.page(slow.p);
  expect(p2).toEqual({ rows: [], cursor: p1.cursor, more: true, notReady: true });
  expect(values(c.rows)).toEqual(new Map([['a', 20]]));  // partial, and the answer says so
  const p3 = c.page(fast.p);
  expect([p3.rows.map(r => [r.id, r.rev]), p3.more, p3.cursor]).toEqual([[['b', t(21)]], false, `${t(30)}.~`]);
  expect(values(c.rows)).toEqual(s.stateAt(30));
  // A complete cursor on a replica behind it: not ready, not "nothing new", cursor kept.
  expect(slow.p.read(c.cursor)).toEqual({ rows: [], cursor: c.cursor, more: false, notReady: true });
});

test('mid-answer changes (c1, c13): before its page a row comes at its head; after its page, in the next answer', () => {
  const s = new Store();
  for (const id of ['a', 'b', 'c', 'd']) s.write(1, id, 0);
  const r = replica(s, 2, { pageSize: 2 }), c = client();
  const p1 = c.page(r.p);  // a, b at pin 2
  expect(p1.rows.map(x => x.id)).toEqual(['a', 'b']);
  s.write(3, 'a', 3);   // after its page
  s.write(3, 'd', 3);   // before its page
  s.write(4, 'e', 4);   // a new document after the last id
  s.write(4, 'c', null);  // removed (softly) before its page: listed at its head, as removed
  r.catchUp(5);
  const p2 = c.page(r.p), p3 = c.page(r.p);
  expect([p2.rows.map(x => [x.id, x.rev]), p2.more, p2.cursor]).toEqual([[['c', t(4)], ['d', t(3)]], true, `s.${t(2)}.d`]);
  expect([p3.rows.map(x => [x.id, x.rev]), p3.more, p3.cursor]).toEqual([[['e', t(4)]], false, `${t(2)}.~`]);
  expect(values(c.rows)).toEqual(new Map([['a', 0], ['b', 0], ['d', 3], ['e', 4]]));
  // The next answer sends everything newer than the pin: a@3 (missed), and c, d, e again (already held, ignored).
  const d1 = c.page(r.p), d2 = c.page(r.p);
  expect([d1.rows.map(x => x.id), d2.rows.map(x => x.id), d2.more]).toEqual([['a', 'c'], ['d', 'e'], false]);
  expect(values(c.rows)).toEqual(s.stateAt(5));
});

test('a delta is pinned too: it ends in ⌈changed / page⌉ pages while a busy project keeps writing (c1)', () => {
  // 5,000 agents writing every 20 s, a viewer polling every 3 s, 0.1 s per follow-up page: lag stays ≤ poll + pages.
  const s = new Store(), n = 5000, ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(4, '0')}`);
  for (const id of ids) s.write(0, id, 0);
  const r = replica(s, 0, { pageSize: 500 }), c = client();
  let now = 0, w = 0;
  const advance = (ms: number) => {
    for (let k = 0; k < ms / 4; k++) s.write(now + 1 + k * 4, ids[(w++ * 13) % n]!, w);  // 250 changes per second
    now += ms; r.catchUp(now);
  };
  c.read([r.p]);
  for (let poll = 0; poll < 20; poll++) {
    advance(3000);
    const asked = now;
    const { pages, complete } = c.read([r.p], () => advance(100));
    expect(complete).toBe(true);
    expect(pages).toBeLessThanOrEqual(2);  // ≈750 changed rows per poll at 500 a page; follow-ups don't chase the tail
    // Pinned at the poll: every commit up to the poll is held when the answer ends, pages × 0.1 s after it.
    expect(ms(pinOf(c.cursor))).toBe(asked);
    expect(heldAtOrAfter(c, s, pinOf(c.cursor))).toEqual([]);
    expect(now - asked).toBeLessThanOrEqual(200);
  }
});

test('seeded sweep: random routing over lagging replicas, writes between pages, never a false complete or a loss', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let x = seed;
    const rand = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const s = new Store(), ids = Array.from({ length: 30 }, (_, i) => `a${String(i).padStart(2, '0')}`);
    for (const id of ids) s.write(1, id, 0);
    const replicas = [0, 1, 2].map(() => replica(s, 1, { pageSize: 7 }));
    const c = client();
    let now = 1;
    const tick = () => {
      now += 1 + Math.floor(rand() * 3);
      const k = Math.floor(rand() * 4);  // several commits may share a time (one batch)
      for (let j = 0; j < k; j++) s.write(now, ids[Math.floor(rand() * ids.length)]!, rand() < 0.1 ? null : now);
      for (const r of replicas) r.catchUp(now - Math.floor(rand() * 8));
    };
    for (let step = 0; step < 100; step++) {
      tick();
      const order = [...replicas].sort(() => rand() - 0.5).map(r => r.p);
      const { complete } = c.read(order, tick);
      expect(complete, `seed ${seed} step ${step}`).toBe(true);
      expect(heldAtOrAfter(c, s, pinOf(c.cursor)), `seed ${seed} step ${step}`).toEqual([]);
    }
    for (const r of replicas) r.catchUp(now);
    c.read([replicas[0]!.p]);
    expect(values(c.rows), `seed ${seed}`).toEqual(s.stateAt(now));
  }
});

test('a removal never comes back: the client keeps its revision, so an older row from a slower replica is ignored', () => {
  const s = new Store();
  s.write(1, 'a', 1); s.write(1, 'x', 1);
  const fast = replica(s, 2), slow = replica(s, 2), c = client();
  c.read([fast.p]);
  s.write(3, 'x', 3); s.write(6, 'x', null);
  fast.catchUp(7); slow.catchUp(4);
  c.read([fast.p]);  // x removed at 6, complete at 7
  expect(values(c.rows)).toEqual(new Map([['a', 1]]));
  c.read([fast.p]);
  expect(slow.p.read(c.cursor).notReady).toBe(true);  // behind the client's cut: it sends nothing older
  slow.catchUp(8);
  c.read([slow.p]);
  expect(values(c.rows)).toEqual(new Map([['a', 1]]));
});

test('a snapshot first page pins the serving W; documents committed together are both delivered across pages', () => {
  const s = new Store();
  s.write(1, 'a', 0);
  const r = replica(s, 1, { pageSize: 1 }), c = client();
  c.read([r.p]);
  s.write(5, 'x', 1); s.write(5, 'y', 1);  // one batch: same commit time
  r.catchUp(6);
  const first = r.p.read(c.cursor);
  expect(first).toMatchObject({ rows: [{ id: 'x' }], more: true, cursor: `${t(1)}.${t(6)}.x` });
  const second = r.p.read(first.cursor);
  expect(second).toMatchObject({ rows: [{ id: 'y' }], more: false, cursor: `${t(6)}.~` });
  for (let i = 0; i < 3; i++) expect(r.p.read(second.cursor).rows).toEqual([]);
});

test('an older snapshot never moves the watermark back; malformed cursors are refused', () => {
  const p = createProjection<Doc>();
  p.apply([{ type: 'added', id: 'a', updateTime: t(5), data: { v: 1 } }], t(10));
  p.apply([{ type: 'modified', id: 'a', updateTime: t(3), data: { v: 0 } }], t(8));
  expect(p.watermark).toBe(t(10));
  expect(p.read().rows).toEqual([{ id: 'a', rev: t(5), data: { v: 1 } }]);
  const r0 = '000000000001.000000000', r1 = '000000000002.000000000';
  for (const bad of ['x', '1.2.a', `${r0}.a`, '000000000001.00000000a.~', `${r0}.~.x`, `s.${r0}.$`, `s.${r0}.~`,
    `${r1}.${r0}.a`, `${r0}.${r0}.a`, `q.${r0}.a`, 42])
    expect(() => p.read(bad), String(bad)).toThrow();
  expect(p.read(`${r0}.~`).rows).toHaveLength(1);
  expect(p.read(`s.${r0}.0`).rows).toHaveLength(1);
  expect(p.read(`${r0}.${r1}.0`).rows).toHaveLength(1);
  expect(() => createProjection<Doc>().read()).toThrow();
});

test('a read costs what it returns (c1, c9): a delta visits the changes since its base, a first page about one page', () => {
  const s = new Store(), n = 5000, ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(4, '0')}`);
  for (const id of ids) s.write(1, id, 0);
  const r = replica(s, 1, { pageSize: 500 }), c = client();
  let before = r.p.visits;
  c.page(r.p);
  expect(r.p.visits - before).toBe(501);  // one page plus the look-ahead row
  c.read([r.p]);
  for (let k = 0; k < 10; k++) s.write(2, ids[k * 499]!, 2);
  r.catchUp(3);
  before = r.p.visits;
  expect(c.page(r.p).rows).toHaveLength(10);
  expect(r.p.visits - before).toBe(10);
  // Idle, and repeated changes to the same rows: the log stays bounded and a delta skips superseded entries.
  before = r.p.visits;
  c.page(r.p);
  expect(r.p.visits - before).toBe(0);
  for (let round = 4; round < 40; round++) { for (let k = 0; k < 500; k++) s.write(round, ids[k]!, round); r.catchUp(round); }
  before = r.p.visits;
  expect(c.read([r.p])).toMatchObject({ pages: 1, complete: true });
  expect(r.p.visits - before).toBeLessThanOrEqual(2 * n + 64);
  expect(values(c.rows)).toEqual(s.stateAt(40));
});

test('a re-delivered unchanged document is a no-op; different content under one commit time is refused (c1, c13, supervisor)', () => {
  const p = createProjection<Doc>({ pageSize: 500 });
  const docs = Array.from({ length: 100 }, (_, i) => ({ type: 'added' as const, id: `a${String(i).padStart(3, '0')}`, updateTime: t(1), data: { v: i } }));
  p.apply(docs, t(1));
  const complete = p.read().cursor;
  // The supervisor's probe: the same document at the same commit time, 1,000 times (replays, listener resumes).
  for (let k = 2; k < 1002; k++) p.apply([{ type: 'modified', id: 'a000', updateTime: t(1), data: { v: 0 } }], t(k));
  for (let k = 0; k < 50; k++) p.apply(docs.map(d => ({ ...d, type: 'modified' as const, data: { ...d.data } })), t(1002 + k));
  let before = p.visits;
  expect(p.read(complete)).toMatchObject({ rows: [], more: false });
  expect(p.visits - before).toBe(0);
  // One real change after all that: the delta visits it alone.
  p.apply([{ type: 'modified', id: 'a050', updateTime: t(1100), data: { v: -1 } }], t(1100));
  // ...replayed 100 times after the base: still one entry (below the compaction threshold, so no cleanup hides it).
  for (let k = 0; k < 100; k++) p.apply([{ type: 'modified', id: 'a050', updateTime: t(1100), data: { v: -1 } }], t(1100));
  before = p.visits;
  expect(p.read(complete).rows.map(r => r.id)).toEqual(['a050']);
  expect(p.visits - before).toBe(1);
  // Same commit time, different content: the whole snapshot is refused, nothing changes, and the projection stops
  // answering (reads and applies throw) until the binding re-attaches a fresh one.
  expect(() => p.apply([{ type: 'modified', id: 'a001', updateTime: t(1101), data: { v: 9 } },
    { type: 'modified', id: 'a050', updateTime: t(1100), data: { v: -2 } }], t(1101))).toThrow(ProjectionConflict);
  expect(p.watermark).toBe(t(1100));
  expect(() => p.read(complete)).toThrow(ProjectionConflict);
  expect(() => p.apply([], t(1102))).toThrow(ProjectionConflict);
  // Within one snapshot too: the same id at the same time with two contents.
  const q = createProjection<Doc>();
  expect(() => q.apply([{ type: 'added', id: 'x', updateTime: t(5), data: { v: 1 } },
    { type: 'modified', id: 'x', updateTime: t(5), data: { v: 2 } }], t(5))).toThrow(ProjectionConflict);
  expect(q.watermark).toBe(null);
  expect(() => q.read()).toThrow(ProjectionConflict);
});

test('a multi-page delta visits at most min(changes since its base, ids left) per page (c9)', () => {
  const s = new Store(), n = 5000, ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(4, '0')}`);
  for (const id of ids) s.write(1, id, 0);
  const r = replica(s, 1, { pageSize: 500 }), c = client();
  c.read([r.p]);
  // A long disconnect: every document changed, several times (25,000 log entries before compaction).
  for (let round = 2; round < 7; round++) { for (const id of ids) s.write(round, id, round); r.catchUp(round); }
  const before = r.p.visits;
  expect(c.read([r.p])).toMatchObject({ pages: 10, complete: true });
  // Walked in id order once the log is longer than the ids left: ≈ one page plus the look-ahead per page.
  expect(r.p.visits - before).toBeLessThanOrEqual(10 * 501);
  expect(values(c.rows)).toEqual(s.stateAt(6));
});

test('durable deletion revisions advance an already absent head and reject stale removals after recreation', () => {
  const p = createProjection<Doc>();
  p.apply([{ type: 'added', id: 'x', updateTime: t(1), data: { v: 1 } }], t(1));
  p.apply([{ type: 'removed', id: 'x', updateTime: t(2) }], t(2));
  const deleted = p.read().cursor;
  // A recreation and second deletion can both happen while this replica is disconnected.
  p.apply([{ type: 'removed', id: 'x', updateTime: t(4) }], t(5));
  expect(p.read(deleted).rows).toEqual([{ id: 'x', rev: t(4), removed: true }]);
  p.apply([{ type: 'added', id: 'x', updateTime: t(6), data: { v: 6 } }], t(6));
  p.apply([{ type: 'removed', id: 'x', updateTime: t(4) }], t(7));
  expect(p.read().rows).toEqual([{ id: 'x', rev: t(6), data: { v: 6 } }]);
});
