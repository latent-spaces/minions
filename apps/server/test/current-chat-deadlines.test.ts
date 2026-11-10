import express from 'express';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { inProject, db } from '../src/firestore.js';
import { presence, runs, inboxes, messagesV2, chatDeadlineReceipts } from '../src/v2/records.js';
import { assertCurrentRun, assertRunInTransaction, reportPhase, startRun } from '../src/v2/runs.js';
import { readUpdates } from '../src/v2/inbox.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { v2Routes } from '../src/v2/routes.js';
import { resetEmulator, scoped, seed, loadAgent, TEST_PROJECT } from './helpers.js';

const STEP = 300_000;
let at: number, server: Server, base: string;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeEach(async () => {
  await resetEmulator(); at = 2_000_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => at);
  const app = express(); app.use(express.json());
  app.use('/v2', scoped(v2Routes(() => at)));
  const other = v2Routes(() => at);
  app.use('/other/v2', (req, res, next) => inProject('b'.repeat(64), () => other(req, res, next)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});
const fixture = () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }],
  agents: [{ person: 0, name: 'Chat' }, { person: 0, name: 'Other' }] });
async function post(token: string, path: string, body: object, prefix = '/v2') {
  const response = await fetch(base + prefix + path, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const grant = (minutes = 5) => ({ client_run_id: randomUUID(), runner_version: 'synthetic-chat', approved_at: at, deadline_at: at + minutes * 60_000 });

test('chat registration requires an explicit bounded lifetime and never starts a model or worker session', async () => {
  const { agents: [agent] } = await fixture();
  const valid = grant();
  for (const body of [
    { client_run_id: valid.client_run_id, runner_version: valid.runner_version },
    { ...valid, takeover: true }, { ...valid, deadline_at: at + 60_000 },
    { ...valid, approved_at: at + 1, deadline_at: at + STEP + 1 },
    { ...valid, deadline_at: at + (24 * 60 + 5) * 60_000 }, { ...valid, deadline_at: at },
  ]) expect((await post(agent.token, '/chat-participations', body)).status).toBe(400);
  expect((await scope(() => runs().get())).size).toBe(0);
  const started = await post(agent.token, '/chat-participations', valid);
  expect(started.status).toBe(200);
  expect(started.body).toMatchObject({ run_id: valid.client_run_id, generation: 1, protocol: 2 });
  const current = (await scope(() => runs().doc(agent.agentId).get())).data()!;
  expect(current).toMatchObject({ mode: 'current_chat', approvedAt: valid.approved_at, deadlineAt: valid.deadline_at });
  expect(current).not.toHaveProperty('model'); expect(current).not.toHaveProperty('provider');
  expect((await scope(() => presence().doc(agent.agentId).get())).data()?.lastTurn).toBeNull();
});

test('chat lifetime is independent of contact freshness and blocks background takeover until expiry', async () => {
  const { agents: [agent] } = await fixture(), input = grant(10);
  expect((await post(agent.token, '/chat-participations', input)).status).toBe(200);
  at += 180_000;
  expect((await post(agent.token, '/chat-participations', grant())).body.error).toBe('run_active');
  expect((await post(agent.token, '/runs', { client_run_id: randomUUID(), runner_version: 'background', takeover: true })).body.error).toBe('run_active');
  at = input.deadline_at;
  await scope(() => presence().doc(agent.agentId).update({ lastContactAt: at }));
  expect((await post(agent.token, '/runs', { client_run_id: randomUUID(), runner_version: 'background' })).status).toBe(200);
  at += 180_000;
  expect((await post(agent.token, '/chat-participations', grant())).body.error).toBe('run_active');
});

test('expiry fences wait, consuming inbox acknowledgements and project mutations transactionally', async () => {
  const f = await fixture(), [agent, other] = f.agents, input = grant();
  const [chat, sender] = await Promise.all(f.agents.map(item => loadAgent(item.agentId)));
  expect((await post(agent.token, '/chat-participations', input)).status).toBe(200);
  await scope(() => sendMessageV2(sender, { to: [agent.agentId], body: 'Retain this unread result.', clientId: 'initial-delivery' }, () => at));
  const read = await scope(() => readUpdates(agent.agentId, undefined, () => at, input.client_run_id));
  expect(read.items.length).toBe(1);
  at = input.deadline_at;
  expect((await post(agent.token, '/wait', { run_id: input.client_run_id })).body.error).toBe('run_superseded');
  expect((await post(agent.token, `/runs/${input.client_run_id}/phase`, { phase: 'idle' })).body.error).toBe('run_superseded');
  await expect(scope(() => assertCurrentRun(agent.agentId, input.client_run_id))).rejects.toMatchObject({ code: 'run_superseded' });
  await expect(scope(() => db.runTransaction(tx => assertRunInTransaction(tx, agent.agentId, input.client_run_id)))).rejects.toMatchObject({ code: 'run_superseded' });
  await expect(scope(() => readUpdates(agent.agentId, read.position, () => at, input.client_run_id))).rejects.toMatchObject({ code: 'run_superseded' });
  await expect(scope(() => sendMessageV2(chat, { to: [other.agentId], body: 'Must not send after expiry.', clientId: 'expired-send' }, () => at, input.client_run_id))).rejects.toMatchObject({ code: 'run_superseded' });
  expect((await scope(() => inboxes().doc(agent.agentId).get())).data()?.acked).toBe(0);
  expect((await scope(() => messagesV2().get())).size).toBe(1);
});

test('extension bounds and expired approvals refuse without receipts or changing the active window', async () => {
  const { agents: [agent] } = await fixture(), input = grant();
  await post(agent.token, '/chat-participations', input);
  const path = `/chat-participations/${input.client_run_id}/deadline`;
  for (const patch of [{ approved_at: at + 1 }, { deadline_at: input.deadline_at },
    { deadline_at: input.deadline_at + 60_000 }, { deadline_at: at + (24 * 60 + 5) * 60_000 }]) {
    const result = await post(agent.token, path, { client_request_id: randomUUID(), expected_deadline_at: input.deadline_at,
      approved_at: at, deadline_at: input.deadline_at + STEP, ...patch });
    expect(result.status).toBe(400);
  }
  expect((await scope(() => chatDeadlineReceipts().get())).size).toBe(0);
  expect((await scope(() => runs().doc(agent.agentId).get())).data()?.deadlineAt).toBe(input.deadline_at);
});

test('agent identity and project boundaries fence chat starts and deadline requests', async () => {
  const { agents: [agent, other] } = await fixture(), input = grant();
  expect((await post('invalid-token', '/chat-participations', input)).status).toBe(401);
  expect((await post(agent.token, '/chat-participations', input, '/other/v2')).status).toBe(401);
  await post(agent.token, '/chat-participations', input);
  const extension = { client_request_id: randomUUID(), expected_deadline_at: input.deadline_at, approved_at: at, deadline_at: input.deadline_at + STEP };
  expect((await post(other.token, `/chat-participations/${input.client_run_id}/deadline`, extension)).body.error).toBe('run_superseded');
  const background = await scope(() => startRun(other.agentId, { clientRunId: randomUUID(), runnerVersion: 'background', takeover: false }, () => at));
  expect((await post(other.token, `/chat-participations/${background.run_id}/deadline`, extension)).body.error).toBe('run_superseded');
  await scope(() => reportPhase(agent.agentId, input.client_run_id, { phase: 'stopping' }, () => at));
});
