// Counted storage work of today's inbox model, for the inbox data-model comparison (c3-inbox-data-model.md).
// Model-free, on the disposable emulator. Same counting rules as steady-state-unit-work.test.ts: a document get is
// one read, a query is max(1, results), a count is one read per 1,000 entries; writes are staged batch operations.
// Measures the storage layer only (delivery, read, ack). Route authentication and run checks are counted there.
import { beforeEach, expect, test } from 'vitest';
import { agents, db, inProject } from '../src/firestore.js';
import { createFanout, runFanout } from '../src/v2/fanout.js';
import { deliver, readTargets, readUpdates } from '../src/v2/inbox.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import { FirestorePrototype, QueryPrototype, TransactionPrototype, aggregatePrototype, countStoreWrites } from './store-prototypes.js';

const counted = { reads: 0, writes: 0 };
const readsOf = (result: unknown): number => {
  if (Array.isArray(result)) return result.length;
  const value = result as { size?: number; data?: () => { count?: unknown } };
  if (typeof value?.size === 'number') return Math.max(1, value.size);
  const count = typeof value?.data === 'function' ? value.data()?.count : undefined;
  return typeof count === 'number' ? Math.max(1, Math.ceil(count / 1000)) : 1;
};
function wrap(proto: object, name: string, count: (result: unknown) => void) {
  const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name];
  Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (result instanceof Promise) return result.then(value => { count(value); return value; });
    count(result);
    return result;
  } });
}
wrap(FirestorePrototype, 'getAll', value => { counted.reads += readsOf(value); });
wrap(TransactionPrototype, 'get', value => { counted.reads += readsOf(value); });
wrap(TransactionPrototype, 'getAll', value => { counted.reads += readsOf(value); });
wrap(QueryPrototype, 'get', value => { counted.reads += readsOf(value); });
wrap(aggregatePrototype(), 'get', value => { counted.reads += readsOf(value); });
countStoreWrites(() => { counted.writes++; });

beforeEach(resetEmulator);
const T = 3_000_000;
async function measure<V>(work: () => Promise<V>) {
  counted.reads = 0; counted.writes = 0;
  const value = await work();
  return { value, reads: counted.reads, writes: counted.writes };
}
async function writeAll(entries: [string, object][]) {
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const [path, body] of entries.slice(i, i + 400)) batch.set(db.doc(path), body);
    await batch.commit();
  }
}

test('counted inbox storage work: direct delivery, broadcast page, read page and acknowledgement', () => inProject(TEST_PROJECT, async () => {
  const data = await seed({ profiles: [{ name: 'Owner', email: 'inbox-unit@example.com' }], agents: [{ person: 0, name: 'Reader' }] });
  const owner = data.personIds[0], reader = data.agents[0].agentId;
  const base = agents().path;
  await writeAll(Array.from({ length: 199 }, (_, i) => [`${base}/live-${String(i).padStart(3, '0')}`,
    { ownerProfileId: owner, connectionEpoch: 0, name: 'Synthetic', tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null }] as [string, object]));
  const recipients = ['live-000', 'live-001', 'live-002'];

  // Direct delivery to three agents, as the sender's transaction does it (without its policy and membership reads).
  const direct = await measure(() => db.runTransaction(async tx => {
    const targets = await readTargets(tx, recipients, 'direct-1');
    return deliver(tx, targets, { sourceId: 'direct-1', kind: 'message', messageId: 'direct-1', payload: { body: 'Hi', agentId: reader } }, T);
  }));
  expect(direct.value).toBe(3);
  expect(direct).toMatchObject({ reads: 6, writes: 9 });

  // One project-wide item to all 200 live agents: two discovery pages of 100 in one invocation.
  const sourceId = await db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'All' }, T));
  const broadcast = await measure(() => runFanout(sourceId, () => T));
  expect(broadcast.value).toBe('done');

  // A reader with 60 unacknowledged items: one page read (50 items), then acknowledging it.
  for (let n = 0; n < 59; n++) await db.runTransaction(async tx => {
    deliver(tx, await readTargets(tx, [reader], `s${n}`), { sourceId: `s${n}`, kind: 'message', messageId: `s${n}`, payload: { body: `m${n}`, agentId: 'live-000' } }, T + n);
  });
  const page = await measure(() => readUpdates(reader, undefined, () => T + 100));
  expect(page.value.items).toHaveLength(50);
  const ack = await measure(() => readUpdates(reader, page.value.position, () => T + 200));
  expect(ack.value.acknowledged).toBe(50);

  console.info(JSON.stringify({ event: 'inbox_unit_work',
    direct3: { reads: direct.reads, writes: direct.writes },
    broadcast200: { reads: broadcast.reads, writes: broadcast.writes, readsPerRecipient: +(broadcast.reads / 200).toFixed(2), writesPerRecipient: +(broadcast.writes / 200).toFixed(2) },
    readPage50: { reads: page.reads, writes: page.writes },
    ack50AndNextPage: { reads: ack.reads, writes: ack.writes } }));
  // Per delivered item: 2 reads (inbox head, source marker) and 3 writes (item, marker, head), plus discovery and re-reads.
  expect(broadcast.writes).toBeGreaterThanOrEqual(3 * 200);
  // Acknowledging 50 items writes one expireAt update per item, plus the inbox head and the run receipt.
  expect(ack.writes).toBeGreaterThanOrEqual(50 + 2);
}), 60_000);
