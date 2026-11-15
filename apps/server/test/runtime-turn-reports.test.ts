import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { presence, runnerUsage, runs, turnReceipts } from '../src/v2/records.js';
import { listMyWorkers } from '../src/projects/worker-sessions.js';
import { v2Routes } from '../src/v2/routes.js';
import { resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let at = 2_000_000_000_000, server: Server, base: string;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeEach(async () => {
  await resetEmulator(); at = 2_000_000_000_000;
  const app = express(); app.use(express.json()); app.use('/v2', scoped(v2Routes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v2`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const fixture = () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }], agents: [{ person: 0, name: 'Synthetic' }] });
async function post(token: string, path: string, body: object) {
  const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const start = (token: string) => post(token, '/runs', { runner_version: 'runtime-cloud-test', client_run_id: randomUUID() });
const turn = (sequence = 1) => ({ kind: 'work', outcome: 'succeeded', ended_at: 2_000_000_000_500,
  usage: { sequence, model: 'synthetic-model', provider: 'codex', modelSource: 'provider-report', inputSemantics: 'includes-cache', seconds: 1.5,
    context: {scope:'minions-supplied',coverage:'partial',instructionBytes:10,turnPromptBytes:20,catalogRequests:1,catalogBytes:30,tools:[{category:'coordination',calls:1,argumentBytes:2,responseTextBytes:40,refusals:0}]},
    nativeContext:{source:'codex-app-server',coverage:'partial-turn-stream',lastInputTokens:80,lastTotalTokens:90,modelContextWindow:200,observations:1,completedCompactions:1},
    tokens: { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, modelCalls: 1 } } });

test('identical report retries return the exact receipt and charge usage once; changed evidence conflicts', async () => {
  const f = await fixture(), agent = f.agents[0], run = await start(agent.token);
  expect(run.status).toBe(200);
  const input = { run_id: run.body.run_id, last_turn: turn() };
  const first = await post(agent.token, '/turn-reports', input), retry = await post(agent.token, '/turn-reports', input);
  const reportId = createHash('sha256').update(JSON.stringify([agent.agentId, run.body.run_id, 1])).digest('hex');
  expect(first).toEqual({ status: 200, body: { ok: true, report_id: reportId, duplicate: false } });
  expect(retry).toEqual({ status: 200, body: { ok: true, report_id: reportId, duplicate: true } });
  expect((await scope(() => turnReceipts().get())).size).toBe(1);
  expect((await scope(() => turnReceipts().get())).docs[0]!.data().lastTurn.usage?.context).toEqual(turn().usage.context);
  expect((await scope(() => turnReceipts().get())).docs[0]!.data().lastTurn.usage?.nativeContext).toEqual(turn().usage.nativeContext);
  expect((await scope(() => runnerUsage().doc(agent.agentId).get())).data()).toMatchObject({ turns: 1, input: 11, output: 7, cacheRead: 5, cacheWrite: 2, inputSemantics: 'includes-cache', seconds: 1.5 });
  const changed = await post(agent.token, '/turn-reports', { ...input, last_turn: { ...input.last_turn, outcome: 'failed' } });
  expect(changed.status).toBe(409); expect(changed.body.error).toBe('runtime_conflict');
  expect((await scope(() => runnerUsage().doc(agent.agentId).get())).data()?.turns).toBe(1);
});

test('Claude stream-json context observations are accepted beside Codex ones', async () => {
  const f = await fixture(), agent = f.agents[0], run = await start(agent.token), last = turn();
  last.usage.nativeContext = { ...last.usage.nativeContext, source: 'claude-stream-json' };
  expect((await post(agent.token, '/turn-reports', { run_id: run.body.run_id, last_turn: last })).status).toBe(200);
  expect((await scope(() => turnReceipts().get())).docs[0]!.data().lastTurn.usage?.nativeContext?.source).toBe('claude-stream-json');
  const unknown = turn(2); unknown.usage.nativeContext = { ...unknown.usage.nativeContext, source: 'other-client' };
  expect((await post(agent.token, '/turn-reports', { run_id: run.body.run_id, last_turn: unknown })).status).toBe(400);
});

test('historical reports retain current membership fencing and cannot fabricate an unissued run', async () => {
  const f = await fixture(), agent = f.agents[0], run = await start(agent.token);
  expect((await post(agent.token, '/turn-reports', { run_id: randomUUID(), last_turn: turn() })).status).toBe(409);
  await membershipDoc(TEST_PROJECT, f.personIds[0]).update({ status: 'removed' });
  const refused = await post(agent.token, '/turn-reports', { run_id: run.body.run_id, last_turn: turn() });
  expect(refused.status).toBe(401);
  expect((await scope(() => turnReceipts().get())).size).toBe(0);
  expect((await scope(() => runnerUsage().doc(agent.agentId).get())).exists).toBe(false);
});


test('HTTP restarts reuse one five-minute window; new runs and stop-only sessions ignore older timestamps', async () => {
  const f = await fixture(), agent = f.agents[0], deadlineAt = at + 300000;
  const sessions: { run_id: string; missionId: string; startedAt: number; deadlineAt: number; remainingSlots: number; phase: string; generation: number }[] = [];
  const stops: { path: string; payload: object; reply: Awaited<ReturnType<typeof post>> }[] = [];
  // Each launch constructs fresh input, as separate connector installations do.
  for (let attempt = 0; attempt < 5; attempt++) {
    const run = await start(agent.token); expect(run.status).toBe(200);
    const session = { run_id: run.body.run_id, missionId: run.body.run_id,
      startedAt: deadlineAt - 300000, deadlineAt, remainingSlots: 64, phase: 'waiting', generation: 1 };
    if (attempt !== 2) {
      expect((await post(agent.token, '/worker-session', session)).status).toBe(200);
      expect((await post(agent.token, '/worker-session', session)).status).toBe(200);
    }
    const worker_session = { ...session, remainingSlots: 0, phase: 'stopped' };
    const path = `/runs/${run.body.run_id}/phase`, payload = { phase: 'stopping', worker_session };
    const reply = await post(agent.token, path, payload); expect(reply.status).toBe(200);
    if (attempt === 0) expect(await post(agent.token, path, payload)).toEqual(reply);
    sessions.push(session); stops.push({ path, payload, reply });
  }
  expect(at).toBe(deadlineAt - 300000);
  // Respect the independent six-stop-report/minute admission guard when checking
  // historical delivery retries; no launch needed a later approved deadline.
  at += 61000;
  // An equal advertised start must not hide the preceding terminal session.
  const latest = await scope(() => listMyWorkers(f.personIds[0], () => at));
  expect(latest.agents[0].worker.session?.missionId).toBe(sessions.at(-1)!.missionId);
  const beforeRun = (await scope(() => runs().doc(agent.agentId).get())).data();
  const beforePresence = (await scope(() => presence().doc(agent.agentId).get())).data();
  expect(await post(agent.token, stops[0].path, stops[0].payload)).toEqual(stops[0].reply);
  expect((await post(agent.token, '/worker-session', { ...sessions[0], startedAt: at + 300000, deadlineAt: at + 600000 })).body.error).toBe('run_superseded');
  expect((await post(agent.token, stops[0].path, { ...stops[0].payload, reason: 'operator' })).status).toBe(409);
  expect((await scope(() => runs().doc(agent.agentId).get())).data()).toEqual(beforeRun);
  expect((await scope(() => presence().doc(agent.agentId).get())).data()).toEqual(beforePresence);
  expect(await scope(() => listMyWorkers(f.personIds[0], () => at))).toEqual(latest);
});

test('a stop for a missing checkout keeps its reason, so the owner sees why the run ended', async () => {
  const f = await fixture(), agent = f.agents[0], run = await start(agent.token);
  const reply = await post(agent.token, `/runs/${run.body.run_id}/phase`, { phase: 'stopping', reason: 'checkout_missing' });
  expect(reply.status).toBe(200);
  expect((await scope(() => runs().doc(agent.agentId).get())).data()).toMatchObject({ endedAt: at, endReason: 'checkout_missing' });
  expect((await scope(() => listMyWorkers(f.personIds[0], () => at))).agents[0].lastRun).toMatchObject({ endReason: 'checkout_missing' });
});
