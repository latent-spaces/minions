import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../src/service/contracts.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { createCloudRuntime } from '../src/service/cloud-runtime.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = reply => JSON.parse(reply.content.find(item => item.type === 'text').text);
async function call(client, name, args = {}) {
  const reply = await client.callTool({ name, arguments: args });
  if (reply.isError) throw Object.assign(new Error(value(reply).error?.message ?? 'Participation refused'), { code: value(reply).error?.code });
  return value(reply);
}
async function until(read, predicate, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const result = await read(); if (predicate(result)) return result; await sleep(20); }
  assert.fail(`Timed out: ${label}`);
}
const grant = deadlineAt => ({ approved: true, approvedAt: deadlineAt - 300000, deadlineAt });
const publicTarget = ({ projectId, agentId }) => ({ projectId, agentId });
const claim = (target, deadlineAt = Date.now() + 300000) => ({ operationId: randomUUID(), kind: 'claim',
  target: publicTarget(target), participationId: randomUUID(), payload: { ...grant(deadlineAt), scope: `Synthetic scope for ${target.projectId}` } });
const action = (record, kind, payload = {}) => ({ operationId: randomUUID(), kind,
  target: publicTarget(record.target), participationId: record.participationId, generation: record.generation, payload });
const query = record => ({ target: record.target, participationId: record.participationId });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-participation-routing-'));
  // Cleanup is registered before any resource exists: a setup failure must not leave the store worker alive and hang the runner.
  const clients = []; let store, runtime, service;
  t.after(async () => {
    await Promise.all(clients.map(client => client.close().catch(() => {}))); await service?.close();
    await runtime?.close(); await store?.close(); await rm(root, { recursive: true, force: true });
  });
  const principal = { site: 'http://127.0.0.1:8787', ownerId: 'synthetic-owner' };
  const bindings = [];
  for (const projectId of ['garden', 'park']) {
    const folder = join(root, `${projectId}-checkout`), stateDir = join(root, `${projectId}-private`);
    await mkdir(folder); await mkdir(stateDir, { mode: 0o700 });
    const target = { ...principal, projectId, agentId: `${projectId}-agent` };
    bindings.push({ target, url: `${principal.site}/p/${projectId}`, token: `${projectId}-private-token`, folder, stateDir });
  }
  const calls = [], runs = new Map(), hangs = new Set(); let nativeStarts = 0;
  const fetchImpl = async (url, options) => {
    const binding = bindings.find(item => url.startsWith(`${item.url}/v2/`));
    assert.ok(binding, 'Only exact configured project endpoints are contacted');
    assert.equal(options.headers.authorization, `Bearer ${binding.token}`);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body), path = url.slice(binding.url.length);
    calls.push({ target: binding.target, path, body });
    const response = data => new Response(JSON.stringify(data), { status: 200 });
    if (path === '/v2/chat-participations') {
      let run = runs.get(body.client_run_id);
      if (!run) { run = { id: body.client_run_id, deadlineAt: body.deadline_at, generation: runs.size + 1, stopped: false }; runs.set(run.id, run); }
      return response({ run_id: run.id, generation: run.generation, poll_seconds: 20, protocol: 2 });
    }
    if (/^\/v2\/chat-participations\/[^/]+\/deadline$/.test(path)) {
      const id = path.split('/')[3]; runs.get(id).deadlineAt = body.deadline_at;
      return response({ run_id: id, deadline_at: body.deadline_at });
    }
    if (/^\/v2\/runs\/[^/]+\/phase$/.test(path)) {
      const id = path.split('/')[3]; if (runs.has(id)) runs.get(id).stopped = true;
      return response({ ok: true, run_id: id, phase: 'stopping' });
    }
    assert.equal(path, '/v2/mcp');
    const run = runs.get(options.headers['x-pilot-run']); assert.ok(run);
    const name = body.params.name;
    if (name === 'read_agent_inbox' && hangs.has(binding.target.projectId)) return await new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Synthetic wait cancelled'));
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    });
    const result = name === 'get_project' ? { project: { name: binding.target.projectId, started: true, paused: false, completedAt: null,
      mission: 'Synthetic test', rules: 'No models or production changes', repoUrl: 'https://github.com/test/example', mergeApproval: 'humans' },
      you: { agentId: binding.target.agentId, participation: { identity: { projectId: binding.target.projectId, agentId: binding.target.agentId, profileId: principal.ownerId }, persona: { text: '', revision: 0 }, observedAt: Date.now() } } }
      : { project: binding.target.projectId, messages: [] };
    return response({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  };
  store = await openRuntimeStore({ directory: join(root, 'ledger') });
  const scopedBindings = bindings.map(binding => ({ ...binding, fetchImpl }));
  runtime = createCloudRuntime({ store, cloudBindings: scopedBindings, participationBindings: scopedBindings,
    adapterFactory: async () => { nativeStarts++; throw new Error('No native model is permitted'); }, deliveryIntervalMs: 10000, participationSweepIntervalMs: 20 });
  const { controllers, delivery, participation } = runtime;
  const workerOperations = {
    listTools: () => [{ name: 'get_project', description: 'Schema isolation fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    callTool: async (_caller, name, args) => {
      // The real worker port owns strict bundled-schema validation. This fixture
      // models its empty get_project schema; the real port has separate HTTP tests.
      if(name!=='get_project' || Object.keys(args).length) throw new RuntimeError('bad_input','Use only worker arguments.');
      return { content: [{ type: 'text', text: JSON.stringify({ worker: true }) }] };
    },
  };
  const application = createRuntimeApplication({ controllers, principal, participation, workerOperations });
  service = await startRuntimeService({ controllers, principal, application });
  async function connect(name) {
    const client = new Client({ name, version: '0.0.0-test' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }));
    clients.push(client); return client;
  }
  return { bindings, calls, runs, hangs, participation, application, connect, delivery, get nativeStarts() { return nativeStarts; } };
}

test('explicit release cancels a consuming wait without affecting another project or schema capability', { timeout: 15000 }, async t => {
  const f = await fixture(t), a = await f.connect('synthetic-chat-A'), b = await f.connect('synthetic-chat-B');
  const first = (await call(a, 'work_in_this_chat', claim(f.bindings[0].target))).participation;
  const second = (await call(b, 'work_in_this_chat', claim(f.bindings[1].target))).participation;
  await call(a, 'get_project', { participation_ref: first.participationRef });
  await call(b, 'get_project', { participation_ref: second.participationRef });
  f.hangs.add('garden');
  const waiting = a.callTool({ name: 'read_agent_inbox', arguments: { participation_ref: first.participationRef } });
  await until(async () => f.calls, calls => calls.some(item => item.path === '/v2/mcp' && item.target.projectId === 'garden' && item.body.params.name === 'read_agent_inbox'), 'consuming wait started');
  await call(b, 'work_in_this_chat', action(first, 'release'));
  assert.equal((await waiting).isError, true);
  assert.equal((await call(b, 'read_agent_inbox', { participation_ref: second.participationRef })).project, 'park');
  // The same name has different strict schemas for participant-routed owner and native-worker calls.
  const caller = { kind: 'worker', target: second.target, missionId: randomUUID(), generation: 1 };
  assert.equal(value(await f.application.callTool(caller, 'get_project', {})).worker, true);
  assert.equal((await f.application.callTool(caller, 'get_project', { participation_ref: first.participationRef })).isError, true);
  const foreign = { ...query(second), target: { ...second.target, ownerId: 'another-owner' } };
  assert.equal((await b.callTool({ name: 'get_chat_work', arguments: foreign })).isError, true);
  await call(b, 'work_in_this_chat', action(second, 'release')); assert.equal(f.nativeStarts, 0);
});
