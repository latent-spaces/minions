import { expect, test } from 'vitest';
import { SqliteFirestore } from '../src/storage/sqlite-firestore.js';

test('SQLite membership queries distinguish null values from missing fields', async () => {
  const db = new SqliteFirestore();
  try {
    const collection = db.collection('membershipFixtures');
    for (const [id, data] of Object.entries({ null: { value: null }, a: { value: 'a' }, b: { value: 'b' }, missing: {} })) {
      await collection.doc(id).set(data);
    }
    const ids = async (op: 'in' | 'not-in', values: unknown[]) =>
      (await collection.where('value', op, values).get()).docs.map(doc => doc.id).sort();
    // IN is an OR of equality clauses, including equality with null.
    expect(await ids('in', [null])).toEqual(['null']);
    expect(await ids('in', [null, 'a'])).toEqual(['a', 'null']);
    expect(await ids('in', ['a', 'b'])).toEqual(['a', 'b']);
    // NOT_IN excludes absent/null fields, and a null comparison makes every clause fail.
    expect(await ids('not-in', [null])).toEqual([]);
    expect(await ids('not-in', [null, 'a'])).toEqual([]);
    expect(await ids('not-in', ['a'])).toEqual(['b']);
  } finally { db.close(); }
});
