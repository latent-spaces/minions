// Store logical operations, including retry attempts and empty-query minima. These are NOT billed cloud reads.
// Nested store calls are suppressed so Transaction.getAll -> Firestore.getAll isn't counted twice.
// The meter wraps whichever store firestore.ts installed (the Firestore SDK or a self-hosted adapter): it finds
// each operation on the live db's own objects instead of importing one SDK's classes.
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../src/firestore.js';
import type { QuerySnapshot } from '../src/firestore.js';
export type Work = { calls: number; reads: number; failedCalls: number; writes: number; committedWrites: number;
  transactions: number; transactionAttempts: number; failedTransactions: number; batches: number;
  listenerSeeds: number; listenerSeedDocs: number; listenerChanges: number; listenerErrors: number };
export const work = (): Work => ({ calls: 0, reads: 0, failedCalls: 0, writes: 0, committedWrites: 0,
  transactions: 0, transactionAttempts: 0, failedTransactions: 0, batches: 0,
  listenerSeeds: 0, listenerSeedDocs: 0, listenerChanges: 0, listenerErrors: 0 });
export const meter = new AsyncLocalStorage<Work>();
const inside = new AsyncLocalStorage<boolean>(), transactionWrites = new AsyncLocalStorage<{ count: number }>();
const units = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (typeof (value as { size?: number })?.size === 'number') return Math.max(1, (value as { size: number }).size);
  // Count all cold-baseline COUNT work, not just the single returned aggregate
  // object. This is a logical read-unit model, never a managed billing claim.
  const aggregate = value as { data?: () => { count?: unknown } };
  const count = typeof aggregate?.data === 'function' ? aggregate.data()?.count : undefined;
  return typeof count === 'number' ? Math.max(1, Math.ceil(count / 1000)) : 1;
};
export const difference = (after: Work, before: Work): Work => Object.fromEntries(Object.entries(after)
  .map(([key, value]) => [key, value - before[key as keyof Work]])) as Work;
type Method = (...args: any[]) => any;
// The prototype that defines `method` for this object, so a subclass (a collection is a query) is wrapped once.
function definer(object: object, method: string): Record<string, Method> {
  for (let proto = Object.getPrototypeOf(object); proto; proto = Object.getPrototypeOf(proto)) {
    if (Object.hasOwn(proto, method)) return proto;
  }
  throw new Error(`The installed store has no ${method}() to meter.`);
}

export function instrumentFirestoreWork() {
  const restores: (() => void)[] = [], wrapped = new Map<object, Set<string>>();
  // Wrapping prototype methods lets the driver observe actual store callbacks and retries without production hooks.
  const replace = (object: object, method: string, build: (original: Method) => Method) => {
    const p = definer(object, method), done = wrapped.get(p) ?? new Set<string>();
    if (done.has(method)) return;
    done.add(method); wrapped.set(p, done);
    const original = p[method]!;
    p[method] = build(original); restores.push(() => { p[method] = original; });
  };
  const counted = (original: Method): Method => function(this: unknown, ...args) {
    const bucket = meter.getStore(); if (!bucket || inside.getStore()) return original.apply(this, args);
    bucket.calls++;
    try { return Promise.resolve(inside.run(true, () => original.apply(this, args))).then(value => {
      bucket.reads += units(value); return value;
    }, error => { bucket.failedCalls++; throw error; }); }
    catch (error) { bucket.failedCalls++; throw error; }
  };
  const collection = db.collection('work-meter-probe'), document = collection.doc('probe'), batch = db.batch();
  for (const [object, method] of [[db, 'getAll'], [document, 'get'], [collection, 'get'], [collection.limit(1), 'get']] as const) {
    replace(object, method, counted);
  }
  // A write through a document is one batch of one write. The SDK runs it through its own WriteBatch, which the
  // batch wrapper below then skips because it runs inside this one; a store without that detour is counted the same.
  for (const method of ['set', 'update', 'create', 'delete']) replace(document, method, original => function(this: unknown, ...args) {
    const bucket = meter.getStore(); if (!bucket || inside.getStore()) return original.apply(this, args);
    bucket.writes++; bucket.batches++;
    return Promise.resolve(inside.run(true, () => original.apply(this, args))).then(value => { bucket.committedWrites++; return value; });
  });
  // The transaction object exists only inside runTransaction, so its operations are wrapped on first use.
  const instrumentTransaction = (tx: object) => {
    for (const method of ['get', 'getAll']) replace(tx, method, counted);
    for (const method of ['set', 'update', 'create', 'delete']) replace(tx, method, original => function(this: unknown, ...args) {
      const bucket = meter.getStore(), frame = transactionWrites.getStore();
      if (bucket && !inside.getStore()) { bucket.writes++; if (frame) frame.count++; }
      return inside.run(true, () => original.apply(this, args));
    });
  };
  const queued = new WeakMap<object, number>();
  for (const method of ['set', 'update', 'create', 'delete']) replace(batch, method, original => function(this: object, ...args) {
    if (meter.getStore() && !inside.getStore()) { queued.set(this, (queued.get(this) ?? 0) + 1); meter.getStore()!.writes++; }
    return inside.run(true, () => original.apply(this, args));
  });
  replace(batch, 'commit', original => function(this: object, ...args) {
    const bucket = meter.getStore(), count = queued.get(this) ?? 0;
    queued.delete(this);
    if (!bucket || !count) return original.apply(this, args);
    bucket.batches++;
    return original.apply(this, args).then((value: unknown) => { bucket.committedWrites += count; return value; });
  });
  replace(db, 'runTransaction', original => function(this: unknown, update: (tx: any) => unknown, options?: unknown) {
    const bucket = meter.getStore();
    if (!bucket) return original.call(this, async (tx: object) => { instrumentTransaction(tx); return update(tx); }, options);
    bucket.transactions++; let lastWrites = 0;
    return original.call(this, async (tx: object) => {
      instrumentTransaction(tx);
      bucket.transactionAttempts++; const frame = { count: 0 };
      try { return await transactionWrites.run(frame, () => update(tx)); }
      finally { lastWrites = frame.count; }
    }, options).then((value: unknown) => { bucket.committedWrites += lastWrites; return value; }, (error: unknown) => {
      bucket.failedTransactions++; throw error;
    });
  });
  replace(collection, 'onSnapshot', original => function(this: unknown, next: (snapshot: QuerySnapshot) => void, fail?: (error: Error) => void) {
    const bucket = meter.getStore(); let first = true;
    return original.call(this, (snapshot: QuerySnapshot) => {
      if (bucket) {
        if (first) { bucket.listenerSeeds++; bucket.listenerSeedDocs += Math.max(1, snapshot.size); }
        else bucket.listenerChanges += snapshot.docChanges().length;
      }
      first = false; next(snapshot);
    }, (error: Error) => { if (bucket) bucket.listenerErrors++; fail?.(error); });
  });
  return () => { for (const restore of restores.reverse()) restore(); };
}
