import express from 'express';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { v2Routes } from '../src/v2/routes.js';
import { projectControlStats } from '../src/projects/project-control.js';
import { resetEmulator, scoped, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

// TEAM-PLAN gate 5: a cold replica, or a rebuilt project router, must not let a superseded run act. Each replica
// here is a separate module graph (vi.resetModules), so it has its own request-state, presence suppression, router
// caches and shared project listener, as another Cloud Run instance would. Run authority lives only in Firestore.
type Replica = { prefix: string };
let server: Server, base: string, at = 2_100_000_000_000;
const now = () => at;
const replicas: Record<'warm' | 'rebuilt' | 'takeover' | 'cold', Replica> = {
  warm: { prefix: '/a/v2' }, rebuilt: { prefix: '/a-again/v2' }, takeover: { prefix: '/b/v2' }, cold: { prefix: '/c/v2' },
};
beforeAll(async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => at);
  const app = express(); app.use(express.json());
  // Replica A, and a router built again in the same process after eviction.
  app.use(replicas.warm.prefix, scoped(v2Routes(now)));
  app.use(replicas.rebuilt.prefix, scoped(v2Routes(now)));
  for (const name of ['takeover', 'cold'] as const) {
    vi.resetModules();
    const [routes, helpers] = await Promise.all([import('../src/v2/routes.js'), import('./helpers.js')]);
    app.use(replicas[name].prefix, helpers.scoped(routes.v2Routes(now)));
  }
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

async function post(replica: Replica, token: string, path: string, body: object, headers: Record<string, string> = {}) {
  const response = await fetch(base + replica.prefix + path, { method: 'POST', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
  const text = await response.text(), data = text.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? text;
  return { status: response.status, body: JSON.parse(data) };
}
const session = (runId: string, missionId: string, startedAt: number) => ({ run_id: runId, missionId, generation: 1, startedAt,
  remainingSlots: 0, phase: 'waiting' });
const tool = (replica: Replica, token: string, runId: string) => post(replica, token, '/mcp',
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_agent_inbox', arguments: {} } }, { 'x-pilot-run': runId });
const refusedTool = (result: { status: number; body: any }) => result.status !== 200 || result.body?.result?.isError === true;
// The MCP transport answers 200 with a tool error whose text starts with the refusal code.
const toolRefusal = (result: { status: number; body: any }) => result.body?.result?.isError === true
  ? String(result.body.result.content?.[0]?.text ?? '').split(':')[0] : `http_${result.status}`;

test('after a takeover on one replica, the old run is refused on warm, rebuilt and cold replicas alike', async () => {
  await resetEmulator();
  const { agents: [agent] } = await seed({ profiles: [{ name: 'Owner', email: 'replica-fences@example.test' }], agents: [{ person: 0, name: 'Runner' }] });
  const token = agent.token, startedAt = Date.now();
  const first = await post(replicas.warm, token, '/runs', { client_run_id: randomUUID(), runner_version: 'synthetic' });
  expect(first.status).toBe(200);
  const oldRun: string = first.body.run_id, oldMission = randomUUID();
  // Warm replica A: every cache and the shared listener now hold this agent and project.
  expect((await post(replicas.warm, token, '/wait', { run_id: oldRun })).status).toBe(200);
  // The replicas really are separate processes' state: A's /wait spacing applies on A's rebuilt router but not on
  // B. C stays untouched until after the takeover, so it is cold when it first sees this agent.
  expect((await post(replicas.rebuilt, token, '/wait', { run_id: oldRun })).status).toBe(429);
  expect((await post(replicas.takeover, token, '/wait', { run_id: oldRun })).status).toBe(200);
  expect((await post(replicas.warm, token, '/worker-session', session(oldRun, oldMission, startedAt))).status).toBe(200);
  expect(refusedTool(await tool(replicas.warm, token, oldRun))).toBe(false);
  const opened = await post(replicas.warm, token, '/project-control', { run_id: oldRun });
  expect(opened.status).toBe(200);
  const held = post(replicas.warm, token, '/project-control', { run_id: oldRun, after_revision: opened.body.project.revision });
  // A's held request has passed its first run check and is waiting before the takeover starts (A's own module graph).
  for (let i = 0; i < 200 && projectControlStats().heldRequests < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(projectControlStats().heldRequests).toBe(1);

  // The connector restarts and takes over through replica B.
  const second = await post(replicas.takeover, token, '/runs', { client_run_id: randomUUID(), runner_version: 'synthetic', takeover: true });
  expect(second.status).toBe(200);
  const newRun: string = second.body.run_id;
  expect(newRun).not.toBe(oldRun);

  // New project state must not reach the old run through A's held request.
  await seedRuntime(TEST_PROJECT, { revision: opened.body.project.revision + 1 });
  expect(await held).toMatchObject({ status: 409, body: { error: 'run_superseded' } });

  // Past the per-process /wait spacing, so each refusal below comes from the run check, not admission.
  for (const replica of [replicas.warm, replicas.rebuilt, replicas.cold]) {
    at += 25_000;
    expect(await post(replica, token, '/wait', { run_id: oldRun })).toMatchObject({ status: 409, body: { error: 'run_superseded' } });
    expect(await post(replica, token, '/project-control', { run_id: oldRun })).toMatchObject({ status: 409, body: { error: 'run_superseded' } });
    expect(await post(replica, token, '/worker-session', session(oldRun, oldMission, startedAt))).toMatchObject({ status: 409, body: { error: 'run_superseded' } });
    expect(toolRefusal(await tool(replica, token, oldRun))).toBe('run_superseded');
  }
  // The new run works everywhere, including the replicas that served the old one.
  for (const replica of [replicas.warm, replicas.rebuilt, replicas.cold, replicas.takeover]) {
    at += 25_000;
    expect((await post(replica, token, '/project-control', { run_id: newRun })).status).toBe(200);
    expect(refusedTool(await tool(replica, token, newRun))).toBe(false);
  }
});
