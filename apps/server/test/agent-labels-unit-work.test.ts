// Counted storage work of an /agents directory page, full rows against the labels view the Tasks tab walks.
// Model-free, on the disposable emulator. Same counting rules as steady-state-unit-work.test.ts: a document get is
// one read, a query is max(1, results), a count is one read per 1,000 entries. Whole requests, authentication included.
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { agents, db, inProject } from '../src/firestore.js';
import { viewRoutes } from '../src/view/routes.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';
import { FirestorePrototype, QueryPrototype, TransactionPrototype, aggregatePrototype } from './store-prototypes.js';

const counted = { reads: 0 };
const readsOf = (result: unknown): number => {
  if (Array.isArray(result)) return result.length;
  const value = result as { size?: number; data?: () => { count?: unknown } };
  if (typeof value?.size === 'number') return Math.max(1, value.size);
  const count = typeof value?.data === 'function' ? value.data()?.count : undefined;
  return typeof count === 'number' ? Math.max(1, Math.ceil(count / 1000)) : 1;
};
function wrap(proto: object, name: string) {
  const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name];
  Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (result instanceof Promise) return result.then(value => { counted.reads += readsOf(value); return value; });
    counted.reads += readsOf(result);
    return result;
  } });
}
wrap(FirestorePrototype, 'getAll');
wrap(TransactionPrototype, 'get');
wrap(TransactionPrototype, 'getAll');
wrap(QueryPrototype, 'get');
wrap(aggregatePrototype(), 'get');

let server: Server, base: string;
beforeEach(async () => {
  await resetEmulator();
  const app = express(); app.use(scoped(viewRoutes(() => 70_000_000)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

test('counted: a labels page of 20 agents reads a fraction of a full directory page, with the same rows', async () => {
  const f = await seed({ profiles: [{ name: 'Owner A', email: 'labels-a@example.test' }, { name: 'Owner B', email: 'labels-b@example.test' }],
    agents: [{ person: 0, name: 'a-fox' }] });
  await inProject(TEST_PROJECT, async () => {
    const batch = db.batch();
    for (let i = 0; i < 40; i++) batch.set(agents().doc(), { ownerProfileId: f.personIds[i % 2], connectionEpoch: 0, name: `bulk-${String(i).padStart(2, '0')}`,
      tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null, focus: { text: 'Working', updatedAt: 1, runId: 'r' } });
    await batch.commit();
  });
  const token = await idTokenFor('labels-a@example.test');
  const measure = async (path: string) => {
    counted.reads = 0;
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() as { agents: { id: string; name: string }[]; next: string | null }, reads: counted.reads };
  };
  const full = await measure('/agents'), labels = await measure('/agents?view=labels');
  const fullNext = await measure(`/agents?cursor=${encodeURIComponent(full.body.next!)}`);
  const labelsNext = await measure(`/agents?view=labels&cursor=${encodeURIComponent(labels.body.next!)}`);
  console.log(JSON.stringify({ agentLabelsUnitWork: { rows: full.body.agents.length, fullReads: full.reads, labelsReads: labels.reads,
    fullNextReads: fullNext.reads, labelsNextReads: labelsNext.reads } }));
  expect([full, labels, fullNext, labelsNext].every(r => r.status === 200)).toBe(true);
  // Same rows and order, and the cursors walk the same pages.
  expect(labels.body.agents.map(a => [a.id, a.name])).toEqual(full.body.agents.map(a => [a.id, a.name]));
  expect(labelsNext.body.agents.map(a => a.id)).toEqual(fullNext.body.agents.map(a => a.id));
  expect(full.reads - labels.reads).toBeGreaterThanOrEqual(full.body.agents.length * 2);
  expect(fullNext.reads - labelsNext.reads).toBeGreaterThanOrEqual(fullNext.body.agents.length * 2);
});
