import express from 'express';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db, inProject } from '../src/firestore.js';
import { createFanout } from '../src/v2/fanout.js';
import { fanouts, presence } from '../src/v2/records.js';
import { v2Routes } from '../src/v2/routes.js';
import { resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

// A busy process evicts and re-creates project routers (projectRuntimeRoutes keeps 100). Presence-write
// suppression and the lapsed-fanout check cadence must survive that, or each re-creation costs Firestore work.
let at: number, server: Server, base: string;
beforeEach(async () => {
  await resetEmulator(); at = 2_100_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => at);
  const app = express(); app.use(express.json());
  app.use('/first/v2', scoped(v2Routes(() => at)));
  app.use('/again/v2', scoped(v2Routes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});
async function post(token: string, path: string, body: object) {
  const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const lastContact = (agentId: string) => inProject(TEST_PROJECT, async () => (await presence().doc(agentId).get()).data()?.lastContactAt);

test('a re-created project router keeps the once-a-minute presence write instead of writing on every wait', async () => {
  const { agents: [agent] } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }], agents: [{ person: 0, name: 'Runner' }] });
  const runId = randomUUID();
  expect((await post(agent.token, '/first/v2/runs', { client_run_id: runId, runner_version: 'synthetic' })).status).toBe(200);
  const first = at;
  expect((await post(agent.token, '/first/v2/wait', { run_id: runId })).status).toBe(200);
  expect(await lastContact(agent.agentId)).toBe(first);
  // The next poll lands on a router built after the first was evicted.
  at += 20_000;
  expect((await post(agent.token, '/again/v2/wait', { run_id: runId })).status).toBe(200);
  expect(await lastContact(agent.agentId)).toBe(first);
  at += 40_000;
  expect((await post(agent.token, '/again/v2/wait', { run_id: runId })).status).toBe(200);
  expect(await lastContact(agent.agentId)).toBe(at);
});

test('a re-created project router keeps the lapsed-fanout check cadence instead of checking on its first request', async () => {
  const { agents: [agent] } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }], agents: [{ person: 0, name: 'Runner' }] });
  const announce = (body: string) => inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body }, at)));
  const status = (id: string) => inProject(TEST_PROJECT, async () => (await fanouts().doc(id).get()).data()?.status);
  const settled = async (id: string) => { for (let i = 0; i < 50 && await status(id) === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 100)); return status(id); };
  // Any authenticated agent request runs the check; a refused start is enough.
  const touch = (prefix: string) => post(agent.token, `${prefix}/runs`, { client_run_id: randomUUID(), runner_version: 'synthetic' });
  const first = await announce('First');
  await touch('/first/v2');
  expect(await settled(first)).toBe('done');
  const second = await announce('Second');
  at += 1_000;
  await touch('/again/v2');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  expect(await status(second)).toBe('pending');
  at += 5_000;
  await touch('/again/v2');
  expect(await settled(second)).toBe('done');
});
