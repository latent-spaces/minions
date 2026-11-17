import { expect, test } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { SqliteFirestore } from '../src/storage/sqlite-firestore.js';

test('SQLite stores Uint8Array fields as bytes for direct and merged writes', async () => {
  const db = new SqliteFirestore();
  const bytes = new Uint8Array([0, 127, 255]), expected = Buffer.from(bytes);
  try {
    const ref = db.doc('byteFixtures/direct');
    await ref.set({ bytes, nested: { bytes } });
    expect((await ref.get()).data()).toEqual({ bytes: expected, nested: { bytes: expected } });

    // A merge replaces a previous map with a byte value rather than merging its
    // numeric indexes into that map. Unrelated map fields remain unchanged.
    await ref.set({ bytes: { old: true }, keep: true });
    await ref.set({ bytes }, { merge: true });
    expect((await ref.get()).data()).toEqual({ bytes: expected, keep: true });

    await ref.update({ bytes: new Uint8Array([3, 4]) });
    expect((await ref.get()).get('bytes')).toEqual(Buffer.from([3, 4]));

    const created = db.doc('byteFixtures/created');
    await created.create({ bytes });
    expect((await created.get()).get('bytes')).toEqual(expected);
    expect((await db.collection('byteFixtures').where('bytes', '==', bytes).get()).docs.map(doc => doc.id)).toEqual(['created']);

    await ref.update({ list: FieldValue.arrayUnion(bytes) });
    await ref.update({ list: FieldValue.arrayUnion(Buffer.from(bytes)) });
    expect((await ref.get()).get('list')).toEqual([expected]);
    await ref.update({ list: FieldValue.arrayRemove(bytes) });
    expect((await ref.get()).get('list')).toEqual([]);
  } finally { db.close(); }
});
