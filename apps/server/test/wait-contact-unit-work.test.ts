// Counted work of the /wait the deployed connector actually sends: `{ run_id }` with no phase report
// (packages/agent-cli/src/service/cloud-client.mjs, the 20 s tick). steady-state-unit-work counts /wait with a report,
// which takes the reportPhase transaction instead; the billing calibration (c8-forecast-challenge.md §7) needs both.
// Emulator SDK counts mapped to billing rules (a document get is one read, a query max(1, rows)); not latency.
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { v2Routes } from '../src/v2/routes.js';
import { startRun } from '../src/v2/runs.js';
import { resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';
import { FirestorePrototype, QueryPrototype, TransactionPrototype, aggregatePrototype, countStoreWrites } from './store-prototypes.js';

const counted = { reads: 0, writes: 0 };
const readsOf = (result: unknown): number => {
  if (Array.isArray(result)) return result.length;
  const value = result as { size?: number };
  return typeof value?.size === 'number' ? Math.max(1, value.size) : 1;
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
const read = (value: unknown) => { counted.reads += readsOf(value); };
wrap(FirestorePrototype, 'getAll', read);
wrap(TransactionPrototype, 'get', read);
wrap(TransactionPrototype, 'getAll', read);
wrap(QueryPrototype, 'get', read);
wrap(aggregatePrototype(), 'get', read);
countStoreWrites(() => { counted.writes++; });

let server: Server, base: string, clock = Date.now();
const now = () => clock;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(scoped(v2Routes(now)));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);

const settle = () => new Promise(resolve => setTimeout(resolve, 150));
async function wait(token: string, body: object) {
  await settle(); counted.reads = 0; counted.writes = 0;
  const response = await fetch(`${base}/wait`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await response.json(); await settle();
  return { status: response.status, reads: counted.reads, writes: counted.writes };
}

test('/wait without a phase report: reads and writes per poll at the connector 20 s cadence', async () => {
  const f = await seed({ profiles: [{ name: 'Unit person', email: 'wait-unit@example.test' }],
    agents: [{ person: 0, name: 'Cold' }, { person: 0, name: 'Warm' }] });
  const sessions = await Promise.all(f.agents.map(async agent => ({ token: agent.token,
    runId: (await inProject(TEST_PROJECT, () => startRun(agent.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now))).run_id })));
  // Six polls 20 s apart (120 s): contact is written when 60 s have passed since the last write, so two in six.
  // The stored contact throttles all instances; each accepted write includes status, dirty ID and shard.
  const ROUNDS = 6, sums = { plain: { cold: 0, warm: 0, writes: 0 }, report: { cold: 0, warm: 0, writes: 0 } };
  for (const kind of ['plain', 'report'] as const) {
    clock += 120_000;
    for (let round = 0; round < ROUNDS; round++) {
      clock += 20_000;
      const body = (runId: string) => kind === 'plain' ? { run_id: runId } : { run_id: runId, report: { phase: 'idle', accepting_work: true } };
      const cold = await wait(sessions[0].token, body(sessions[0].runId));
      const warm = await wait(sessions[1].token, body(sessions[1].runId));
      expect([cold.status, warm.status]).toEqual([200, 200]);
      sums[kind].cold += cold.reads; sums[kind].warm += warm.reads; sums[kind].writes += warm.writes;
    }
  }
  const mean = (kind: 'plain' | 'report') => ({ coldReads: +(sums[kind].cold / ROUNDS).toFixed(2),
    warmReads: +(sums[kind].warm / ROUNDS).toFixed(2), writes: +(sums[kind].writes / ROUNDS).toFixed(2) });
  const plain = mean('plain'), report = mean('report');
  console.info(JSON.stringify({ waitUnitWork: { withoutReport: plain, withReport: report } }));
  // Two contact commits in six polls, each with three atomic writes (status + dirty ID + shard).
  expect(sums.plain.writes).toBe(ROUNDS / 3 * 3);
  // A report runs the phase transaction and its presence write on every poll, so it costs at least as much.
  expect(plain.warmReads).toBeLessThanOrEqual(report.warmReads);
  expect(plain.writes).toBeLessThan(report.writes);
}, 120_000);
