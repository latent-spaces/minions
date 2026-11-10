import { beforeEach, expect, test } from 'vitest';
import { db } from '../src/firestore.js';
import { instrumentFirestoreWork, meter, work } from './firestore-work-meter.js';
import { resetEmulator } from './helpers.js';
beforeEach(resetEmulator);
test('the workload meter counts direct/batch writes, empty queries, retries and failed attempts without nested read duplication', async () => {
  const restore = instrumentFirestoreWork();
  try {
    const direct = work();
    await meter.run(direct, () => db.doc('meter/direct').set({ value: 1 }));
    expect(direct).toMatchObject({ writes: 1, committedWrites: 1, batches: 1 });
    const batchWork = work();
    await meter.run(batchWork, async () => { const batch = db.batch(); batch.set(db.doc('meter/a'), {}); batch.set(db.doc('meter/b'), {}); await batch.commit(); });
    expect(batchWork).toMatchObject({ writes: 2, committedWrites: 2, batches: 1 });
    const reads = work();
    await meter.run(reads, async () => {
      await db.doc('meter/direct').get(); await db.getAll(db.doc('meter/a'), db.doc('meter/b'));
      await db.collection('empty-meter-query').get();
    });
    expect(reads).toMatchObject({ calls: 3, reads: 4 });
    let tries = 0; const retry = work();
    await meter.run(retry, () => db.runTransaction(async tx => {
      await tx.get(db.doc('meter/direct')); tx.set(db.doc('meter/direct'), { value: 2 });
      if (++tries === 1) throw Object.assign(new Error('injected abort'), { code: 10 });
    }));
    expect(retry).toMatchObject({ transactions: 1, transactionAttempts: 2, reads: 2, writes: 2, committedWrites: 1 });
    const failed = work();
    await expect(meter.run(failed, () => db.runTransaction(async tx => {
      await tx.get(db.doc('meter/direct')); tx.set(db.doc('meter/direct'), { value: 3 }); throw new Error('injected failure');
    }))).rejects.toThrow('injected failure');
    expect(failed).toMatchObject({ transactions: 1, transactionAttempts: 1, reads: 1, writes: 1, committedWrites: 0, failedTransactions: 1 });
  } finally { restore(); }
});

test('cold COUNT work includes each thousand indexed records rather than only its aggregate result object', async () => {
  for (let start = 0; start < 1001; start += 200) {
    const batch = db.batch();
    for (let n = start; n < Math.min(1001, start + 200); n++) batch.set(db.doc(`meter-count/${n}`), {});
    await batch.commit();
  }
  const restore = instrumentFirestoreWork(), bucket = work();
  try {
    await meter.run(bucket, () => db.runTransaction(tx => tx.get(db.collection('meter-count').count()), { readOnly: true }));
    expect(bucket).toMatchObject({ calls: 1, reads: 2, transactions: 1, transactionAttempts: 1, writes: 0 });
  } finally { restore(); }
});
