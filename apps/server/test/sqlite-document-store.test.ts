// The SQLite adapter must pass the same document-store contract as the emulator.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FieldPath, FieldValue, Filter, type Firestore, type Timestamp } from 'firebase-admin/firestore';
import { SqliteFirestore } from '../src/storage/sqlite-firestore.js';
import { documentStoreContract } from './document-store-contract.js';

const db = new SqliteFirestore() as unknown as Firestore;
let sequence = 0;
for (const { name, run } of documentStoreContract({ db, FieldValue, FieldPath, Filter })) {
  test(name, () => run(`contract${sequence++}`));
}

test('a one-off query get() reports every document as added', async () => {
  const c = db.collection('changes');
  await Promise.all([c.doc('a').set({ n: 1 }), c.doc('b').set({ n: 2 })]);
  const snap = await c.orderBy('n').get();
  expect(snap.docChanges().map(change => [change.type, change.doc.id, change.newIndex])).toEqual([['added', 'a', 0], ['added', 'b', 1]]);
});

test('a file-backed store keeps documents across reopen and closes cleanly', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-sqlite-'));
  try {
    const file = join(folder, 'store.sqlite');
    const first = new SqliteFirestore(file);
    await first.doc('kept/a').set({ n: 1 });
    first.close();
    const second = new SqliteFirestore(file);
    expect((await second.doc('kept/a').get()).data()).toEqual({ n: 1 });
    second.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// Not in the shared contract: on the emulator the outside write would block on the transaction's lock.
test('a transaction that re-reads a document changed since its first read retries', async () => {
  for (const reread of ['doc', 'query'] as const) {
    const c = db.collection(`reread_${reread}`), a = c.doc('a'), b = c.doc('b');
    await a.set({ n: 1 });
    let attempts = 0;
    await db.runTransaction(async tx => {
      attempts++;
      const first = (await tx.get(a)).data()!.n;
      if (attempts === 1) await a.set({ n: 2 });
      if (reread === 'doc') await tx.get(a); else await tx.get(c.where('n', '>', 0));
      tx.set(b, { copied: first });
    });
    expect((await b.get()).data()).toEqual({ copied: 2 });
    expect(attempts).toBe(2);
  }
});

test('maps shaped like the internal value tags round-trip as plain maps', async () => {
  const ref = db.doc('tags/a');
  const data = { ts: { __k42: 'ts', s: 123, n: 0 }, map: { __k42: 'map', v: { x: 1 } }, list: [{ __k42: 'bytes', b: 'AA==' }] };
  await ref.set(data);
  expect((await ref.get()).data()).toEqual(data);
  expect((await db.collection('tags').where('ts.s', '==', 123).get()).size).toBe(1);
});

test('undefined anywhere in written data is refused before anything is written, as by the SDK', async () => {
  const ref = db.doc('undef/a');
  expect(() => ref.set({ a: undefined })).toThrow(/undefined.*"a"/);
  expect(() => ref.set({ m: { b: [1, undefined] } })).toThrow(/"m\.b"/);
  await ref.set({ n: 1 });
  expect(() => ref.update({ n: undefined })).toThrow(/"n"/);
  await expect(db.runTransaction(async tx => { tx.set(ref, { x: undefined }); })).rejects.toThrow(/undefined/);
  expect(() => db.batch().create(db.doc('undef/b'), { y: undefined })).toThrow(/undefined/);
  expect((await ref.get()).data()).toEqual({ n: 1 });
});

test('null inside an in-list matches nothing', async () => {
  const c = db.collection('in_null');
  await Promise.all([c.doc('n').set({ x: null }), c.doc('s').set({ x: 7 })]);
  expect((await c.where('x', 'in', [null, 7]).get()).docs.map(d => d.id)).toEqual(['s']);
});

test('a callback that throws ABORTED runs again, up to maxAttempts, as with the SDK', async () => {
  let calls = 0;
  const aborted = () => Object.assign(new Error('injected abort'), { code: 10 });
  expect(await db.runTransaction(async () => { if (++calls === 1) throw aborted(); return 'done'; })).toBe('done');
  expect(calls).toBe(2);
  calls = 0;
  await expect(db.runTransaction(async () => { calls++; throw aborted(); }, { maxAttempts: 3 })).rejects.toThrow('injected abort');
  expect(calls).toBe(3);
  calls = 0;
  await expect(db.runTransaction(async () => { calls++; throw Object.assign(new Error('other'), { code: 9 }); })).rejects.toThrow('other');
  expect(calls).toBe(1);
});

test('a read-only transaction reads one snapshot across concurrent commits and never retries', async () => {
  const c = db.collection('ro_snapshot'), a = c.doc('a'), gone = c.doc('gone');
  await Promise.all([a.set({ n: 1 }), gone.set({ n: 9 })]);
  const sub = db.collectionGroup('ro_items');
  await a.collection('ro_items').doc('i1').set({ k: 1 });
  let attempts = 0, writeTime: Timestamp | undefined;
  const seen = await db.runTransaction(async tx => {
    attempts++;
    const before = (await tx.get(a)).data()!.n;
    if (attempts === 1) {
      writeTime = (await a.set({ n: 2 })).writeTime;
      await Promise.all([c.doc('b').set({ n: 3 }), gone.delete(), a.collection('ro_items').doc('i2').set({ k: 1 })]);
    }
    const again = await tx.get(a);
    const list = await tx.get(c.orderBy('n'));
    const count = (await tx.get(c.count())).data().count;
    const group = await tx.get(sub.where('k', '==', 1));
    return { before, after: again.data()!.n, ids: list.docs.map(d => d.id), count, group: group.size, readTime: again.readTime };
  }, { readOnly: true });
  expect(attempts).toBe(1);
  expect(seen).toMatchObject({ before: 1, after: 1, ids: ['a', 'gone'], count: 2, group: 1 });
  expect(seen.readTime.valueOf() < writeTime!.valueOf()).toBe(true);
  expect((await c.orderBy('n').get()).docs.map(d => [d.id, d.data().n])).toEqual([['a', 2], ['b', 3]]);
  await expect(db.runTransaction(async tx => { tx.set(a, { n: 0 }); }, { readOnly: true })).rejects.toThrow(/read-only/);
  expect((await a.get()).data()).toEqual({ n: 2 });
});

test('every commit is strictly after any read time handed out before it', async () => {
  // Hundreds of read-then-write pairs land in the same millisecond; Date.now() alone would tie them.
  const ref = db.doc('clock/a');
  for (let n = 0; n < 500; n++) {
    const read = (await ref.get()).readTime;
    const { writeTime } = await ref.set({ n });
    expect(writeTime.valueOf() > read.valueOf()).toBe(true);
  }
});

test('count() is a class instance with get() on its prototype, inside and outside transactions', async () => {
  const c = db.collection('aggregate');
  await Promise.all([c.doc('a').set({ k: 1 }), c.doc('b').set({ k: 2 })]);
  const aggregate = c.where('k', '>', 0).count();
  expect(Object.getPrototypeOf(aggregate)).not.toBe(Object.prototype);
  expect(Object.hasOwn(Object.getPrototypeOf(aggregate), 'get')).toBe(true);
  expect((await aggregate.get()).data().count).toBe(2);
  expect(await db.runTransaction(async tx => (await tx.get(aggregate)).data().count)).toBe(2);
  expect(await db.runTransaction(async tx => (await tx.get(aggregate)).data().count, { readOnly: true })).toBe(2);
});

test('transaction getAll reads each document once without going through get()', async () => {
  const c = db.collection('getall_once');
  await c.doc('a').set({ n: 1 });
  let gets = 0;
  const result = await db.runTransaction(async tx => {
    const original = tx.get.bind(tx);
    (tx as { get: unknown }).get = (...args: Parameters<typeof tx.get>) => { gets++; return original(...args); };
    return (await tx.getAll(c.doc('a'), c.doc('missing'))).map(snap => snap.exists);
  });
  expect(result).toEqual([true, false]);
  expect(gets).toBe(0);
});

// SQL narrows string equality before decoding; the results must be exactly what in-process filtering gives.
test('string equality and in-lists narrowed in SQL keep exactly the matching documents', async () => {
  const c = db.collection('prefilter');
  await Promise.all([
    c.doc('plain').set({ s: 'x', nested: { s: 'x' } }),
    c.doc('other').set({ s: 'y', nested: { s: 'y' } }),
    c.doc('number').set({ s: 1, nested: { s: 1 } }),
    c.doc('looks-like-json').set({ s: '"x"', nested: { s: '{"a":1}' } }),
    // A tag-shaped map is stored wrapped, so a plain JSON path cannot see its fields.
    c.doc('tagged').set({ s: 'x', nested: { __k42: 'ts', s: 'x' } }),
    c.doc('tagged-top').set({ __k42: 'map', s: 'x', nested: { s: 'x' } }),
    c.doc('missing').set({ other: 'x' }),
    // SQLite and the parameter binding disagree on a lone surrogate, so it must never be narrowed in SQL.
    c.doc('lone-surrogate').set({ s: '\ud800', nested: { s: 'a\udc00' } }),
  ]);
  const ids = async (q: FirebaseFirestore.Query) => (await q.get()).docs.map(d => d.id).sort();
  expect(await ids(c.where('s', '==', 'x'))).toEqual(['plain', 'tagged', 'tagged-top']);
  expect(await ids(c.where('nested.s', '==', 'x'))).toEqual(['plain', 'tagged', 'tagged-top']);
  expect(await ids(c.where('s', '==', '"x"'))).toEqual(['looks-like-json']);
  expect(await ids(c.where('nested.s', '==', '{"a":1}'))).toEqual(['looks-like-json']);
  expect(await ids(c.where('s', 'in', ['x', 'y']))).toEqual(['other', 'plain', 'tagged', 'tagged-top']);
  expect(await ids(c.where('s', 'in', ['y', 1]))).toEqual(['number', 'other']);
  expect(await ids(c.where('s', '==', 'x').where('nested.s', '==', 'y'))).toEqual([]);
  expect(await ids(c.where(Filter.or(Filter.where('s', '==', 'y'), Filter.where('s', '==', 1))))).toEqual(['number', 'other']);
  expect(await ids(db.collectionGroup('prefilter').where('s', '==', 'y'))).toEqual(['other']);
  expect(await ids(c.where('s', '==', '\ud800'))).toEqual(['lone-surrogate']);
  expect(await ids(c.where('s', 'in', ['\ud800', 'zz']))).toEqual(['lone-surrogate']);
  expect(await ids(c.where('nested.s', '==', 'a\udc00'))).toEqual(['lone-surrogate']);
});

// The store's clock resumes from the file, so a system clock that moved backward cannot reorder history.
test('times after a reopen stay after every persisted time, even if the system clock moved backward', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-sqlite-clock-'));
  const realNow = Date.now;
  try {
    const file = join(folder, 'store.sqlite');
    const first = new SqliteFirestore(file);
    const kept = await first.doc('clock/kept').set({ n: 1 });
    const gone = await first.doc('clock/gone').set({ n: 1 });
    const deleted = await first.doc('clock/gone').delete();
    first.close();
    expect(gone.writeTime.toMillis()).toBeGreaterThan(0);
    Date.now = () => realNow() - 3_600_000;
    const second = new SqliteFirestore(file);
    const read = await second.doc('clock/kept').get();
    expect(read.readTime.valueOf() >= kept.writeTime.valueOf()).toBe(true);
    const next = await second.doc('clock/new').set({ n: 2 });
    // Strictly after the last commit of the earlier session, including a delete that left no document behind.
    expect(next.writeTime.valueOf() > deleted.writeTime.valueOf()).toBe(true);
    second.close();
  } finally { Date.now = realNow; rmSync(folder, { recursive: true, force: true }); }
});

test('two connections to one file never hand out the same or an earlier update time', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-sqlite-clock-'));
  const realNow = Date.now;
  try {
    const file = join(folder, 'store.sqlite');
    const a = new SqliteFirestore(file), b = new SqliteFirestore(file);
    Date.now = () => 1_000_000;
    const first = await a.doc('shared/x').set({ n: 1 });
    const second = await b.doc('shared/y').set({ n: 1 });
    const third = await a.doc('shared/z').set({ n: 1 });
    expect(second.writeTime.valueOf() > first.writeTime.valueOf()).toBe(true);
    expect(third.writeTime.valueOf() > second.writeTime.valueOf()).toBe(true);
    a.close(); b.close();
  } finally { Date.now = realNow; rmSync(folder, { recursive: true, force: true }); }
});

// A client may hold any read time as a cursor; after a reopen with the clock moved back, later writes must sort after it.
test('writes after a reopen sort after every read time handed out before it, without writing the file on every read', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-sqlite-clock-'));
  const realNow = Date.now;
  try {
    const file = join(folder, 'store.sqlite');
    const t = 1_800_000_000_000;
    Date.now = () => t;
    const first = new SqliteFirestore(file);
    await first.doc('cursor/a').set({ n: 1 });
    Date.now = () => t + 60_000;
    const cursor = (await first.doc('cursor/a').get()).readTime;
    const lease = () => { const peek = new DatabaseSync(file); try { return (peek.prepare('SELECT last_us FROM clock WHERE id = 2').get() as { last_us: number } | undefined)?.last_us ?? 0; } finally { peek.close(); } };
    const leased = lease();
    for (let i = 0; i < 50; i++) { Date.now = () => t + 60_000 + i; await first.doc('cursor/a').get(); }
    expect(lease()).toBe(leased);
    first.close();
    Date.now = () => t;
    const second = new SqliteFirestore(file);
    const write = await second.doc('cursor/a').update({ n: 2 });
    expect(write.writeTime.valueOf() > cursor.valueOf()).toBe(true);
    expect((await second.doc('cursor/a').get()).readTime.valueOf() > cursor.valueOf()).toBe(true);
    second.close();
  } finally { Date.now = realNow; rmSync(folder, { recursive: true, force: true }); }
});

test('a commit re-runs only the listeners on the documents, collections and groups it wrote', async () => {
  const store = new SqliteFirestore();
  try {
    const s = store as unknown as Firestore, reads: string[] = [];
    const runQuery = store.runQuery.bind(store), readDocSync = store.readDocSync.bind(store);
    store.runQuery = (q, ...rest) => { reads.push(q.state.group ? `group:${q.state.group}` : `query:${q.state.parent}`); return runQuery(q, ...rest); };
    store.readDocSync = (ref, ...rest) => { reads.push(`doc:${ref.path}`); return readDocSync(ref, ...rest); };
    const seen: string[] = [];
    const stops = [
      s.collection('watched').onSnapshot(snap => seen.push(`query:${snap.size}`)),
      s.collectionGroup('items').onSnapshot(snap => seen.push(`group:${snap.size}`)),
      s.doc('single/a').onSnapshot(snap => seen.push(`doc:${snap.exists}`)),
    ];
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    await settle();
    expect(seen).toEqual(['query:0', 'group:0', 'doc:false']);
    const written = async (write: () => Promise<unknown>) => { reads.length = 0; await write(); await settle(); return [...reads]; };
    expect(await written(() => s.doc('elsewhere/x').set({ n: 1 }))).toEqual([]);
    expect(await written(() => s.doc('watched/x/deeper/y').set({ n: 1 }))).toEqual([]);
    expect(await written(() => s.doc('single/b').set({ n: 1 }))).toEqual([]);
    expect(await written(() => s.doc('watched/x').set({ n: 1 }))).toEqual(['query:watched']);
    expect(await written(() => s.doc('projects/p/items/z').set({ n: 1 }))).toEqual(['group:items']);
    expect(await written(() => s.doc('single/a').set({ n: 1 }))).toEqual(['doc:single/a']);
    const batch = s.batch(); batch.set(s.doc('watched/w'), { n: 2 }); batch.delete(s.doc('single/a'));
    expect((await written(() => batch.commit())).sort()).toEqual(['doc:single/a', 'query:watched']);
    expect(seen).toEqual(['query:0', 'group:0', 'doc:false', 'query:1', 'group:1', 'doc:true', 'query:2', 'doc:false']);
    stops.forEach(stop => stop());
  } finally { store.close(); }
});

// A clean close gives back the unused lease, so restarts don't push times ahead of the system clock; a crash keeps it.
test('clean reopens resume at the last time handed out, and an unclean stop still resumes past every read time', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-sqlite-clock-'));
  const realNow = Date.now;
  try {
    const file = join(folder, 'store.sqlite');
    const t = 1_800_000_000_000;
    Date.now = () => t;
    let last: Timestamp | undefined;
    for (let i = 0; i < 10; i++) {
      const store = new SqliteFirestore(file);
      await store.doc('restart/a').set({ i });
      last = (await store.doc('restart/a').get()).readTime;
      store.close();
    }
    // Ten restarts within one millisecond: each commit is one microsecond after the last, not a lease ahead.
    expect(last!.toMillis() - t).toBeLessThan(1);
    const crashed = new SqliteFirestore(file);
    await crashed.doc('restart/a').set({ i: 10 });
    const cursor = (await crashed.doc('restart/a').get()).readTime;
    // No close(): the next connection must still treat the whole lease as handed out.
    const next = new SqliteFirestore(file);
    expect((await next.doc('restart/b').set({ n: 1 })).writeTime.valueOf() > cursor.valueOf()).toBe(true);
    expect((await next.doc('restart/b').get()).readTime.toMillis() - t).toBeGreaterThanOrEqual(1000);
    next.close(); crashed.close();
  } finally { Date.now = realNow; rmSync(folder, { recursive: true, force: true }); }
});

// Each connection leases its own read times: one closing must not lower the bound another's readers hold.
test('closing one connection never lets a later commit fall behind another live connection\'s read time', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-sqlite-leases-'));
  const realNow = Date.now;
  try {
    const file = join(folder, 'store.sqlite');
    const t = 1_800_000_000_000;
    Date.now = () => t;
    const a = new SqliteFirestore(file);
    await a.doc('x/a').set({ n: 1 }); await a.doc('x/a').get();
    const b = new SqliteFirestore(file);
    const bRead = (await b.doc('x/a').get()).readTime;
    a.close();
    const c = new SqliteFirestore(file);
    const cWrite = (await c.doc('x/c').set({ n: 1 })).writeTime;
    expect(cWrite.valueOf() > bRead.valueOf()).toBe(true);
    b.close(); c.close();
    // With every connection closed cleanly, a reopen resumes at the last time handed out, not a lease ahead.
    const d = new SqliteFirestore(file);
    expect((await d.doc('x/d').set({ n: 1 })).writeTime.toMillis() - cWrite.toMillis()).toBeLessThan(1);
    d.close();
  } finally { Date.now = realNow; rmSync(folder, { recursive: true, force: true }); }
});

// The engine writes through one connection, but a test harness or operator tool may commit beside it.
test('listeners see commits made by another connection to the same file, and stop watching when unsubscribed', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mlswarm-sqlite-external-'));
  try {
    const file = join(folder, 'store.sqlite');
    const engine = new SqliteFirestore(file), outside = new SqliteFirestore(file);
    const seen: string[] = [];
    let wake = () => {};
    const next = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no snapshot after ${JSON.stringify(seen)}`)), 3000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    let pending = next();
    const stopQuery = engine.collection('requests').where('status', '==', 'answered').onSnapshot(snap => { seen.push(`q:${snap.docs.map(d => d.id).join(',')}`); wake(); });
    await pending;
    pending = next();
    await outside.doc('requests/r1').set({ status: 'answered' });
    await pending;
    pending = next();
    const stopDoc = engine.doc('requests/r1').onSnapshot(snap => { seen.push(`d:${snap.data()?.status}`); wake(); });
    await pending;
    pending = next();
    await outside.doc('requests/r1').update({ status: 'closed' });
    await pending;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seen.slice(0, 3)).toEqual(['q:', 'q:r1', 'd:answered']);
    expect(seen.slice(3).sort()).toEqual(['d:closed', 'q:']);
    stopQuery(); stopDoc();
    expect((engine as unknown as { fileWatch?: unknown }).fileWatch).toBeUndefined();
    engine.close(); outside.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// Firestore's getAll(...refs, { fieldMask }) returns only the listed fields, in and outside transactions.
test('getAll with a fieldMask returns only the listed fields and still reports missing documents', async () => {
  const c = db.collection('masked');
  await c.doc('a').set({ keep: 1, nested: { x: 1, y: 2 }, drop: 'secret' });
  const outside = await db.getAll(c.doc('a'), c.doc('missing'), { fieldMask: ['keep', new FieldPath('nested', 'x')] });
  expect(outside.map(snap => [snap.id, snap.exists, snap.data()])).toEqual([['a', true, { keep: 1, nested: { x: 1 } }], ['missing', false, undefined]]);
  const inside = await db.runTransaction(tx => tx.getAll(c.doc('a'), { fieldMask: ['drop'] }));
  expect(inside[0].data()).toEqual({ drop: 'secret' });
  expect((await db.getAll(c.doc('a')))[0].data()).toEqual({ keep: 1, nested: { x: 1, y: 2 }, drop: 'secret' });
});
