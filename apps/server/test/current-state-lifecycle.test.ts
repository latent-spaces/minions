// c14's lifecycle probe (949f844c), moved into the default suite with c3's queued-from-open-starts fix (contract C3 7cddc86d).
// CS2b lifecycle parity (c14): the dark endpoint answers every agent with today's map state (contract C1), including agents
// whose status document the CS2a writers (c4's A1/E1) have made complete before every group exists. Agents are created and
// changed only by actual writers; the expected state is today's reader (communicationAgents) for the same viewer and time.
// Failing first (c1, c2): with A1 live, a never-run agent's document is complete (agent group only) and has no start group,
// so an endpoint that takes "queued" from the document shows a queued agent Unknown where today's map says Waiting. Until
// the start-group gate (contract C3 0f8979cb, (a) or (b)) is met, queued must come from today's sources.
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { registerAgent } from '../src/onboarding/registration.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { createWebAgentStart } from '../src/owner/web-agent-starts.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { communicationAgents } from '../src/view/communication-agents.js';
import { viewRoutes } from '../src/view/routes.js';
import { currentStateStats, stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

// Real time: the endpoint verifies real ID tokens, and every writer here takes the clock explicitly.
let at = 0, server: Server | undefined, base = '';
const scope = <T>(work: () => Promise<T>) => inProject(TEST_PROJECT, work);
beforeEach(async () => {
  stopCurrentState();
  await resetEmulator(); at = Date.now();
  const app = express(); app.use(scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server?.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve()));
});
afterAll(() => stopCurrentState());

type Row = { id: string; state?: string; removed?: true };
async function snapshot(token: string) {
  const response = await fetch(`${base}/communication/agents/current`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return await response.json() as { rows: Row[]; complete: boolean };
}
// The endpoint's complete snapshot (polled until the listener has delivered every agent) and today's map, per agent.
async function parity(token: string, viewer: string, ids: string[]) {
  let answer = await snapshot(token);
  for (let i = 0; i < 100 && !(answer.complete && ids.every(id => answer.rows.some(r => r.id === id))); i++) {
    await new Promise(resolve => setTimeout(resolve, 50)); answer = await snapshot(token);
  }
  expect(answer).not.toHaveProperty('fallback');
  const today = (await scope(() => communicationAgents({ ids: ids.join(',') }, viewer, at))).agents;
  return ids.map(id => ({ id, endpoint: answer.rows.find(r => r.id === id)?.state, today: today.find(a => a.id === id)?.state }));
}

test('never-run agents (complete agent-only documents under A1) show today\'s map state: queued Waiting, plain, revoked', async () => {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'cs-life-alice@example.test' }] });
  const alice = f.personIds[0]!, token = await idTokenFor('cs-life-alice@example.test');
  const register = (name: string) => scope(() => registerAgent(alice, name, () => at)) as Promise<{ agentId: string }>;
  const queued = (await register('queued-quail')).agentId, plain = (await register('plain-puma')).agentId, gone = (await register('gone-gnu')).agentId;
  await createWebAgentStart(alice, { id: randomUUID(), projectId: TEST_PROJECT, name: 'queued-quail', agentId: queued,
    execution: { provider: 'codex', model: null }, approved: true }, () => at);
  await scope(() => revokeOwned(alice, gone, () => at));
  const rows = await parity(token, alice, [queued, plain, gone]);
  expect(rows.map(r => [r.id, r.today])).toEqual([[queued, 'waiting'], [plain, 'unknown'], [gone, 'revoked']]);
  expect(rows.map(r => [r.id, r.endpoint])).toEqual(rows.map(r => [r.id, r.today]));
  // Card v20: never-run agents are complete documents (agent group, no runId), so none is read from the old sources.
  expect(currentStateStats().sourceRows).toBe(0);
});

// The endpoint counts a document complete only with the run end field, so a never-run agent is read from its sources (above).
// An agent that ran and stopped has a complete document under E1; queued again from the website, today's map says Waiting.
test('a stopped agent queued again from the website shows Waiting, as today (complete run-group document, no start group)', async () => {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'cs-life-alice2@example.test' }] });
  const alice = f.personIds[0]!, token = await idTokenFor('cs-life-alice2@example.test');
  const { agentId } = await scope(() => registerAgent(alice, 'again-ant', () => at)) as { agentId: string };
  const run = await scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => at));
  at += 1000;
  await scope(() => reportPhase(agentId, run.run_id, { phase: 'stopping' }, () => at));
  at += 1000;
  await createWebAgentStart(alice, { id: randomUUID(), projectId: TEST_PROJECT, name: 'again-ant', agentId,
    execution: { provider: 'codex', model: null }, approved: true }, () => at);
  const [row] = await parity(token, alice, [agentId]);
  expect(row!.today).toBe('waiting');
  expect(row!.endpoint).toBe(row!.today);
});
