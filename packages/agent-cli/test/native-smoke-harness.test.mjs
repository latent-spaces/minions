import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { nativeSmokeCoordination } from '../scripts/native-smoke-coordination.mjs';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { createSteering } from '../src/service/steering.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';
import { hostToolEnvironment } from '../src/windows-command.mjs';
import { createFakeAdapterFactory } from './fixtures/runtime-fake-adapter.mjs';

test('live smoke harness uses current shared steering and saves two turns through real HTTP/store/controller wiring (offline peer, no model)', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-smoke-harness-'));
  const store = await openRuntimeStore({ directory: join(root, 'ledger') });
  const principal = { site: 'https://synthetic.example', ownerId: 'synthetic-owner' };
  const coordination = nativeSmokeCoordination(principal);
  const gate = join(root, 'gate');
  const controllers = createRuntimeControllers({ store, cloudFactory: coordination.cloudFactory, observeIntervalMs: 20,
    adapterFactory: createFakeAdapterFactory({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime-fake-native.mjs', import.meta.url))], cwd: root, env: hostToolEnvironment(), initialInput: (_mission, steering) => ({ gate, steering }) }),
  });
  const steering = createSteering({ store, principal, accountClient: coordination.accountClient });
  const application = createRuntimeApplication({ controllers, principal, steering });
  const service = await startRuntimeService({ controllers, principal, application });
  const client = new Client({ name: 'synthetic-smoke-operator', version: '1.0.0' });
  t.after(async () => { await controllers.close(); await client.close(); await service.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }));
  const call = async (name, args) => { const reply = await client.callTool({ name, arguments: args }); assert.ok(!reply.isError, JSON.stringify(reply)); return JSON.parse(reply.content[0].text); };
  const target = { projectId: 'synthetic-project', agentId: 'synthetic-agent' }, missionId = randomUUID();
  const { mission } = await call('control_agent', { operationId: randomUUID(), missionId, kind: 'start', target, payload: { scope: 'Synthetic smoke wiring', deadlineAt: Date.now() + 30000, execution: { provider: 'claude', model: 'synthetic' } } });
  const read = () => call('get_agent_run', { target, missionId });
  const until = async predicate => { for (const end = Date.now() + 15000; Date.now() < end;) { const state = await read(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Smoke harness state did not settle.'); };
  await until(state => state.currentTurnStage === 'submitted');
  const id = randomUUID();
  await call('control_agent', { operationId: id, missionId, generation: mission.generation, kind: 'steer', target, payload: { message: 'Synthetic follow-up only.' } });
  await until(state => state.outcomes.length === 0 && state.steering.find(item => item.operationId === id)?.state === 'queued');
  await writeFile(gate, 'go');
  const completed = await until(state => state.outcomes.length === 2);
  assert.equal(completed.steering[0].state, 'applied');
  assert.ok(completed.outcomes.every(item => item.outcome.delivery === 'acknowledged' && item.outcome.cleanupConfirmed === true));
  await call('control_agent', { operationId: randomUUID(), missionId, generation: mission.generation, kind: 'stop', target, payload: {} });
  await until(state => state.state === 'stopped');
  assert.equal((await store.getMission({ target: mission.target, missionId })).outcomes.length, 2);
});
