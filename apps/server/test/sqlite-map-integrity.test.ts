import { afterEach, beforeEach, expect, test } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { SqliteFirestore } from '../src/storage/sqlite-firestore.js';

let db: SqliteFirestore;
const prototype = Object.prototype as Record<string, unknown>;
const marker = 'minionsMapRegression';
beforeEach(() => { db = new SqliteFirestore(); expect(Object.hasOwn(prototype, marker)).toBe(false); });
afterEach(() => { delete prototype[marker]; db.close(); });

test('parsed own prototype keys survive encoding, decoding and snapshot copies as ordinary data', async () => {
  const data = JSON.parse('{"__proto__":{"kept":1},"nested":{"__proto__":{"kept":2}},"list":[{"__proto__":{"kept":3}}],"__k42":"map","v":{"normal":4}}');
  const ref = db.doc('maps/roundtrip');
  await ref.set(data);
  const first = (await ref.get()).data();
  expect(Object.hasOwn(first, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
  expect(first).toEqual(data);
  first.__proto__.kept = 100;
  expect((await ref.get()).data()).toEqual(data);
});

test('dotted updates and merges never follow inherited prototype objects', async () => {
  const ref = db.doc('maps/paths');
  await ref.set({ normal: 1 });
  await ref.update({ [`__proto__.${marker}`]: true });
  expect(Object.hasOwn(prototype, marker)).toBe(false);
  const patch = JSON.parse(`{"nested":{"__proto__":{"${marker}":2}},"__proto__":{"other":3}}`);
  await ref.set(patch, { merge: true });
  expect(Object.hasOwn(prototype, marker)).toBe(false);
  expect((await ref.get()).data()).toEqual(JSON.parse(`{"normal":1,"__proto__":{"${marker}":true,"other":3},"nested":{"__proto__":{"${marker}":2}}}`));
  await ref.update({ [`__proto__.${marker}`]: FieldValue.delete() });
  expect((await ref.get()).data().__proto__).toEqual({ other: 3 });
});

test('missing inherited fields are absent in snapshots, projections and query ordering', async () => {
  const collection = db.collection('maps');
  await collection.doc('missing').set({ normal: 1 });
  await collection.doc('own').set({ toString: 'stored', constructor: { kept: 2 } });
  const missing = await collection.doc('missing').get();
  expect(missing.get('toString')).toBeUndefined();
  expect(missing.get('constructor')).toBeUndefined();
  expect((await collection.select('constructor', 'hasOwnProperty').get()).docs.map(doc => [doc.id, doc.data()])).toEqual([
    ['missing', {}], ['own', { constructor: { kept: 2 } }],
  ]);
  expect((await collection.orderBy('toString').get()).docs.map(doc => doc.id)).toEqual(['own']);
});
