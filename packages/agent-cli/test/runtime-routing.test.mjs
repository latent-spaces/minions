import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from './fixtures/recorded-controllers.mjs';
import { createNativeAdapterFactory } from '../src/service/native-bindings.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';
import { createRunEvidence } from '../src/service/run-evidence.mjs';
import { makeMixedNativeFixtures, nativeEvents } from './fixtures/mixed-native-fixtures.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runFile = promisify(execFile);
async function until(read, predicate, label) {
  const deadline = Date.now() + 12000;
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await sleep(15); }
  assert.fail(`Timed out: ${label}; last value: ${JSON.stringify(value)}`);
}
const parse = response => JSON.parse(response.content.find(item => item.type === 'text').text);
async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const value = parse(response);
  if (response.isError) throw Object.assign(new Error(value.error?.message ?? 'Tool failed'), { code: value.error?.code });
  return value;
}
async function connect(endpoint, name) {
  const client = new Client({ name, version: '0.0.0-test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
  }));
  return client;
}
const publicTarget = target => ({ projectId: target.projectId, agentId: target.agentId });
const query = mission => ({ target: publicTarget(mission.target), missionId: mission.missionId });
const command = (mission, kind, payload = {}) => ({ operationId: randomUUID(), kind,
  target: publicTarget(mission.target), missionId: mission.missionId, generation: mission.generation, payload });
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm-routing-')));
  const native = await makeMixedNativeFixtures(root, undefined, (label, directory) => [{ gate: join(directory, `gate-${label}`) }]);
  const principal = { site: native.bindings[0].target.site, ownerId: native.bindings[0].target.ownerId };
  const workerCalls = [], ownerCalls = [], discoveryCalls = [], issued = new Map();
  let service;
  for (const binding of native.bindings) binding.createBridge = async mission => {
    const endpoint = await service.issueWorker({ target: mission.target, missionId: mission.missionId, generation: mission.generation });
    issued.set(`${mission.target.projectId}-${mission.target.agentId}`, endpoint);
    return endpoint;
  };
  const store = await openRuntimeStore({ directory: join(root, 'ledger') });
  const controllers = createRuntimeControllers({ store, adapterFactory: createNativeAdapterFactory(native) });
  const workerOperations = {
    listTools: () => [{ name: 'get_project', description: 'Synthetic exact identity', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    async callTool(caller, name, args) {
      workerCalls.push({ caller, name, args });
      return result({ you: { agentId: caller.target.agentId, participation: { identity: {
        projectId: caller.target.projectId, agentId: caller.target.agentId, profileId: caller.target.ownerId,
      } } }, project: { name: `Synthetic ${caller.target.projectId}` } });
    },
  };
  const application = createRuntimeApplication({ controllers, steering:controllers.steering, principal, workerOperations,
    evidence: createRunEvidence({controllers,principal,resolveBinding:target=>native.bindings.find(item=>JSON.stringify(item.target)===JSON.stringify(target)),registryRoot:native.registryRoot,
      resolveJournalDirectory:mission=>join(native.bindings.find(item=>JSON.stringify(item.target)===JSON.stringify(mission.target)).stateDir,`mission-${mission.missionId}-${mission.generation}`)}),
    ownerClient: {
      async operation(name, args, options) {
        assert.equal(options.expectedProfileId, principal.ownerId);
        ownerCalls.push({ name, args, options });
        return { synthetic: true, operation: name, project_id: args.project_id ?? null };
      },
    },
    discovery: { async call(name, args) { discoveryCalls.push({ name, args }); return { projects: [], synthetic: true }; } },
    guide: 'Synthetic guide, no model execution.',
  });
  service = await startRuntimeService({ controllers, principal, application, home: join(root, 'endpoint') });
  const clients = [];
  const owner = async name => { const client = await connect(service, name); clients.push(client); return client; };
  t.after(async () => {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    await service.close(); await controllers.close(); await store.close(); await rm(root, { recursive: true, force: true });
  });
  return { root, ...native, principal, store, controllers, application, service, issued, clients, owner,
    workerCalls, ownerCalls, discoveryCalls };
}

test('two owner clients route mixed project teams through one controller and survive all control-window disconnects', { timeout: 35000 }, async t => {
  const ctx = await fixture(t);
  let a = await ctx.owner('synthetic-Claude-owner'), b = await ctx.owner('synthetic-Codex-owner');
  assert.deepEqual(await call(a, 'get_computer_status'), await call(b, 'get_computer_status'));
  const commands = ctx.bindings.map(binding => ({ operationId: randomUUID(), kind: 'start', target: publicTarget(binding.target),
    missionId: randomUUID(), payload: { scope: `Synthetic scope only ${binding.target.projectId}/${binding.target.agentId}`,
      execution: { provider: binding.target.agentId, model: null } } }));
  const starts = await Promise.all(commands.map((start, index) => call(index % 2 ? a : b, 'control_agent', start)));
  const missions = starts.map(start => start.mission);
  const first = await until(() => nativeEvents(ctx.events), events => events.filter(event => event.type === 'turn').length === 4, 'four native protocol peers');
  assert.equal(new Set(first.map(event => event.sessionId)).size, 4);
  assert.equal(new Set(first.map(event => event.cwd)).size, 4);
  for (const binding of ctx.bindings) {
    const event = first.find(event => event.cwd === binding.folder);
    assert.equal(event.provider, binding.target.agentId);
    assert.match(event.prompt, new RegExp(`Rules for ${binding.target.projectId}`));
    const endpoint = ctx.issued.get(`${binding.target.projectId}-${binding.target.agentId}`);
    assert.notEqual(endpoint.token, ctx.service.token);
    if (event.provider === 'claude') assert.equal(event.mcp.mcpServers.pilot.headers.Authorization, `Bearer ${endpoint.token}`);
    else assert.equal(event.bridgeToken, endpoint.token);
    assert.equal(JSON.stringify(event).includes(ctx.service.token), false);
  }
  const duplicate = await call(a, 'control_agent', commands[0]);
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.receipt, starts[0].receipt);
  await Promise.all(missions.map(mission => call(b, 'control_agent', command(mission, 'steer', { message: `Only ${mission.target.projectId}/${mission.target.agentId}` }))));
  for (const mission of missions) assert.equal((await call(a, 'get_agent_run', query(mission))).steering[0].state, 'queued');

  // The actual native peers are still gated: closing every owner connection is not stop.
  await Promise.all([a.close(), b.close()]);
  await sleep(60);
  for (const event of first) assert.doesNotThrow(() => process.kill(event.pid, 0));
  assert.equal((await nativeEvents(ctx.events)).filter(event => event.type === 'turn').length, 4);
  a = await ctx.owner('synthetic-reconnected-owner');
  const summaries = await call(a, 'list_agent_runs', { limit: 10 });
  assert.equal(summaries.missions.length, 4);
  assert.deepEqual(new Set(summaries.missions.map(mission => mission.target.projectId)), new Set(['garden', 'park']));
  await call(a, 'control_agent', command(missions[0], 'stop'));
  await until(() => call(a, 'get_agent_run', query(missions[0])), mission => mission.state === 'stopped', 'one independent stop');
  for (const event of first.filter(event => event.cwd !== ctx.bindings[0].folder)) assert.doesNotThrow(() => process.kill(event.pid, 0));
  for (const binding of ctx.bindings.slice(1)) await writeFile(join(ctx.root, `gate-${binding.target.projectId}-${binding.target.agentId}`), 'release');
  for (const mission of missions.slice(1)) {
    const done = await until(() => call(a, 'get_agent_run', query(mission)), value => value.outcomes.length === 2, 'own queued steering applied');
    assert.equal(done.steering[0].state, 'applied');
    assert.equal(done.outcomes[1].outcome.usage.provider, mission.execution.provider);
  }
  const turns = (await nativeEvents(ctx.events)).filter(event => event.type === 'turn');
  assert.equal(turns.length, 7);
  for (const binding of ctx.bindings.slice(1)) {
    const own = turns.filter(event => event.cwd === binding.folder);
    assert.equal(own[0].sessionId, own[1].sessionId);
    assert.match(own[1].prompt, new RegExp(`Only ${binding.target.projectId}/${binding.target.agentId}`));
    for (const other of ctx.bindings.filter(item => item !== binding)) assert.equal(own[1].prompt.includes(`Only ${other.target.projectId}/${other.target.agentId}`), false);
  }
  // Actual adapters/collectors, four synthetic workers, two projects: evidence is
  // observational, scoped and readable through both owner clients and the CLI.
  const turnsBefore = turns.length;
  for (const mission of missions) {
    const snapshot = await call(a,'get_agent_run',query(mission));
    const log = await call(a,'get_agent_run_log',{...query(mission),limit:100});
    assert.equal(log.availability,'available');
    assert.ok(log.records.some(record=>record.kind==='assistant_text'));
    assert.ok(log.records.some(record=>record.kind==='native_started'));
    assert.ok(log.records.some(record=>record.kind==='attempt_finished'));
    for (const record of log.records) assert.ok(snapshot.outcomes.some(outcome=>outcome.turnId===record.turnId));
    assert.ok(snapshot.outcomes.every(outcome=>outcome.outcome.evidence.availability==='available'));
    assert.ok(!JSON.stringify(log).includes(ctx.service.token));
    for (const endpoint of ctx.issued.values()) assert.ok(!JSON.stringify(log).includes(endpoint.token));
    const diagnostic = await call(a,'get_agent_run_diagnostics',query(mission));
    assert.equal(diagnostic.readOnly,true);assert.equal(diagnostic.automaticRecoverySupported,false);
    assert.deepEqual(await call(a,'get_agent_run',query(mission)),snapshot);
  }
  const selected=missions[1];
  const cli=await runFile(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),
    'run-log','--state-dir',join(ctx.root,'endpoint'),'--mission',selected.missionId,'--project',selected.target.projectId,'--agent',selected.target.agentId,'--limit','1'],{
    env:{PATH:process.env.PATH,HOME:ctx.envSource.HOME},timeout:10000,
  });
  assert.equal(JSON.parse(cli.stdout).records.length,1);
  assert.equal((await nativeEvents(ctx.events)).filter(event=>event.type==='turn').length,turnsBefore);
});

test('worker mission credentials cannot cross owner, target or stopped-turn boundaries', { timeout: 30000 }, async t => {
  const ctx = await fixture(t), owner = await ctx.owner('synthetic-owner');
  const binding = ctx.bindings[0];
  const start = { operationId: randomUUID(), kind: 'start', target: publicTarget(binding.target), missionId: randomUUID(),
    payload: { scope: 'Synthetic credential boundary only', execution: { provider: 'claude', model: null } } };
  const { mission } = await call(owner, 'control_agent', start);
  const secondBinding = ctx.bindings[3];
  await call(owner, 'control_agent', { ...start, operationId: randomUUID(), missionId: randomUUID(), target: publicTarget(secondBinding.target),
    payload: { ...start.payload, execution: { provider: 'codex', model: null } } });
  await until(() => nativeEvents(ctx.events), events => events.filter(event => event.type === 'turn').length === 2, 'two active synthetic workers');
  const endpoint = ctx.issued.get('garden-claude');
  const secondEndpoint = ctx.issued.get('park-codex');
  for (const [url, token] of [[ctx.service.url, endpoint.token], [endpoint.url, ctx.service.token],
    [endpoint.url, secondEndpoint.token], [secondEndpoint.url, endpoint.token]]) {
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  }
  await assert.rejects(ctx.service.issueWorker({ target: mission.target, missionId: mission.missionId, generation: mission.generation + 1 }), { code: 'conflict' });
  await assert.rejects(ctx.service.issueWorker({ missionId: mission.missionId, target: { ...mission.target, ownerId: 'another-owner' }, generation: mission.generation }), { code: 'forbidden' });
  const worker = await connect(endpoint, 'synthetic-worker'); ctx.clients.push(worker);
  const catalog = await worker.listTools();
  assert.deepEqual(catalog.tools.map(tool => tool.name), ['get_project']);
  const identity = await call(worker, 'get_project');
  assert.equal(identity.you.agentId, binding.target.agentId);
  assert.deepEqual(ctx.workerCalls.at(-1).caller, { kind: 'worker', target: binding.target, missionId: mission.missionId, generation: mission.generation });
  await assert.rejects(worker.callTool({ name: 'control_agent', arguments: start }), { code: -32602 });
  await assert.rejects(worker.callTool({ name: 'get_agent_run_log', arguments: query(mission) }), { code: -32602 });
  await assert.rejects(worker.callTool({ name: 'get_agent_run_diagnostics', arguments: query(mission) }), { code: -32602 });
  assert.equal((await worker.callTool({ name: 'get_project', arguments: { target: { ...binding.target, projectId: 'park' } } })).isError, true);
  assert.equal(ctx.workerCalls.length, 1);
  await assert.rejects(owner.callTool({ name: 'get_project', arguments: {} }), { code: -32602 });
  await call(owner, 'control_agent', command(mission, 'stop'));
  await until(() => call(owner, 'get_agent_run', query(mission)), value => value.state === 'stopped', 'stop revokes worker route');
  await assert.rejects(call(worker, 'get_project'));
  assert.equal(ctx.workerCalls.length, 1);
});

test('owner catalog routes management and public discovery without worker authority or native execution', { timeout: 15000 }, async t => {
  const ctx = await fixture(t), owner = await ctx.owner('synthetic-management-owner');
  const listed = await owner.listTools();
  const names = listed.tools.map(tool => tool.name);
  assert.ok(names.includes('list_project_agents'));
  assert.ok(names.includes('explore_projects'));
  assert.ok(names.includes('control_agent'));
  assert.equal(names.includes('read_agent_inbox'), false);
  assert.equal(names.includes('connect_project_agent'), false);
  for (const tool of listed.tools) assert.equal('owner_ref' in (tool.inputSchema.properties ?? {}), false);
  const project_id = 'a'.repeat(64);
  const management = await call(owner, 'list_project_agents', { project_id });
  assert.equal(management.operation, 'list_project_agents');
  assert.equal(management.project_id, project_id);
  const cli = await runFile(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
    'project-agents', '--project', project_id, '--state-dir', join(ctx.root, 'endpoint')], {
    env: { PATH: process.env.PATH, HOME: ctx.envSource.HOME }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(cli.stdout), management);
  assert.equal(cli.stderr.includes(ctx.service.token), false);
  await call(owner, 'explore_projects', {});
  assert.equal(ctx.discoveryCalls.length, 1);
  assert.equal((await owner.callTool({ name: 'list_project_agents', arguments: { project_id, owner_ref: 'retired-process-selector' } })).isError, true);
  assert.equal(ctx.ownerCalls.length, 2);
  assert.deepEqual(await nativeEvents(ctx.events), []);
  await assert.rejects(readFile(join(ctx.root, 'ledger', 'worker-mission.json')), { code: 'ENOENT' });
});
