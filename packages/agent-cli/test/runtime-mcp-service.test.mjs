import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createFakeAdapterFactory } from './fixtures/runtime-fake-adapter.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';

const target = { site: 'https://synthetic.invalid', ownerId: 'fixture-owner', projectId: 'fixture-project', agentId: 'fixture-agent' };
const publicTarget = { projectId: target.projectId, agentId: target.agentId };
const fakePath = fileURLToPath(new URL('./fixtures/runtime-fake-native.mjs', import.meta.url));
const waitFor = async predicate => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Timed out waiting for fake-agent evidence.');
};
const parse = response => JSON.parse(response.content.find(item => item.type === 'text').text);
async function connect(service, name) {
  const client = new Client({ name, version: '0.0.0-test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }));
  return client;
}
const call = async (client, name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw Object.assign(new Error(parse(response).error.message), { code: parse(response).error.code });
  return parse(response);
};

async function fixture(t, wrap = value => value) {
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-runtime-mcp-'));
  const events = join(directory, 'events.jsonl'), gate = join(directory, 'gate');
  const store = await openRuntimeStore({ directory });
  const controllers = createRuntimeControllers({ store, adapterFactory: createFakeAdapterFactory({
    command: process.execPath, args: [fakePath], cwd: directory, env: {},
    initialInput: (mission, steering) => ({ steering, events, gate: steering.length ? undefined : gate }),
  }) });
  let service;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await service?.close(); await controllers.close(); await store.close(); await rm(directory, { recursive: true, force: true });
  });
  service = await startRuntimeService({ controllers: wrap(controllers), principal: { site: target.site, ownerId: target.ownerId } });
  const a = await connect(service, 'synthetic-Claude-client'); clients.push(a);
  const b = await connect(service, 'synthetic-Codex-client'); clients.push(b);
  return { events, gate, store, service, a, b };
}

test('two MCP clients share durable acceptance and outcomes; steering requires the shared cloud port', async t => {
  const { a, b, store, gate, events } = await fixture(t);
  assert.deepEqual(await call(a, 'get_computer_status'), await call(b, 'get_computer_status'));
  const command = { operationId: randomUUID(), kind: 'start', target: publicTarget, missionId: randomUUID(), payload: { scope: 'Synthetic protocol verification only ' + 'x'.repeat(5000), deadlineAt: Date.now() + 60000, execution: { provider: 'codex', model: null } } };
  const [first, duplicate] = await Promise.all([call(a, 'control_agent', command), call(b, 'control_agent', command)]);
  assert.equal(first.receipt.operationId, duplicate.receipt.operationId);
  assert.equal(first.receipt.generation, duplicate.receipt.generation);
  assert.equal([first, duplicate].filter(item => item.created).length, 1);
  const query = { target: publicTarget, missionId: command.missionId };
  await waitFor(async () => { try { return (await readFile(events, 'utf8')).trim(); } catch {} });
  await assert.rejects(call(a, 'control_agent', { ...command, payload: { ...command.payload, scope: 'Changed command must conflict' } }), { code: 'conflict' });
  await assert.rejects(call(b, 'control_agent', { ...command, operationId: randomUUID(), missionId: randomUUID() }), { code: 'conflict' });
  const steering = { operationId: randomUUID(), kind: 'steer', target: publicTarget, missionId: command.missionId, generation: first.receipt.generation, payload: { message: 'Explain the synthetic result briefly.' } };
  await assert.rejects(call(b,'control_agent',steering),e=>e.code==='unavailable');
  const waiting=await call(a,'get_agent_run',query);
  assert.equal(waiting.steering.length,0);assert.equal(waiting.outcomes.length,0);
  await writeFile(gate,'go');
  const completed=await waitFor(async()=>{const m=await call(b,'get_agent_run',query);return m.outcomes.length===1&&m;});
  assert.equal(completed.steering.length,0);
  assert.deepEqual(await call(b, 'get_agent_control_result', { operationId: command.operationId, target: publicTarget }), first.receipt);
  assert.equal((await a.callTool({name:'get_agent_run',arguments:{...query,target:{...publicTarget,ownerId:'someone-else'}}})).isError,true);
  await assert.rejects(call(b, 'control_agent', { ...steering, operationId: randomUUID(), generation: first.receipt.generation + 1 }), { code: 'unavailable' });
  await call(b, 'control_agent', { operationId: randomUUID(), kind: 'stop', target: publicTarget, missionId: command.missionId, generation: first.receipt.generation, payload: {} });
  await waitFor(async () => (await store.getMission({ ...query, target })).state === 'stopped');
  assert.equal((await store.getMission({ ...query, target })).outcomes.length, 1);
});

test('the gateway checks every method, exact host/origin and bounded schemas', async t => {
  const { a, service } = await fixture(t);
  const auth = { Authorization: `Bearer ${service.token}` };
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await fetch(service.url, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 401);
  }
  assert.equal((await fetch(service.url, { headers: { ...auth, Origin: 'https://foreign.invalid' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(service.url, { headers: { ...auth, Host: 'foreign.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(service.url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const response = await a.callTool({ name: 'control_agent', arguments: {
    operationId: randomUUID(), kind: 'start', target: publicTarget, missionId: randomUUID(),
    payload: { scope: 'Must reject arbitrary execution fields', deadlineAt: Date.now() + 60000, execution: { provider: 'codex', model: null }, command: '/bin/sh' },
  } });
  assert.equal(response.isError, true);
  const oversized = await fetch(service.url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ padding: 'x'.repeat(40000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await call(a, 'get_computer_status')).cloudReady, false);
});

test('a lost command response is reconciled by receipt after its client disconnects', async t => {
  let release, accepted;
  const replyGate = new Promise(resolve => { release = resolve; });
  const acceptedSignal = new Promise(resolve => { accepted = resolve; });
  let delay = true;
  const { a, b, gate, events } = await fixture(t, controllers => ({ ...controllers, async accept(command) {
    const result = await controllers.accept(command);
    if (delay) { delay = false; accepted(result); await replyGate; }
    return result;
  } }));
  t.after(() => release());
  const command = { operationId: randomUUID(), kind: 'start', target: publicTarget, missionId: randomUUID(), payload: { scope: 'Synthetic lost-response check', deadlineAt: Date.now() + 60000, execution: { provider: 'codex', model: null } } };
  const pending = a.callTool({ name: 'control_agent', arguments: command });
  const lost = assert.rejects(pending);
  const original = await acceptedSignal;
  await a.close(); await lost; release();
  assert.deepEqual(await call(b, 'get_agent_control_result', { target: publicTarget, operationId: command.operationId }), original.receipt);
  const retry = await call(b, 'control_agent', command);
  assert.equal(retry.created, false); assert.deepEqual(retry.receipt, original.receipt);
  await writeFile(gate, 'go');
  await waitFor(async () => (await call(b, 'get_agent_run', { target: publicTarget, missionId: command.missionId })).outcomes.length === 1);
  assert.equal((await readFile(events, 'utf8')).trim().split('\n').length, 1);
});


test('retired local browser app has no tool, capability issuer or HTTP ingress', async t => {
  const { service, a } = await fixture(t);
  assert.equal((await a.listTools()).tools.some(tool => tool.name === 'open_project_waiting_room'), false);
  await assert.rejects(call(a, 'open_project_waiting_room', { project_id: 'a'.repeat(64) }), { code: -32602 });
  assert.equal(service.openWaitingRoom, undefined);
  const origin = new URL(service.url).origin;
  for (const path of ['/viewer/local-waiting-room', '/local-ui/waiting-room.js', '/local-ui/waiting-room.css', '/local-ui/waiting-room', '/local-ui/start-project', '/local-ui/steering', '/local-ui/tasks', '/local-ui/task-directory', '/local-ui/task-settings']) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${service.token}`, origin, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(response.status, 401, `${method} ${path} cannot reach an operation`);
      assert.equal((await response.json()).error, 'unauthorized');
    }
  }
});
