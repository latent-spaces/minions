// Firestore-subset conformance cases: the document-store behaviour apps/server
// relies on. Each case is independent of the test runner and of the backend, so
// the Firestore emulator and every self-hosted adapter run the same checks.
import assert from 'node:assert/strict';
// Server code checks `instanceof Timestamp` against the SDK class (re-exported by firestore.ts), so every
// adapter must return this exact class; the contract asserts that rather than accepting a look-alike.
import { Timestamp } from 'firebase-admin/firestore';
import type { FieldPath as FirestoreFieldPath, FieldValue as FirestoreFieldValue, Filter as FirestoreFilter,
  Firestore, QuerySnapshot } from 'firebase-admin/firestore';

export type DocumentStoreUnderTest = {
  db: Firestore;
  FieldValue: typeof FirestoreFieldValue;
  FieldPath: typeof FirestoreFieldPath;
  Filter: typeof FirestoreFilter;
};
export type ContractCase = { name: string; run: (root: string) => Promise<void> };

const ids = (snap: QuerySnapshot) => snap.docs.map(doc => doc.id);
async function errorCode(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return (error as { code?: unknown }).code ?? 'rejected'; }
  return 'resolved';
}

export function documentStoreContract({ db, FieldValue, FieldPath, Filter }: DocumentStoreUnderTest): ContractCase[] {
  // Five documents covering present, absent and array fields for query cases.
  async function seedQueries(root: string) {
    const q = db.collection(`${root}_q`);
    await Promise.all(([
      ['p1', { s: 'open', n: 1, tags: ['x'], t: 30, v: 'project' }],
      ['p2', { s: 'open', n: 2, tags: ['y'], t: 20, v: 'private', a: 'me' }],
      ['p3', { s: 'done', n: 3, tags: ['x', 'y'], t: 20, v: 'private', a: 'other' }],
      ['p4', { s: 'queued', n: 4, tags: [], t: 10, v: 'moderators' }],
      ['p5', { s: 'open', n: 5 }],
    ] as const).map(([id, data]) => q.doc(id).set(data)));
    return q;
  }

  return [
    { name: 'create refuses an existing document with ALREADY_EXISTS (6)', run: async root => {
      const ref = db.collection(root).doc('a');
      await ref.create({ n: 1 });
      assert.equal(await errorCode(ref.create({ n: 2 })), 6);
      assert.equal((await ref.get()).data()?.n, 1);
    } },
    { name: 'update refuses a missing document with NOT_FOUND (5)', run: async root => {
      assert.equal(await errorCode(db.collection(root).doc('missing').update({ n: 1 })), 5);
    } },
    { name: 'a missing document reads as exists=false with undefined data', run: async root => {
      const snap = await db.collection(root).doc('nope').get();
      assert.equal(snap.exists, false);
      assert.equal(snap.data(), undefined);
    } },
    { name: 'set replaces, set merge deep-merges maps, update accepts dotted paths', run: async root => {
      const ref = db.collection(root).doc('m');
      await ref.set({ a: { x: 1, y: 2 }, b: 1 });
      await ref.set({ a: { y: 3 } }, { merge: true });
      await ref.update({ 'a.z': 4 });
      assert.deepEqual((await ref.get()).data(), { a: { x: 1, y: 3, z: 4 }, b: 1 });
      await ref.set({ c: 1 });
      assert.deepEqual((await ref.get()).data(), { c: 1 });
    } },
    { name: 'FieldValue delete, increment, arrayUnion, arrayRemove and serverTimestamp', run: async root => {
      const ref = db.collection(root).doc('fv');
      await ref.set({ gone: 1, n: 1, tags: ['a', 'b'] });
      await ref.update({ gone: FieldValue.delete(), n: FieldValue.increment(2), tags: FieldValue.arrayUnion('b', 'c'),
        at: FieldValue.serverTimestamp() });
      await ref.update({ tags: FieldValue.arrayRemove('a') });
      const data = (await ref.get()).data()!;
      assert.equal('gone' in data, false);
      assert.equal(data.n, 3);
      assert.deepEqual(data.tags, ['b', 'c']);
      assert.equal(typeof data.at.toMillis(), 'number');
    } },
    { name: 'array transforms overwrite a non-array field and arrayUnion adds a repeated operand once', run: async root => {
      const ref = db.collection(root).doc('arrays');
      await ref.set({ union: 'text', remove: 7, kept: ['x'] });
      await ref.update({ union: FieldValue.arrayUnion('a', 'a'), remove: FieldValue.arrayRemove('a'),
        kept: FieldValue.arrayUnion('y', 'x', 'y'), fresh: FieldValue.arrayUnion('b', 'b') });
      assert.deepEqual((await ref.get()).data(), { union: ['a'], remove: [], kept: ['x', 'y'], fresh: ['b'] });
    } },
    { name: 'Timestamp, bytes and references round-trip at top level, inside maps and inside arrays', run: async root => {
      // Microsecond precision: Firestore stores no finer than that.
      const ts = new Timestamp(1_700_000_000, 123_456_000), bytes = Buffer.from([0, 1, 254, 255]), ref = db.doc(`${root}_other/x`);
      const doc = db.collection(root).doc('typed');
      await doc.set({ ts, bytes, ref, nested: { ts, bytes, ref, deeper: { n: 1 } }, list: [ts, bytes, ref, { ts }, null, 'x', 2.5],
        n: -1.5, big: Number.MAX_SAFE_INTEGER, empty: '', no: false, nothing: null, emptyMap: {}, emptyList: [],
        // Doubles a JSON-backed store loses. Not -0: the SDK sends it as integer 0, so Firestore itself returns 0.
        nan: Number.NaN, inf: Number.POSITIVE_INFINITY, negInf: Number.NEGATIVE_INFINITY });
      const data = (await doc.get()).data()!;
      const typed = (value: Record<string, unknown>) => {
        assert.ok(value.ts instanceof Timestamp && value.ts.isEqual(ts), 'Timestamp');
        assert.ok(Buffer.isBuffer(value.bytes) && value.bytes.equals(bytes), 'bytes');
        assert.equal((value.ref as { path?: unknown }).path, ref.path);
      };
      typed(data);
      typed(data.nested);
      assert.deepEqual(data.nested.deeper, { n: 1 });
      typed({ ts: data.list[0], bytes: data.list[1], ref: data.list[2] });
      assert.ok(data.list[3].ts instanceof Timestamp && data.list[3].ts.isEqual(ts));
      assert.deepEqual(data.list.slice(4), [null, 'x', 2.5]);
      assert.deepEqual([data.n, data.big, data.empty, data.no, data.nothing, data.emptyMap, data.emptyList],
        [-1.5, Number.MAX_SAFE_INTEGER, '', false, null, {}, []]);
      assert.deepEqual([data.nan, data.inf, data.negInf], [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    } },
    { name: 'ordinary maps shaped like an adapter encoding stay ordinary maps', run: async root => {
      const doc = db.collection(root).doc('tags');
      const value = { a: { __k42: 'ts', s: 123, n: 0 }, b: { __k42: 'bytes', b: 'AA==' }, c: { __k42: 'ref', p: 'x/y' },
        d: { $type: 'timestamp', value: 1 }, e: [{ __k42: 'ts', s: 1, n: 0 }], f: { seconds: 1, nanoseconds: 0 } };
      await doc.set(value);
      assert.deepEqual((await doc.get()).data(), value);
      assert.deepEqual(ids(await db.collection(root).where('a.__k42', '==', 'ts').get()), ['tags']);
    } },
    { name: 'set keeps dotted and unicode keys as literal fields; update reaches them with FieldPath', run: async root => {
      const doc = db.collection(root).doc('keys');
      await doc.set({ 'a.b': 1, 'ü ñ': 2, 'emoji 😀': 3, ' ': 4 });
      await doc.update(new FieldPath('a.b'), 5);
      assert.deepEqual((await doc.get()).data(), { 'a.b': 5, 'ü ñ': 2, 'emoji 😀': 3, ' ': 4 });
    } },
    { name: 'ordinary maps resembling FieldValue sentinels remain stored maps', run: async root => {
      const doc = db.collection(root).doc('sentinel-shaped');
      const value = { deletion: { methodName: 'FieldValue.delete' }, increment: { methodName: 'FieldValue.increment', operand: 5 },
        list: [{ methodName: 'FieldValue.serverTimestamp' }] };
      await doc.set(value);
      assert.deepEqual((await doc.get()).data(), value);
      await doc.set({ increment: { operand: 7 } }, { merge: true });
      assert.deepEqual((await doc.get()).data(), { ...value, increment: { methodName: 'FieldValue.increment', operand: 7 } });
    } },
    { name: 'prototype-named own fields are ordinary data and ordering excludes missing fields', run: async root => {
      const c = db.collection(root);
      await c.doc('missing').set({ other: 1 });
      await c.doc('own').set({ constructor: { n: 2 }, toString: 'stored', hasOwnProperty: true });
      assert.deepEqual((await c.doc('own').get()).data(), { constructor: { n: 2 }, toString: 'stored', hasOwnProperty: true });
      assert.deepEqual(ids(await c.orderBy('toString').get()), ['own']);
      assert.deepEqual((await c.select('constructor').get()).docs.map(doc => [doc.id, doc.data()]), [
        ['missing', {}], ['own', { constructor: { n: 2 } }],
      ]);
    } },
    { name: '== null matches stored nulls only, not missing fields', run: async root => {
      const c = db.collection(root);
      await Promise.all([c.doc('n').set({ revokedAt: null }), c.doc('v').set({ revokedAt: 5 }), c.doc('m').set({ other: 1 })]);
      assert.deepEqual(ids(await c.where('revokedAt', '==', null).get()), ['n']);
    } },
    { name: 'where ==, in and array-contains', run: async root => {
      const q = await seedQueries(root);
      const byId = FieldPath.documentId();
      assert.deepEqual(ids(await q.where('s', '==', 'open').orderBy(byId).get()), ['p1', 'p2', 'p5']);
      assert.deepEqual(ids(await q.where('s', 'in', ['done', 'queued']).orderBy(byId).get()), ['p3', 'p4']);
      assert.deepEqual(ids(await q.where('tags', 'array-contains', 'x').orderBy(byId).get()), ['p1', 'p3']);
    } },
    { name: 'range operators <, <=, > and >=', run: async root => {
      const q = await seedQueries(root);
      assert.deepEqual(ids(await q.where('n', '<', 2).get()), ['p1']);
      assert.deepEqual(ids(await q.where('n', '<=', 2).get()), ['p1', 'p2']);
      assert.deepEqual(ids(await q.where('n', '>', 3).get()), ['p4', 'p5']);
      assert.deepEqual(ids(await q.where('n', '>=', 3).where('n', '<=', 4).get()), ['p3', 'p4']);
    } },
    { name: 'Filter.or of Filter.and composes as in human-request visibility', run: async root => {
      const q = await seedQueries(root);
      const visible = Filter.or(Filter.where('v', '==', 'project'),
        Filter.and(Filter.where('v', '==', 'private'), Filter.where('a', '==', 'me')));
      assert.deepEqual(ids(await q.where(visible).orderBy(FieldPath.documentId()).get()), ['p1', 'p2']);
    } },
    { name: 'orderBy desc with documentId tiebreak excludes documents missing the order field', run: async root => {
      const q = await seedQueries(root);
      assert.deepEqual(ids(await q.orderBy('t', 'desc').orderBy(FieldPath.documentId()).get()), ['p1', 'p2', 'p3', 'p4']);
      assert.deepEqual(ids(await q.orderBy('t', 'desc').orderBy(FieldPath.documentId(), 'desc').get()), ['p1', 'p3', 'p2', 'p4']);
      // Public thread pages look for a newer message with endAt over this descending pair.
      const newestFirst = q.orderBy('t', 'desc').orderBy(FieldPath.documentId(), 'desc');
      assert.deepEqual(ids(await newestFirst.endAt(20, 'p2').get()), ['p1', 'p3', 'p2']);
      assert.deepEqual(ids(await newestFirst.endAt(20, 'p3').limit(1).get()), ['p1']);
      assert.deepEqual(ids(await newestFirst.startAt(20, 'p2').get()), ['p2', 'p4']);
    } },
    { name: 'limit with startAfter by values, by snapshot and by document id', run: async root => {
      const q = await seedQueries(root);
      const ordered = q.orderBy('t', 'desc').orderBy(FieldPath.documentId());
      const first = await ordered.limit(2).get();
      assert.deepEqual(ids(first), ['p1', 'p2']);
      assert.deepEqual(ids(await ordered.startAfter(20, 'p2').limit(2).get()), ['p3', 'p4']);
      assert.deepEqual(ids(await ordered.startAfter(first.docs[1]).limit(2).get()), ['p3', 'p4']);
      assert.deepEqual(ids(await q.orderBy(FieldPath.documentId()).startAfter('p3').get()), ['p4', 'p5']);
    } },
    { name: 'count() aggregates a filtered query', run: async root => {
      const q = await seedQueries(root);
      assert.equal((await q.where('s', '==', 'open').count().get()).data().count, 3);
    } },
    { name: 'select() returns only the projected fields', run: async root => {
      const q = await seedQueries(root);
      assert.deepEqual((await q.where('s', '==', 'done').select('n').get()).docs[0].data(), { n: 3 });
    } },
    { name: 'get() on a projected snapshot answers only projected fields, for select() and a getAll fieldMask', run: async root => {
      const q = await seedQueries(root);
      const selected = (await q.where('s', '==', 'done').select('n').get()).docs[0];
      assert.deepEqual([selected.get('n'), selected.get('s')], [3, undefined]);
      const ref = db.collection(root).doc('masked');
      await ref.set({ keep: 1, nested: { x: 1, y: 2 }, drop: 'secret' });
      const [masked] = await db.getAll(ref, { fieldMask: ['keep', new FieldPath('nested', 'x')] });
      assert.deepEqual([masked.get('keep'), masked.get('nested.x'), masked.get('nested.y'), masked.get('drop')], [1, 1, undefined, undefined]);
      assert.deepEqual(masked.get('nested'), { x: 1 });
    } },
    { name: 'select() with no fields returns ids with empty data; count() honours limit', run: async root => {
      const q = await seedQueries(root);
      const keys = await q.where('s', '==', 'open').orderBy(FieldPath.documentId()).select().get();
      assert.deepEqual(keys.docs.map(doc => [doc.id, doc.exists, doc.data()]), [['p1', true, {}], ['p2', true, {}], ['p5', true, {}]]);
      assert.equal((await q.limit(2).count().get()).data().count, 2);
      assert.equal((await q.where('s', '==', 'open').limit(10).count().get()).data().count, 3);
      assert.equal((await q.where('s', '==', 'open').limit(2).count().get()).data().count, 2);
    } },
    { name: 'getAll keeps argument order and reports missing documents', run: async root => {
      const q = await seedQueries(root);
      const snaps = await db.getAll(q.doc('p3'), q.doc('zz'), q.doc('p1'));
      assert.deepEqual(snaps.map(snap => [snap.id, snap.exists]), [['p3', true], ['zz', false], ['p1', true]]);
    } },
    { name: 'collectionGroup spans subcollections sharing an id', run: async root => {
      const group = `${root}_agents`, projects = db.collection(`${root}_projects`);
      await Promise.all([
        projects.doc('A').collection(group).doc('a1').set({ owner: 'o1', revokedAt: null }),
        projects.doc('B').collection(group).doc('b1').set({ owner: 'o1', revokedAt: null }),
        projects.doc('B').collection(group).doc('b2').set({ owner: 'o2', revokedAt: null }),
      ]);
      const snap = await db.collectionGroup(group).where('owner', '==', 'o1').where('revokedAt', '==', null)
        .orderBy(FieldPath.documentId()).get();
      assert.deepEqual(snap.docs.map(doc => doc.ref.path), [`${root}_projects/A/${group}/a1`, `${root}_projects/B/${group}/b1`]);
    } },
    { name: 'documentId cursors bound a range with startAt, endBefore and endAt as in fanout jobs', run: async root => {
      const q = await seedQueries(root);
      const byId = q.orderBy(FieldPath.documentId());
      assert.deepEqual(ids(await byId.startAt('p2').endBefore('p4').get()), ['p2', 'p3']);
      assert.deepEqual(ids(await byId.endAt('p2').limit(5).get()), ['p1', 'p2']);
      // Firestore refuses a descending scan on the document id alone (FAILED_PRECONDITION), so desc is only
      // ever used after another order field, as in 'orderBy desc with documentId tiebreak' above.
      assert.deepEqual(ids(await byId.startAfter('p2').endBefore('p5').get()), ['p3', 'p4']);
      // reserveFanoutRound bounds a shard with id prefixes that need not exist (engine-claude-6's shape).
      assert.deepEqual(ids(await byId.startAt('p25').endBefore('p45').get()), ['p3', 'p4']);
      assert.deepEqual(ids(await byId.startAfter('p9').get()), []);
      assert.deepEqual(ids(await q.where(FieldPath.documentId(), '==', 'p3').get()), ['p3']);
      assert.deepEqual(ids(await q.where(FieldPath.documentId(), 'in', ['p4', 'p1']).orderBy(FieldPath.documentId()).get()), ['p1', 'p4']);
    } },
    { name: 'array-contains-any matches documents holding any listed element', run: async root => {
      const q = await seedQueries(root);
      assert.deepEqual(ids(await q.where('tags', 'array-contains-any', ['y', 'z']).orderBy(FieldPath.documentId()).get()), ['p2', 'p3']);
    } },
    { name: 'limitToLast returns the last documents in query order', run: async root => {
      const q = await seedQueries(root);
      assert.deepEqual(ids(await q.orderBy('n').limitToLast(2).get()), ['p4', 'p5']);
      assert.deepEqual(ids(await q.orderBy('n', 'desc').limitToLast(2).get()), ['p2', 'p1']);
    } },
    { name: 'cursors on a two-field order compare every value in turn', run: async root => {
      const q = await seedQueries(root);
      const ordered = q.orderBy('s').orderBy('n', 'desc');
      assert.deepEqual(ids(await ordered.get()), ['p3', 'p5', 'p2', 'p1', 'p4']);
      assert.deepEqual(ids(await ordered.startAfter('open', 5).get()), ['p2', 'p1', 'p4']);
      assert.deepEqual(ids(await ordered.startAt('open').get()), ['p5', 'p2', 'p1', 'p4']);
      assert.deepEqual(ids(await ordered.endBefore('open', 1).get()), ['p3', 'p5', 'p2']);
    } },
    { name: 'set merge with a nested FieldValue.delete removes only that leaf', run: async root => {
      const ref = db.collection(root).doc('md');
      await ref.set({ a: { x: 1, y: 1 }, b: 1 });
      await ref.set({ a: { x: FieldValue.delete() } }, { merge: true });
      assert.deepEqual((await ref.get()).data(), { a: { y: 1 }, b: 1 });
    } },
    { name: 'arrayUnion and arrayRemove compare maps by value', run: async root => {
      const ref = db.collection(root).doc('arr');
      await ref.set({ list: [{ k: 1 }] });
      await ref.update({ list: FieldValue.arrayUnion({ k: 1 }, { k: 2 }) });
      assert.deepEqual((await ref.get()).data()?.list, [{ k: 1 }, { k: 2 }]);
      await ref.update({ list: FieldValue.arrayRemove({ k: 1 }) });
      assert.deepEqual((await ref.get()).data()?.list, [{ k: 2 }]);
    } },
    { name: 'select() on a nested field path projects only that leaf', run: async root => {
      const c = db.collection(`${root}_sel`);
      await c.doc('a').set({ m: { a: 1, b: 2 }, n: 1 });
      assert.deepEqual((await c.select('m.a').get()).docs[0].data(), { m: { a: 1 } });
    } },
    { name: 'recursiveDelete removes a document with its subcollections and nothing else', run: async root => {
      const c = db.collection(root);
      await Promise.all([c.doc('gone').set({ n: 1 }), c.doc('gone').collection('sub').doc('s').set({ n: 1 }),
        c.doc('gone').collection('sub').doc('s').collection('deeper').doc('d').set({ n: 1 }), c.doc('kept').set({ n: 1 })]);
      await db.recursiveDelete(c.doc('gone'));
      const left = await Promise.all([c.doc('gone'), c.doc('gone/sub/s'), c.doc('gone/sub/s/deeper/d'), c.doc('kept')].map(ref => ref.get()));
      assert.deepEqual(left.map(snap => snap.exists), [false, false, false, true]);
    } },
    { name: 'orderBy and where reach nested map fields', run: async root => {
      const c = db.collection(`${root}_nested`);
      await Promise.all([c.doc('a').set({ m: { r: 2 } }), c.doc('b').set({ m: { r: 1 } }), c.doc('c').set({ m: {} }), c.doc('d').set({ m: 'flat' })]);
      assert.deepEqual(ids(await c.orderBy('m.r').get()), ['b', 'a']);
      assert.deepEqual(ids(await c.where('m.r', '>', 1).get()), ['a']);
    } },
    // From engine-claude-2's closed #554. The SDK's refusal has no gRPC code, so only "did not resolve" is asserted.
    { name: 'a read-only transaction reads but refuses to write', run: async root => {
      const c = db.collection(root);
      await c.doc('a').set({ n: 1 });
      const read = await db.runTransaction(async tx => (await tx.get(c.doc('a'))).data()!.n, { readOnly: true });
      assert.equal(read, 1);
      assert.notEqual(await errorCode(db.runTransaction(async tx => { tx.set(c.doc('b'), { n: 1 }); }, { readOnly: true })), 'resolved');
      assert.equal((await c.doc('b').get()).exists, false);
    } },
    { name: 'updateTime advances on a change and is unchanged by an identical write', run: async root => {
      const ref = db.collection(root).doc('times');
      await ref.set({ n: 1 });
      const first = await ref.get();
      // Rewriting identical data is a no-op: realtime.ts compares updateTime.
      const same = await ref.set({ n: 1 });
      const unchanged = await ref.get();
      const changed = await ref.set({ n: 2 });
      const latest = await ref.get();
      assert.ok(first.readTime);
      assert.ok(unchanged.updateTime!.isEqual(first.updateTime!));
      assert.ok(same.writeTime.isEqual(first.updateTime!));
      // Timestamp.valueOf() is a lexically ordered string with nanosecond precision.
      assert.ok(latest.updateTime!.valueOf() > unchanged.updateTime!.valueOf());
      assert.ok(latest.updateTime!.isEqual(changed.writeTime));
    } },
    { name: 'transaction reads with get/getAll/query then creates, updates and deletes', run: async root => {
      const q = await seedQueries(root);
      const c = db.collection(root), a = c.doc('a'), b = c.doc('b'), gone = c.doc('gone');
      await Promise.all([a.set({ n: 1 }), gone.set({ n: 9 })]);
      const open = await db.runTransaction(async tx => {
        const [sa, sb] = await tx.getAll(a, b);
        const list = await tx.get(q.where('s', '==', 'open'));
        tx.update(a, { n: sa.data()!.n + 1 });
        tx.create(b, { existed: sb.exists });
        tx.delete(gone);
        return list.size;
      });
      assert.equal(open, 3);
      assert.equal((await a.get()).data()?.n, 2);
      assert.equal((await b.get()).data()?.existed, false);
      assert.equal((await gone.get()).exists, false);
    } },
    { name: 'transaction refuses reads after writes and commits nothing', run: async root => {
      const ref = db.collection(root).doc('rw');
      assert.notEqual(await errorCode(db.runTransaction(async tx => { tx.set(ref, { n: 1 }); await tx.get(ref); })), 'resolved');
      assert.equal((await ref.get()).exists, false);
    } },
    { name: 'transaction rolls back every write when its function throws', run: async root => {
      const ref = db.collection(root).doc('rb');
      await assert.rejects(db.runTransaction(async tx => { tx.set(ref, { n: 1 }); throw new Error('stop'); }), /stop/);
      assert.equal((await ref.get()).exists, false);
    } },
    { name: 'transaction with a conflicting create fails as a whole', run: async root => {
      const c = db.collection(root);
      await c.doc('taken').set({ n: 1 });
      assert.notEqual(await errorCode(db.runTransaction(async tx => {
        tx.set(c.doc('other'), { n: 1 });
        tx.create(c.doc('taken'), { n: 2 });
      })), 'resolved');
      assert.equal((await c.doc('other').get()).exists, false);
    } },
    { name: 'concurrent read-increment transactions serialize', run: async root => {
      const ref = db.collection(root).doc('counter');
      await ref.set({ n: 0 });
      await Promise.all(Array.from({ length: 10 }, () => db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        tx.update(ref, { n: snap.data()!.n + 1 });
      })));
      assert.equal((await ref.get()).data()?.n, 10);
    } },
    // reserveFanoutRound caps outstanding work with tx.get(query.count()) and then
    // writes disjoint documents: detecting only document conflicts permits write skew.
    { name: 'concurrent transactions gated by a count() predicate do not write-skew', run: async root => {
      const jobs = db.collection(root);
      await Promise.all(Array.from({ length: 6 }, (_, i) => db.runTransaction(async tx => {
        const live = (await tx.get(jobs.where('status', '==', 'live').count())).data().count;
        if (live < 2) tx.create(jobs.doc(`job${i}`), { status: 'live' });
      })));
      assert.equal((await jobs.where('status', '==', 'live').count().get()).data().count, 2);
    } },
    // fanout-jobs walks project ids round-robin with documentId cursors that need not name existing documents.
    { name: 'documentId cursors: startAt, startAfter, endBefore and endAt bound a range', run: async root => {
      const c = db.collection(root);
      await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => c.doc(id).set({ n: 1 })));
      const ordered = c.orderBy(FieldPath.documentId());
      assert.deepEqual(ids(await ordered.startAt('b').endBefore('d').get()), ['b', 'c']);
      assert.deepEqual(ids(await ordered.startAfter('b').endAt('d').get()), ['c', 'd']);
      assert.deepEqual(ids(await ordered.startAt('bb').endAt('cc').get()), ['c']);
      assert.deepEqual(ids(await ordered.endAt('c').limit(2).get()), ['a', 'b']);
      assert.deepEqual(ids(await ordered.startAfter('e').get()), []);
    } },
    // conversation-source pages newest first with startAt/startAfter(createdAt, id).
    { name: 'multi-field cursors on a descending order include or exclude the boundary; a partial cursor matches a prefix', run: async root => {
      const c = db.collection(root);
      await Promise.all(([['m1', 10], ['m2', 20], ['m3', 20], ['m4', 30]] as const).map(([id, t]) => c.doc(id).set({ createdAt: t })));
      const desc = c.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
      assert.deepEqual(ids(await desc.get()), ['m4', 'm3', 'm2', 'm1']);
      assert.deepEqual(ids(await desc.startAt(20, 'm3').limit(2).get()), ['m3', 'm2']);
      assert.deepEqual(ids(await desc.startAfter(20, 'm3').get()), ['m2', 'm1']);
      assert.deepEqual(ids(await desc.startAt(20).get()), ['m3', 'm2', 'm1']);
      assert.deepEqual(ids(await desc.endBefore(20, 'm2').get()), ['m4', 'm3']);
    } },
    { name: 'an inequality filter orders by its field before limit; __name__ orders like documentId; in combines with orderBy', run: async root => {
      const q = await seedQueries(root);
      assert.deepEqual(ids(await q.where('t', '<', 30).limit(2).get()), ['p4', 'p2']);
      assert.deepEqual(ids(await q.where('s', '==', 'open').orderBy('__name__', 'desc').get()), ['p5', 'p2', 'p1']);
      assert.deepEqual(ids(await q.where('n', 'in', [5, 1, 3]).orderBy('n', 'desc').get()), ['p5', 'p3', 'p1']);
    } },
    { name: 'orderBy sorts mixed value types in Firestore type order and range filters stay within one type', run: async root => {
      const c = db.collection(root);
      const values: Record<string, unknown> = { a: null, b: false, c: true, d: -1, e: 0.5, f: 2, g: new Timestamp(1, 0), h: '', i: 'a',
        j: Buffer.from([1]), k: db.doc(`${root}/k`), l: [1], m: { x: 1 } };
      await Promise.all(Object.entries(values).map(([id, v]) => c.doc(id).set({ v })));
      assert.deepEqual(ids(await c.orderBy('v').get()), Object.keys(values));
      assert.deepEqual(ids(await c.where('v', '>=', 0).get()), ['e', 'f']);
      assert.deepEqual(ids(await c.where('v', '>', '').get()), ['i']);
      assert.deepEqual(ids(await c.where('v', '==', 2.0).get()), ['f']);
    } },
    // Presence writers use mergeFields so each replaces only its own groups (v2/runs.ts, worker-sessions.ts).
    { name: 'set with mergeFields replaces listed fields whole, ignores unlisted input and creates a missing document', run: async root => {
      const ref = db.collection(root).doc('presence');
      await ref.set({ run: { id: 'r1', at: 1 }, worker: { pid: 7 }, keep: 1 });
      await ref.set({ run: { id: 'r2' }, worker: { pid: 8 }, ignored: true }, { mergeFields: ['run'] });
      assert.deepEqual((await ref.get()).data(), { run: { id: 'r2' }, worker: { pid: 7 }, keep: 1 });
      await ref.set({ worker: { pid: 9, host: 'h' } }, { mergeFields: ['worker.host'] });
      assert.deepEqual((await ref.get()).data(), { run: { id: 'r2' }, worker: { pid: 7, host: 'h' }, keep: 1 });
      await ref.set({ endedAt: FieldValue.serverTimestamp(), other: 1 }, { mergeFields: ['endedAt'] });
      const data = (await ref.get()).data()!;
      assert.ok(data.endedAt instanceof Timestamp);
      assert.equal('other' in data, false);
      const fresh = db.collection(root).doc('new');
      await fresh.set({ a: 1, b: 2 }, { mergeFields: ['a'] });
      assert.deepEqual((await fresh.get()).data(), { a: 1 });
    } },
    { name: 'update replaces a map value whole; merge-set and dotted update accept FieldValue.delete; deleting a missing document succeeds', run: async root => {
      const ref = db.collection(root).doc('u');
      await ref.set({ a: { x: 1, y: 2 }, b: 1, c: 1 });
      await ref.update({ a: { z: 3 } });
      await ref.set({ b: FieldValue.delete() }, { merge: true });
      assert.deepEqual((await ref.get()).data(), { a: { z: 3 }, c: 1 });
      await ref.update({ 'a.z': FieldValue.delete() });
      assert.deepEqual((await ref.get()).data(), { a: {}, c: 1 });
      const never = db.collection(root).doc('never');
      await never.delete();
      assert.equal((await never.get()).exists, false);
    } },
    { name: 'increment starts missing or non-numeric fields from the operand and mixes integers with doubles', run: async root => {
      const ref = db.collection(root).doc('inc');
      await ref.set({ s: 'text', i: 1 });
      await ref.update({ missing: FieldValue.increment(2), s: FieldValue.increment(3), i: FieldValue.increment(0.5),
        'nested.n': FieldValue.increment(1) });
      assert.deepEqual((await ref.get()).data(), { s: 3, i: 1.5, missing: 2, nested: { n: 1 } });
      await db.collection(root).doc('merged').set({ created: FieldValue.increment(4) }, { merge: true });
      assert.equal((await db.collection(root).doc('merged').get()).data()!.created, 4);
    } },
    // The hosted SDK runs without ignoreUndefinedProperties, so a write carrying undefined is a bug that must
    // fail on every store rather than silently dropping the field on one of them.
    { name: 'writes containing undefined are refused and change nothing', run: async root => {
      const ref = db.collection(root).doc('undef');
      await ref.set({ n: 1 });
      for (const write of [() => ref.set({ n: 2, gone: undefined }), () => ref.set({ m: { x: undefined } }, { merge: true }),
        () => ref.update({ n: undefined }), () => ref.set({ list: [1, undefined] }), () => db.collection(root).doc('new').create({ a: undefined }),
        () => ref.update({ list: FieldValue.arrayUnion(undefined) })]) {
        assert.notEqual(await errorCode(Promise.resolve().then(write)), 'resolved');
      }
      assert.deepEqual((await ref.get()).data(), { n: 1 });
      assert.equal((await db.collection(root).doc('new').get()).exists, false);
    } },
    // The SDK refuses a FieldValue sentinel anywhere inside an array, so a store that resolved it would let code
    // pass self-hosted that fails on Firestore.
    { name: 'FieldValue sentinels inside an array are refused and change nothing', run: async root => {
      const ref = db.collection(root).doc('arr');
      await ref.set({ n: 1 });
      for (const write of [() => ref.set({ list: [FieldValue.serverTimestamp()] }), () => ref.set({ list: [{ at: FieldValue.increment(1) }] }, { merge: true }),
        () => ref.update({ list: [1, [FieldValue.arrayUnion(2)]] }), () => ref.update({ list: [FieldValue.delete()] }),
        () => ref.update({ list: FieldValue.arrayUnion(FieldValue.serverTimestamp()) }), () => ref.set({ list: FieldValue.arrayRemove({ at: FieldValue.increment(1) }) }, { merge: true }),
        () => db.collection(root).doc('new').create({ m: { list: [FieldValue.serverTimestamp()] } })]) {
        assert.notEqual(await errorCode(Promise.resolve().then(write)), 'resolved');
      }
      assert.deepEqual((await ref.get()).data(), { n: 1 });
      assert.equal((await db.collection(root).doc('new').get()).exists, false);
    } },
    // An empty map is a leaf value in a merge: Firestore writes it, replacing whatever map the field held.
    { name: 'set merge with an empty map replaces an existing map and creates a missing field', run: async root => {
      const ref = db.collection(root).doc('em');
      await ref.set({ keep: { x: 1 }, deep: { a: { b: 1 }, c: 2 } });
      await ref.set({ keep: {}, made: {}, deep: { a: {} } }, { merge: true });
      assert.deepEqual((await ref.get()).data(), { keep: {}, made: {}, deep: { a: {}, c: 2 } });
      // A map merged onto a typed value replaces it rather than merging into it.
      const typed = db.collection(root).doc('typed');
      await typed.set({ ts: new Timestamp(1, 0), bytes: Buffer.from([1]), ref: db.doc(`${root}/x`), list: [1] });
      await typed.set({ ts: { a: 1 }, bytes: { b: 1 }, ref: { c: 1 }, list: { d: 1 } }, { merge: true });
      assert.deepEqual((await typed.get()).data(), { ts: { a: 1 }, bytes: { b: 1 }, ref: { c: 1 }, list: { d: 1 } });
    } },
    { name: 'a dotted update through a typed value replaces it with a map; deleting through a missing parent creates nothing', run: async root => {
      const ref = db.collection(root).doc('dotted');
      await ref.set({ bytes: Buffer.from([1]), ref: db.doc(`${root}/x`), ts: new Timestamp(1, 0), n: 1 });
      await ref.update({ 'bytes.x': 1, 'ref.y': 2, 'ts.z': 3 });
      await ref.update({ 'missing.deeper': FieldValue.delete(), 'n': 2 });
      await ref.set({ absent: { x: FieldValue.delete() }, bytes: { gone: FieldValue.delete() } }, { merge: true });
      assert.deepEqual((await ref.get()).data(), { bytes: { x: 1 }, ref: { y: 2 }, ts: { z: 3 }, n: 2 });
      const scalar = db.collection(root).doc('scalar');
      await scalar.set({ b: Buffer.from([1]), n: 1 });
      await scalar.set({ b: { x: FieldValue.delete() }, n: { y: FieldValue.delete() } }, { merge: true });
      await scalar.update({ 'b.x': FieldValue.delete(), 'n.y': FieldValue.delete() });
      const kept = (await scalar.get()).data()!;
      assert.ok(Buffer.isBuffer(kept.b) && kept.b.equals(Buffer.from([1])));
      assert.equal(kept.n, 1);
    } },
    // The emulator does not make serverTimestamp equal to updateTime, so the contract does not require it.
    { name: 'serverTimestamp fields written together share one time, nested ones included; a create sets createTime = updateTime', run: async root => {
      const ref = db.collection(root).doc('st');
      await ref.create({ a: FieldValue.serverTimestamp(), m: { b: FieldValue.serverTimestamp() }, list: [1] });
      const snap = await ref.get(), data = snap.data()!;
      assert.ok(data.a instanceof Timestamp && data.m.b instanceof Timestamp);
      assert.ok(data.a.isEqual(data.m.b));
      assert.ok(snap.createTime!.isEqual(snap.updateTime!));
      await ref.update({ list: [2] });
      const later = await ref.get();
      assert.ok(later.createTime!.isEqual(snap.createTime!));
      assert.ok(later.updateTime!.valueOf() > snap.updateTime!.valueOf());
    } },
    { name: 'onSnapshot on a document reports it missing, created, changed and deleted', run: async root => {
      const ref = db.collection(root).doc('watched');
      const events: string[] = [];
      let wake = () => {};
      let next = new Promise<void>(resolve => { wake = resolve; });
      const stop = ref.onSnapshot(snap => { events.push(snap.exists ? `n=${snap.data()!.n}` : 'missing'); wake(); },
        error => { events.push(`error:${error.message}`); wake(); });
      const settle = async () => {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([next, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no snapshot after ${JSON.stringify(events)}`)), 5000);
        })]).finally(() => clearTimeout(timer));
        next = new Promise<void>(resolve => { wake = resolve; });
      };
      try {
        await settle();
        await ref.set({ n: 1 }); await settle();
        await ref.update({ n: 2 }); await settle();
        await ref.delete(); await settle();
        assert.deepEqual(events, ['missing', 'n=1', 'n=2', 'missing']);
      } finally { stop(); }
    } },
    { name: 'onSnapshot on a bounded query reports added, modified and removed including window eviction', run: async root => {
      const live = db.collection(root);
      await live.doc('a').set({ k: 1, t: 1 });
      await live.doc('b').set({ k: 1, t: 2 });
      const events: string[] = [];
      let wake = () => {};
      let next = new Promise<void>(resolve => { wake = resolve; });
      const stop = live.where('k', '==', 1).orderBy('t', 'desc').limit(2).onSnapshot(snap => {
        assert.ok(snap.readTime);
        events.push(snap.docChanges().map(change => `${change.type}:${change.doc.id}`).sort().join(','));
        wake();
      }, error => { events.push(`error:${error.message}`); wake(); });
      const settle = async () => {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([next, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no snapshot after ${JSON.stringify(events)}`)), 5000);
        })]).finally(() => clearTimeout(timer));
        next = new Promise<void>(resolve => { wake = resolve; });
      };
      try {
        await settle();
        await live.doc('a').update({ x: 1 }); await settle();
        await live.doc('c').set({ k: 1, t: 3 }); await settle();
        await live.doc('c').delete(); await settle();
        assert.deepEqual(events, ['added:a,added:b', 'modified:a', 'added:c,removed:a', 'added:a,removed:c']);
      } finally { stop(); }
    } },
    { name: 'strings order by UTF-8 bytes, so supplementary characters sort after U+E000', run: async root => {
      const c = db.collection(root);
      // UTF-16 code units would put the emoji (0xD83D…) before U+E000; Firestore compares the UTF-8 encoding.
      await Promise.all([c.doc('ascii').set({ s: 'z' }), c.doc('private').set({ s: '\ue000' }), c.doc('emoji').set({ s: '\u{1F600}' })]);
      assert.deepEqual(ids(await c.orderBy('s').get()), ['ascii', 'private', 'emoji']);
      assert.deepEqual(ids(await c.where('s', '>', '\ue000').get()), ['emoji']);
    } },
    { name: 'orderBy across mixed types follows Firestore type order', run: async root => {
      const c = db.collection(root);
      await Promise.all(([
        ['a-map', { v: { a: 1 } }], ['b-array', { v: [1] }], ['c-ref', { v: db.doc(`${root}/x`) }], ['d-bytes', { v: Buffer.from([1]) }],
        ['e-string', { v: 's' }], ['f-time', { v: Timestamp.fromMillis(1) }], ['g-num', { v: 2.5 }], ['h-int', { v: -1 }],
        ['i-nan', { v: NaN }], ['j-bool', { v: true }], ['k-null', { v: null }],
      ] as const).map(([id, data]) => c.doc(id).set(data)));
      assert.deepEqual(ids(await c.orderBy('v').get()),
        ['k-null', 'j-bool', 'i-nan', 'h-int', 'g-num', 'f-time', 'e-string', 'd-bytes', 'c-ref', 'b-array', 'a-map']);
    } },
    { name: 'range filters match only the same type and never NaN; == NaN finds NaN', run: async root => {
      const c = db.collection(root);
      await Promise.all([c.doc('one').set({ n: 1 }), c.doc('three').set({ n: 3 }), c.doc('nan').set({ n: NaN }),
        c.doc('text').set({ n: '2' }), c.doc('nul').set({ n: null }), c.doc('yes').set({ n: true })]);
      assert.deepEqual(ids(await c.where('n', '<', 5).get()), ['one', 'three']);
      assert.deepEqual(ids(await c.where('n', '>=', -Infinity).get()), ['one', 'three']);
      assert.deepEqual(ids(await c.where('n', '==', NaN).get()), ['nan']);
    } },
    { name: '-0 and 0 are equal in filters', run: async root => {
      const c = db.collection(root);
      await Promise.all([c.doc('neg').set({ z: -0 }), c.doc('pos').set({ z: 0 }), c.doc('one').set({ z: 1 })]);
      assert.deepEqual(ids(await c.where('z', '==', 0).get()), ['neg', 'pos']);
      assert.deepEqual(ids(await c.where('z', 'in', [-0]).get()), ['neg', 'pos']);
    } },
    { name: 'map equality ignores key order; array equality and array-contains respect elements', run: async root => {
      const c = db.collection(root);
      await Promise.all([c.doc('ab').set({ m: { a: 1, b: 2 }, l: [1, 2] }), c.doc('ba').set({ m: { b: 2, a: 1 }, l: [2, 1] }),
        c.doc('a').set({ m: { a: 1 }, l: [{ a: 1 }] })]);
      assert.deepEqual(ids(await c.where('m', '==', { b: 2, a: 1 }).get()), ['ab', 'ba']);
      assert.deepEqual(ids(await c.where('l', '==', [1, 2]).get()), ['ab']);
      assert.deepEqual(ids(await c.where('l', 'array-contains', { a: 1 }).get()), ['a']);
    } },
    { name: 'in matches by exact type; != and not-in exclude missing fields and nulls', run: async root => {
      const c = db.collection(root);
      await Promise.all([c.doc('num').set({ v: 1 }), c.doc('str').set({ v: '1' }), c.doc('bool').set({ v: true }),
        c.doc('nul').set({ v: null }), c.doc('missing').set({ other: 1 })]);
      assert.deepEqual(ids(await c.where('v', 'in', [1, '1']).get()), ['num', 'str']);
      assert.deepEqual(ids(await c.where('v', '!=', 1).get()), ['bool', 'str']);
      assert.deepEqual(ids(await c.where('v', 'not-in', [1, true]).get()), ['str']);
    } },
    // reserveFanoutRound pages projects with startAt/endBefore/endAt; conversation-source resumes with startAt.
    { name: 'startAt and endAt include their cursor; startAfter and endBefore exclude it', run: async root => {
      const q = await seedQueries(root);
      const byN = q.orderBy('n'), byId = q.orderBy(FieldPath.documentId());
      assert.deepEqual(ids(await byN.startAt(2).get()), ['p2', 'p3', 'p4', 'p5']);
      assert.deepEqual(ids(await byN.endAt(3).get()), ['p1', 'p2', 'p3']);
      assert.deepEqual(ids(await byN.endBefore(3).get()), ['p1', 'p2']);
      assert.deepEqual(ids(await byN.startAt(2).endBefore(4).get()), ['p2', 'p3']);
      assert.deepEqual(ids(await byN.startAfter(2).endAt(4).limit(1).get()), ['p3']);
      assert.deepEqual(ids(await byId.startAt('p2').endAt('p4').get()), ['p2', 'p3', 'p4']);
      assert.deepEqual(ids(await byId.endBefore('p2').get()), ['p1']);
      // A cursor value between stored values, and one per orderBy over a tie.
      assert.deepEqual(ids(await byN.startAt(2.5).endAt(4.5).get()), ['p3', 'p4']);
      const byT = q.orderBy('t', 'desc').orderBy(FieldPath.documentId());
      assert.deepEqual(ids(await byT.startAt(20, 'p3').get()), ['p3', 'p4']);
      assert.deepEqual(ids(await byT.endAt(20, 'p2').get()), ['p1', 'p2']);
      assert.deepEqual(ids(await byT.endBefore(20, 'p2').get()), ['p1']);
    } },
    // Presence writes use set(..., { mergeFields }) so concurrent writers keep each other's fields.
    { name: 'set with mergeFields writes only the listed fields and replaces a listed map whole', run: async root => {
      const ref = db.collection(root).doc('mf');
      await ref.set({ a: { x: 1, y: 2 }, b: 1, c: 1 });
      await ref.set({ a: { z: 3 }, b: 2, c: 99 }, { mergeFields: ['a', 'b'] });
      assert.deepEqual((await ref.get()).data(), { a: { z: 3 }, b: 2, c: 1 });
      await ref.set({ a: { y: 5, w: 6 } }, { mergeFields: ['a.y'] });
      assert.deepEqual((await ref.get()).data(), { a: { z: 3, y: 5 }, b: 2, c: 1 });
      const fresh = db.collection(root).doc('mf-new');
      await db.runTransaction(async tx => { tx.set(fresh, { kept: 1, dropped: 2 }, { mergeFields: ['kept'] }); });
      assert.deepEqual((await fresh.get()).data(), { kept: 1 });
    } },
    { name: 'update replaces a map value whole, unlike set merge', run: async root => {
      const ref = db.collection(root).doc('um');
      await ref.set({ a: { x: 1, y: 2 }, b: 1 });
      await ref.update({ a: { z: 3 } });
      assert.deepEqual((await ref.get()).data(), { a: { z: 3 }, b: 1 });
    } },
    { name: 'a batch commits all of its writes or none of them', run: async root => {
      const c = db.collection(root);
      await c.doc('taken').set({ n: 1 });
      const failing = db.batch();
      failing.set(c.doc('fresh'), { n: 1 });
      failing.update(c.doc('taken'), { n: 2 });
      failing.update(c.doc('absent'), { n: 1 });
      assert.equal(await errorCode(failing.commit()), 5);
      const conflicting = db.batch();
      conflicting.set(c.doc('fresh'), { n: 1 });
      conflicting.create(c.doc('taken'), { n: 3 });
      assert.equal(await errorCode(conflicting.commit()), 6);
      assert.equal((await c.doc('fresh').get()).exists, false);
      assert.deepEqual((await c.doc('taken').get()).data(), { n: 1 });
      const ok = db.batch();
      ok.set(c.doc('fresh'), { n: 1 }); ok.update(c.doc('taken'), { n: 2 }); ok.delete(c.doc('absent'));
      await ok.commit();
      assert.deepEqual([(await c.doc('fresh').get()).data(), (await c.doc('taken').get()).data()], [{ n: 1 }, { n: 2 }]);
    } },
    // Field values are covered above; document ids are compared the same way (UTF-8, not UTF-16 code units).
    { name: 'document ids order by UTF-8 bytes', run: async root => {
      const c = db.collection(root);
      await Promise.all(['\u{1F600}', '\ue000', 'z'].map(id => c.doc(id).set({ n: 1 })));
      assert.deepEqual(ids(await c.orderBy(FieldPath.documentId()).get()), ['z', '\ue000', '\u{1F600}']);
      assert.deepEqual(ids(await c.orderBy(FieldPath.documentId()).startAfter('\ue000').get()), ['\u{1F600}']);
    } },
    { name: 'deleting a document leaves its subcollections in place', run: async root => {
      const parent = db.collection(root).doc('parent'), child = parent.collection('kids').doc('k');
      await parent.set({ n: 1 });
      await child.set({ n: 2 });
      await parent.delete();
      assert.equal((await parent.get()).exists, false);
      assert.deepEqual((await child.get()).data(), { n: 2 });
      assert.deepEqual(ids(await parent.collection('kids').get()), ['k']);
    } },
    // realtime.ts watches a filtered, ordered, limited query: an update that moves a document out of or into the
    // filter must arrive as removed/added, writes outside it must not, and its change times are compared to readTime.
    { name: 'a filtered query listener sees documents leave and join by update, ignores outside writes, and advances readTime', run: async root => {
      const c = db.collection(root);
      await Promise.all([
        c.doc('a').set({ k: 1, t: 1, v: 'project' }),
        c.doc('b').set({ k: 1, t: 2, v: 'private', a: 'me' }),
        c.doc('c').set({ k: 1, t: 3, v: 'private', a: 'other' }),
        c.doc('x').set({ k: 2, t: 4, v: 'project' }),
      ]);
      const visible = Filter.or(Filter.where('v', '==', 'project'),
        Filter.and(Filter.where('v', '==', 'private'), Filter.where('a', '==', 'me')));
      const events: string[] = [], readTimes: Timestamp[] = [];
      let lastB: Timestamp | undefined;
      let wake = () => {};
      let next = new Promise<void>(resolve => { wake = resolve; });
      // Only snapshots carrying changes are recorded; whether a store also emits empty ones is not part of the contract.
      const stop = c.where('k', '==', 1).where(visible).orderBy('t', 'desc').orderBy(FieldPath.documentId()).limit(5)
        .onSnapshot(snap => {
          const changes = snap.docChanges();
          if (!changes.length) return;
          readTimes.push(snap.readTime);
          for (const change of changes) if (change.doc.id === 'b' && change.type === 'modified') lastB = change.doc.updateTime;
          events.push(changes.map(change => `${change.type}:${change.doc.id}`).sort().join(','));
          wake();
        }, error => { events.push(`error:${error.message}`); wake(); });
      const settle = async () => {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([next, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no snapshot after ${JSON.stringify(events)}`)), 5000);
        })]).finally(() => clearTimeout(timer));
        next = new Promise<void>(resolve => { wake = resolve; });
      };
      try {
        await settle();
        await c.doc('a').update({ v: 'private', a: 'other' }); await settle();
        await c.doc('x').update({ t: 5 });
        await c.doc('c').update({ a: 'me' }); await settle();
        const written = await c.doc('b').update({ t: 9 }); await settle();
        assert.deepEqual(events, ['added:a,added:b', 'removed:a', 'added:c', 'modified:b']);
        assert.ok(lastB?.isEqual(written.writeTime) && lastB.isEqual((await c.doc('b').get()).updateTime!));
        for (let i = 1; i < readTimes.length; i++) assert.ok(readTimes[i].valueOf() > readTimes[i - 1].valueOf());
      } finally { stop(); }
    } },
  ];
}
