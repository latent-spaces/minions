// Store-neutral stand-ins for the firebase-admin prototypes tests spy on (Firestore, Query, DocumentReference,
// WriteBatch, Transaction). Each is the prototype that defines that role's operations on the store firestore.ts
// installed, so a spy observes the Firestore SDK today and a self-hosted store the same way.
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, type DocumentReference, type Query, type Transaction } from '../src/firestore.js';

function definer<T>(object: object, method: string): T {
  for (let proto = Object.getPrototypeOf(object); proto; proto = Object.getPrototypeOf(proto)) {
    if (Object.hasOwn(proto, method)) return proto as T;
  }
  throw new Error(`The installed store has no ${method}() to observe.`);
}

const probe = db.collection('store-prototype-probe');
export const FirestorePrototype = definer<typeof db>(db, 'getAll');
export const QueryPrototype = definer<Query>(probe.limit(1), 'get');
export const DocumentPrototype = definer<DocumentReference>(probe.doc('probe'), 'get');
export const BatchPrototype = definer<ReturnType<typeof db.batch>>(db.batch(), 'commit');
// COUNT queries: resolved on use, so a store whose aggregate query has no class fails only the tests that count it.
export const aggregatePrototype = () => definer<ReturnType<Query['count']>>(probe.count(), 'get');
// A transaction object exists only inside runTransaction; an empty one reads and writes nothing.
export const TransactionPrototype = await db.runTransaction(async tx => definer<Transaction>(tx, 'get'));

// Calls `count` once per document write, whether it goes through a document, a transaction or a batch. The Firestore
// SDK sends document and transaction writes through its own WriteBatch; those nested calls are not counted again, so
// the count is the same on a store that writes directly.
const writing = new AsyncLocalStorage<boolean>();
export function countStoreWrites(count: () => void) {
  for (const proto of [DocumentPrototype, TransactionPrototype, BatchPrototype]) for (const name of ['set', 'update', 'create', 'delete']) {
    const p = proto as unknown as Record<string, (...args: unknown[]) => unknown>, original = p[name];
    Object.defineProperty(p, name, { configurable: true, writable: true, value: function (this: unknown, ...args: unknown[]) {
      if (!writing.getStore()) count();
      return writing.run(true, () => original.apply(this, args));
    } });
  }
}
