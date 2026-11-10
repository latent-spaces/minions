// Counted storage work of the CS2b current-state read: a snapshot is paid once; after that an answer costs the request's
// fixed reads plus the changed agents, not the roster. Same counting rules as steady-state-unit-work.test.ts (a document
// get is one read, a query max(1, results)); listener reads are billed separately and counted here as the snapshot.
import { updateCanonicalStatus } from './canonical-status-fixture.js';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { db, inProject } from '../src/firestore.js';
import { presence } from '../src/v2/records.js';
import { viewRoutes } from '../src/view/routes.js';
import { stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';
import { FirestorePrototype, QueryPrototype, TransactionPrototype } from './store-prototypes.js';

const counted = { reads: 0 };
const readsOf = (result: unknown): number => {
  if (Array.isArray(result)) return result.length;
  const value = result as { size?: number };
  return typeof value?.size === 'number' ? Math.max(1, value.size) : 1;
};
function wrap(proto: object, name: string) {
  const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name];
  Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (result instanceof Promise) return result.then(value => { counted.reads += readsOf(value); return value; });
    return result;
  } });
}
wrap(FirestorePrototype, 'getAll');
wrap(TransactionPrototype, 'get');
wrap(TransactionPrototype, 'getAll');
wrap(QueryPrototype, 'get');

let server: Server, base: string;
const at = 90_000_000;
beforeEach(async () => {
  stopCurrentState(); await resetEmulator();
  const app = express(); app.use(scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
afterAll(() => stopCurrentState());

test('counted: after the snapshot, an answer reads a constant plus the changed agents, whatever the roster', async () => {
  const f = await seed({ profiles: [{ name: 'Viewer', email: 'cs2b-unit@example.test' }], agents: [] });
  const owner = f.personIds[0]!, roster = 300;
  await inProject(TEST_PROJECT, async () => {
    for (let done = 0; done < roster; done += 400) {
      const batch = db.batch();
      for (let i = done; i < Math.min(roster, done + 400); i++) batch.set(presence().doc(`agent-${String(i).padStart(4, '0')}`), {
        runId: 'r', lastContactAt: at, phase: 'turn', phaseAt: at, acceptingWork: true, runEndedAt: null, runMode: 'background',
        agent: { name: `agent-${i}`, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' } } as never);
      await batch.commit();
    }
  });
  const token = await idTokenFor('cs2b-unit@example.test');
  const read = async (cursor?: string) => {
    counted.reads = 0;
    const response = await fetch(`${base}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    const data = await response.json() as { rows: { id: string }[]; cursor: string; more: boolean };
    return { reads: counted.reads, rows: data.rows.length, cursor: data.cursor, more: data.more };
  };
  let snapshot = await read();
  for (let i = 0; i < 50 && snapshot.rows < roster; i++) { await new Promise(r => setTimeout(r, 50)); snapshot = await read(); }
  expect(snapshot.rows).toBe(roster);
  const quiet = await read(snapshot.cursor);
  // One agent changes; the next answer carries it alone.
  await inProject(TEST_PROJECT, () => updateCanonicalStatus('agent-0007',{ 'agent.focus': { text: 'changed', updatedAt: at } }));
  let delta = await read(quiet.cursor);
  for (let i = 0; i < 50 && delta.rows === 0; i++) { await new Promise(r => setTimeout(r, 50)); delta = await read(quiet.cursor); }
  console.log(JSON.stringify({ currentStateUnitWork: { roster, snapshotRows: snapshot.rows, snapshotReads: snapshot.reads, quietReads: quiet.reads, deltaRows: delta.rows, deltaReads: delta.reads } }));
  expect(delta.rows).toBe(1);
  // No per-agent reads: a quiet or one-change answer stays a small constant (auth, Needs you, owners, pause).
  expect(quiet.reads).toBeLessThan(15);
  expect(delta.reads).toBeLessThan(15);
});
