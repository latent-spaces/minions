import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, coldReplicaAdapter, listenerCapAdapter, listenerReadPointAdapter, matches, noAuthOnDeltaAdapter, privateFilteredAdapter, noResyncAdapter, perReplicaMemoryAdapter, referenceAdapter, snapshotRaceAdapter,
  Store, type Adapter, type Row, type Viewer } from './current-state-conformance.js';

const viewer: Viewer = { id: 'v1', project: 'p' };
const row = (agentId: string, revision: number, phase = 'idle', freshUntil = 1_000_000): Row => ({ agentId, phase, revision, freshUntil });
function setup(make: (store: Store) => Adapter, agents = 3) {
  const store = new Store();
  store.grant(viewer);
  for (let i = 0; i < agents; i++) store.commit('p', row(`a${i}`, 1));
  return { store, client: new Client(viewer, make(store)) };
}

test('a write committed during the snapshot is delivered, not lost at the boundary', () => {
  for (const [make, ok] of [[referenceAdapter, true], [snapshotRaceAdapter, false]] as const) {
    const { store, client } = setup(make);
    store.onBetweenReads = () => { store.onBetweenReads = undefined; store.commit('p', row('a0', 2, 'turn')); };
    client.bootstrap(0);
    client.poll(1);
    assert.equal(matches(store, client), ok, make.name);
  }
});

test('a delta read through a different replica sees every change since the cursor', () => {
  for (const [make, ok] of [[referenceAdapter, true], [perReplicaMemoryAdapter, false]] as const) {
    const { store, client } = setup(make);
    client.bootstrap(0);
    store.commit('p', row('a1', 2, 'turn'));
    // The next request lands on another replica (random routing), and the one after that too.
    client.poll(1);
    store.commit('p', row('a2', 2, 'turn'));
    client.poll(1);
    assert.equal(matches(store, client), ok, make.name);
  }
});

test('duplicated or reordered deliveries converge by revision, never by arrival or wall-clock order', () => {
  const { store, client } = setup(referenceAdapter);
  client.bootstrap(0);
  store.commit('p', row('a0', 2, 'turn'));
  store.commit('p', row('a0', 3, 'idle'));
  client.poll(1);
  // A replica replays an old notification (duplicate, out of order); the newer revision must win.
  (client as unknown as { apply(rows: Row[]): void }).apply([row('a0', 2, 'turn'), row('a0', 3, 'idle'), row('a0', 2, 'turn')]);
  assert.equal(client.rows.get('a0')?.revision, 3);
  assert.ok(matches(store, client));
});

test('a cursor behind compaction forces an explicit resync instead of silently skipping changes', () => {
  for (const [make, ok] of [[referenceAdapter, true], [noResyncAdapter, false]] as const) {
    const { store, client } = setup(make);
    client.bootstrap(0);
    store.commit('p', row('a1', 2, 'turn'));
    store.compact('p', store.head('p'));
    client.poll(1);
    assert.equal(matches(store, client), ok, make.name);
    if (ok) assert.equal(client.resyncs, 1);
  }
});

test('liveness expiry shows offline from held data alone, with no new write', () => {
  const { store, client } = setup(referenceAdapter);
  store.commit('p', row('a0', 2, 'turn', 5_000));
  client.bootstrap(0);
  const writes = store.head('p');
  assert.equal(client.status('a0', 4_999), 'turn');
  assert.equal(client.status('a0', 5_000), 'offline');
  assert.equal(store.head('p'), writes);
});

test('revocation is enforced on the next delta through any replica, and the client drops what it held', () => {
  for (const [make, ok] of [[referenceAdapter, true], [noAuthOnDeltaAdapter, false]] as const) {
    const { store, client } = setup(make);
    client.bootstrap(0);
    store.revoke(viewer);
    store.commit('p', row('a1', 2, 'secret'));
    client.poll(1);
    assert.equal(client.denied && client.rows.size === 0, ok, make.name);
  }
});

test('read work scales with changes and viewers, not with agents per poll', () => {
  const { store } = setup(referenceAdapter, 5000);
  const viewers = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, project: 'p' }));
  const clients = viewers.map(v => { store.grant(v); return new Client(v, referenceAdapter(store)); });
  clients.forEach((client, i) => client.bootstrap(i % 3));
  const afterBootstrap = store.rowReads;
  assert.equal(afterBootstrap, 10 * 5000);
  for (let change = 0; change < 20; change++) {
    store.commit('p', row(`a${change}`, 2, 'turn'));
    clients.forEach((client, i) => client.poll((i + change) % 3));
  }
  assert.equal(store.rowReads - afterBootstrap, 20 * 10);
  for (const client of clients) assert.ok(matches(store, client));
});

test('a drain or cold restart reconnects every viewer from its durable cursor without re-bootstrap or loss', () => {
  for (const [make, ok] of [[referenceAdapter, true], [perReplicaMemoryAdapter, false]] as const) {
    const store = new Store();
    for (let i = 0; i < 50; i++) store.commit('p', row(`a${i}`, 1));
    let adapter = make(store);
    const viewers = Array.from({ length: 100 }, (_, i) => ({ id: `v${i}`, project: 'p' }));
    viewers.forEach(v => store.grant(v));
    let clients = viewers.map(v => new Client(v, adapter));
    clients.forEach(client => client.bootstrap(0));
    // Replica 0 drains; the process restarts with no memory, and every viewer resumes on another replica while writes land.
    adapter = make(store);
    clients = clients.map(old => Object.assign(new Client(old.viewer, adapter), { rows: old.rows, cursor: old.cursor }));
    const reads = store.rowReads;
    clients.forEach((client, i) => { if (i % 10 === 0) store.commit('p', row(`a${i % 50}`, 2 + i, 'turn')); client.poll(1); });
    clients.forEach(client => client.poll(1));
    assert.equal(clients.every(client => matches(store, client)), ok, make.name);
    if (ok) {
      assert.equal(clients.reduce((n, client) => n + client.resyncs, 0), 0);
      assert.ok(store.rowReads - reads < 100 * 50, 'resume must not re-read the whole roster per viewer');
    }
  }
});

test('small projects keep progressing next to a hot 5,000-agent project, and their reads ignore its churn', () => {
  const store = new Store();
  for (let i = 0; i < 5000; i++) store.commit('hot', row(`h${i}`, 1));
  const small = Array.from({ length: 50 }, (_, p) => `s${p}`);
  for (const project of small) for (let i = 0; i < 5; i++) store.commit(project, row(`${project}a${i}`, 1));
  const adapter = referenceAdapter(store);
  const smallClients = small.map(project => { const v = { id: `v-${project}`, project }; store.grant(v); return new Client(v, adapter); });
  smallClients.forEach(client => client.bootstrap(0));
  const reads = store.rowReads;
  for (let i = 0; i < 2000; i++) store.commit('hot', row(`h${i}`, 2, 'turn'));
  small.forEach((project, p) => store.commit(project, row(`${project}a${p % 5}`, 2, 'turn')));
  smallClients.forEach((client, i) => client.poll(i % 3));
  assert.ok(smallClients.every(client => matches(store, client)), 'every small project saw its change after one poll');
  assert.equal(store.rowReads - reads, small.length, 'one row read per small viewer, none for the hot project');
});

test('a lagging replica (contract C4) never rewinds the cursor or skips what it has not seen', () => {
  for (const jump of [false, true]) {
    const store = new Store();
    store.grant(viewer);
    for (let i = 0; i < 3; i++) store.commit('p', row(`a${i}`, 1));
    // Replica 1 lags by 2 commits; replica 0 is current.
    const client = new Client(viewer, listenerReadPointAdapter(store, [0, 2], jump));
    client.bootstrap(0);
    let lastCursor = client.cursor!;
    const revisions = new Map([...client.rows].map(([id, r]) => [id, r.revision]));
    for (let step = 0; step < 12; step++) {
      store.commit('p', row(`a${step % 3}`, 2 + step, step % 2 ? 'turn' : 'idle'));
      client.poll(step % 2);
      assert.ok(client.cursor! >= lastCursor, 'cursor never rewinds');
      lastCursor = client.cursor!;
      for (const [id, r] of client.rows) { assert.ok(r.revision >= (revisions.get(id) ?? 0), 'no revision regression'); revisions.set(id, r.revision); }
    }
    client.poll(0);
    assert.equal(matches(store, client), !jump, jump ? 'jumping the cursor to head loses changes' : 'converges once a current replica answers');
  }
});

test('a private Needs-you item reaches only its owner, through snapshots and deltas on any replica', () => {
  for (const leak of [false, true]) {
    const store = new Store();
    const owner = { id: 'owner', project: 'p' }, other = { id: 'other', project: 'p' };
    store.grant(owner); store.grant(other);
    store.commit('p', row('a0', 1));
    store.commit('p', { ...row('a1', 1, 'needs_you'), privateTo: 'owner' });
    const adapter = privateFilteredAdapter(store, leak);
    const [mine, theirs] = [new Client(owner, adapter), new Client(other, adapter)];
    mine.bootstrap(0); theirs.bootstrap(1);
    store.commit('p', { ...row('a2', 1, 'needs_you'), privateTo: 'owner' });
    mine.poll(1); theirs.poll(0);
    const leaked = [...theirs.rows.values()].some(r => r.privateTo === 'owner');
    assert.equal(leaked, leak, leak ? 'the leaking adapter must be caught' : 'no private row reached another viewer');
    assert.equal([...mine.rows.values()].filter(r => r.privateTo === 'owner').length, 2);
  }
});

test('a replica over its listener cap falls back to a flagged full read and stays correct', () => {
  for (const stale of [false, true]) {
    const store = new Store();
    store.grant(viewer);
    for (let i = 0; i < 100; i++) store.commit('p', row(`a${i}`, 1));
    const adapter = listenerCapAdapter(store, new Set([1]), stale);
    const client = new Client(viewer, adapter);
    client.bootstrap(0);
    store.commit('p', row('a7', 2, 'turn'));
    const reads = store.rowReads;
    client.poll(1);
    assert.equal(matches(store, client), !stale, stale ? 'an untracked replica must not answer "no change"' : 'fallback stays correct');
    if (!stale) {
      assert.equal(adapter.fallbacks, 1);
      assert.equal(store.rowReads - reads, 100, 'the fallback costs one roster read, which the flag makes visible');
    }
  }
});

test('an agent removal (tombstone) drops the agent for every viewer, also through a lagging replica, and is never resurrected', () => {
  const store = new Store();
  store.grant(viewer);
  for (let i = 0; i < 3; i++) store.commit('p', row(`a${i}`, 1));
  const client = new Client(viewer, listenerReadPointAdapter(store, [0, 1]));
  client.bootstrap(0);
  store.commit('p', { ...row('a1', 2), removed: true });
  client.poll(1); // lagging replica: has not seen the removal yet
  store.commit('p', row('a2', 2, 'turn'));
  client.poll(0);
  assert.ok(!client.rows.has('a1'), 'removed agent dropped');
  assert.ok(matches(store, client));
  // A stale replay of the pre-removal row must not bring it back.
  (client as unknown as { apply(rows: Row[]): void }).apply([row('a1', 1)]);
  assert.ok(!client.rows.has('a1'), 'no resurrection from a stale replay');
});

test('a cold-restarted replica answers reset for cursors older than its coverage, so removals before it are not lost', () => {
  for (const broken of [false, true]) {
    const store = new Store();
    store.grant(viewer);
    for (let i = 0; i < 3; i++) store.commit('p', row(`a${i}`, 1));
    const started = new Map<number, number>();
    const client = new Client(viewer, coldReplicaAdapter(store, started, broken));
    client.bootstrap(0);
    store.commit('p', { ...row('a0', 2), removed: true });
    started.set(1, store.head('p')); // replica 1 restarts after the removal
    store.commit('p', row('a1', 2, 'turn'));
    client.poll(1);
    assert.equal(matches(store, client), !broken, broken ? 'serving only post-restart history keeps a removed agent' : 'reset then snapshot is correct');
    if (!broken) assert.equal(client.resyncs, 1);
  }
});

test('liveness: a projection that skips contact extensions until near expiry shows an online agent offline too early', () => {
  // Baseline: offline 90 s after the last contact. Contacts at 0 and 60 s, then the agent disconnects.
  const contacts = [0, 60_000], ttl = 90_000;
  const baselineOfflineAt = contacts.at(-1)! + ttl;
  const projected = (extendWhenRemainingBelow: number) => {
    let freshUntil = 0;
    for (const at of contacts) if (freshUntil === 0 || freshUntil - at < extendWhenRemainingBelow) freshUntil = at + ttl;
    return freshUntil;
  };
  assert.equal(projected(Infinity), baselineOfflineAt, 'projecting every extending contact matches baseline freshness');
  // Extend only when < 20 s remain: the 60 s contact (30 s left) is skipped, so the view goes offline at 90 s, not 150 s.
  assert.ok(projected(20_000) < baselineOfflineAt, 'throttled extension is a freshness regression the contract must not allow');
});

import { LatestStore, Replica, type Cursor } from './current-state-conformance.js';
function latestClient() {
  const rows = new Map<string, Row>(); let cursor: Cursor | null = null; let resyncs = 0;
  const applyRows = (list: Row[]) => { for (const r of list) { const old = rows.get(r.agentId); if (!old || r.revision > old.revision) rows.set(r.agentId, r); } /* removed rows stay as tombstones */ };
  return {
    rows, get resyncs() { return resyncs; },
    bootstrap(replica: Replica) { rows.clear(); const s = replica.snapshot(); applyRows(s.rows); cursor = s.cursor; },
    poll(replica: Replica, opts?: Parameters<Replica['since']>[2], limit?: number) {
      const d = replica.since(cursor!, limit, opts);
      if ('resync' in d) { resyncs++; return this.bootstrap(replica); }
      applyRows(d.changes); cursor = d.cursor;
    },
    visible() { return new Map([...rows].filter(([, r]) => !r.removed)); },
  };
}
const liveDocs = (store: LatestStore) => new Map([...store.docs].filter(([, d]) => !d.row.removed).map(([id, d]) => [id, d.row.revision]));
const same = (a: Map<string, Row>, b: Map<string, number>) => a.size === b.size && [...b].every(([id, rev]) => a.get(id)?.revision === rev);

test('latest-state model: a soft tombstone survives a cold replica restart as an ordinary state delta', () => {
  const store = new LatestStore();
  store.commitBatch([row('a0', 1), row('a1', 1), row('a2', 1)]);
  const client = latestClient();
  client.bootstrap(new Replica(store));
  store.commitBatch([{ ...row('a1', 2), removed: true }]);   // removal = field update, doc kept
  const cold = new Replica(store, store.clock);               // restarted after the removal: knows docs as of W0 only
  client.poll(cold);
  assert.ok(!client.visible().has('a1'));
  assert.ok(same(client.visible(), liveDocs(store)));
  assert.equal(client.resyncs, 0, 'no reset needed when removals are soft');
});

test('latest-state model: with hard deletes, a cold replica must reset a cursor older than its start', () => {
  for (const hardDeletes of [true, false]) {
    const store = new LatestStore();
    store.commitBatch([row('a0', 1), row('a1', 1)]);
    const client = latestClient();
    client.bootstrap(new Replica(store));
    store.commitBatch([], ['a1']);                             // hard delete: the doc is gone, no history
    const cold = new Replica(store, store.clock);
    client.poll(cold, { hardDeletes });
    assert.equal(same(client.visible(), liveDocs(store)), hardDeletes, hardDeletes ? 'reset then snapshot drops the deleted agent' : 'without reset the deleted agent stays visible');
  }
});

test('latest-state model: two docs committed at the same time across a page boundary are both delivered with an (updateTime, docId) cursor', () => {
  for (const timeOnlyCursor of [false, true]) {
    const store = new LatestStore();
    store.commitBatch([row('a0', 1)]);
    const replica = new Replica(store);
    const client = latestClient();
    client.bootstrap(replica);
    store.commitBatch([row('b1', 1, 'turn'), row('b2', 1, 'turn')]); // one batch: equal updateTime
    replica.catchUp();
    client.poll(replica, { timeOnlyCursor }, 1);   // page of one: cut between the tied docs
    client.poll(replica, { timeOnlyCursor }, 1);
    assert.equal(same(client.visible(), liveDocs(store)), !timeOnlyCursor, timeOnlyCursor ? 'a time-only cursor drops the second tied doc' : 'the docId tiebreak delivers both');
  }
});

test('latest-state model: a final page that ends a tie at W advances the cursor, so an idle poll sends nothing (codex-1)', () => {
  const store = new LatestStore();
  store.commitBatch([row('a', 1), row('z', 1)]);              // one batch: equal updateTime t1 = W
  const replica = new Replica(store);
  const last = replica.since({ t: store.clock, id: 'a' }, 10); // resume mid-tie, page not full
  assert.ok(!('resync' in last) && last.changes.map(r => r.agentId).join() === 'z');
  const idle = replica.since((last as { cursor: Cursor }).cursor, 10);
  assert.ok(!('resync' in idle) && idle.changes.length === 0, 'z is not resent once the range is complete');
});

test('latest-state model: a page continued on a lagging replica keeps the cursor; finishing at the first replica\'s W loses rows', () => {
  const store = new LatestStore();
  store.commitBatch([row('a0', 1)]);
  const lagging = new Replica(store);                          // its listener stops before b1, b2
  store.commitBatch([row('b1', 1)]); store.commitBatch([row('b2', 1)]);
  const ahead = new Replica(store);
  const first = ahead.since({ t: 1, id: '￿' }, 1);        // page of one: b1, more pending up to ahead.w
  assert.ok(!('resync' in first) && first.changes[0].agentId === 'b1');
  const mid = (first as { cursor: Cursor }).cursor;
  const next = lagging.since(mid);
  assert.ok(!('resync' in next) && next.changes.length === 0);
  assert.deepEqual(next.cursor, mid, 'a replica behind the page never advances past what it covers');
  const resumed = ahead.since(next.cursor);
  assert.ok(!('resync' in resumed) && resumed.changes.some(r => r.agentId === 'b2'), 'b2 arrives once an up-to-date replica answers');
  // Broken: the continuation token carries ahead's W and the lagging replica "finishes" there.
  const skipped = ahead.since({ t: ahead.w, id: '￿' });
  assert.ok(!('resync' in skipped) && !skipped.changes.some(r => r.agentId === 'b2'), 'finishing at an uncovered target cut drops b2');
});
