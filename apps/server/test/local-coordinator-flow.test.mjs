import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from 'vitest';
import { hashToken } from '../src/auth.js';
import { collection, inProject, profiles } from '../src/firestore.js';
import { connectOwnAgent } from '../src/owner/agents.js';
import { acceptAgentStart, createWebAgentStart, inspectAgentStart, cancelAgentStart, readAgentStartCancellation, publishRuntimeReadiness, readAgentStarts, readWebAgentStart, receiptAgentStart } from '../src/owner/web-agent-starts.js';
import { createPrivateProject } from '../src/projects/private.js';
import { resetEmulator, seed, seedRuntime } from './helpers.js';
import { createRuntimeApplication } from '../../../packages/agent-cli/src/service/application.mjs';
import { createRuntimeControllers } from '../../../packages/agent-cli/src/service/controllers.mjs';
import { startRuntimeService } from '../../../packages/agent-cli/src/service/mcp-service.mjs';
import { openRuntimeStore } from '../../../packages/agent-cli/src/service/store.mjs';
import { createWebAgentStarts } from '../../../packages/agent-cli/src/service/web-agent-starts.mjs';
import { createFakeAdapterFactory } from '../../../packages/agent-cli/test/fixtures/runtime-fake-adapter.mjs';

const nativeFixture = fileURLToPath(new URL('../../../packages/agent-cli/test/fixtures/runtime-fake-native.mjs', import.meta.url));
async function until(read, accepts) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Synthetic coordinator flow did not reach its expected state.');
}
const parse = reply => { expect(reply.isError).not.toBe(true); return JSON.parse(reply.content[0].text); };

// Real MCP transport, private project, cloud queue, local scheduler and controller.
// Only provider execution/GitHub are synthetic: no models, network repositories or installed credentials.
async function fixture() {
  await resetEmulator();
  const home = await mkdtemp(join(tmpdir(), 'mlswarm-coordinator-'));
  let at = Date.now(), githubAccess = false, chatClaims = 0, checkoutCount = 0;
  const now = () => at, ownerId = (await seed({ profiles: [{ name: 'Coordinator', email: 'coordinator@example.test' }] })).personIds[0];
  const person = { id: ownerId, ...(await profiles.doc(ownerId).get()).data() };
  const { id: projectId } = await createPrivateProject(person, { client_request_id: randomUUID(), title: 'Synthetic local project', goal: 'Test independent background work', githubUrl: 'https://github.com/example/synthetic' }, now);
  const computer = randomUUID(), principal = { site: 'https://synthetic.invalid', ownerId };
  await collection('computerConnections').doc(computer).set({ profileId: ownerId, revokedAt: null, approvedAt: at, connectionExpiresAt: at + 86400_000 });
  const events = join(home, 'events.jsonl'), gate = join(home, 'gate'), checkout = join(home, 'checkout');
  await mkdir(checkout);
  const store = await openRuntimeStore({ directory: join(home, 'ledger') });
  const controllers = createRuntimeControllers({ store, adapterFactory: createFakeAdapterFactory({ command: process.execPath, args: [nativeFixture], cwd: home, env: { PATH: process.env.PATH }, initialInput: (_mission, steering) => ({ events, gate, steering, hangAfterAck: true }) }) });
  const tokens = new Map();
  const ownerClient = {
    async addAgent(args) {
      if (!tokens.has(args.agent_name)) tokens.set(args.agent_name, hashToken(randomUUID()));
      const added = await inProject(projectId, () => connectOwnAgent(ownerId, { name: args.agent_name, candidateTokenHash: tokens.get(args.agent_name), clientName: 'Synthetic coordinator', folder: checkout }, now, computer));
      return { ...added, record: { ownerProfileId: ownerId, agentName: args.agent_name, agentId: added.agentId, service: `${principal.site}/p/${projectId}`, folder: checkout, repo: 'https://github.com/example/synthetic' } };
    },
    inspectAgentStart: (id,target) => inspectAgentStart(ownerId,computer,id,target,now),
    cancelAgentStart: (id,input) => cancelAgentStart(ownerId,computer,id,input,now),
    agentStartCancellation: (operationId,target) => readAgentStartCancellation(ownerId,computer,operationId,target,now),
    queueAgentRun: input => createWebAgentStart(ownerId, { ...input, connectionId: computer }, now),
    publishRuntimeReadiness: input => publishRuntimeReadiness(ownerId, computer, input, now),
    listAgentStarts: () => readAgentStarts(ownerId, computer, {}, now),
    listRepositoryAccess: async () => ({ owned: [], joined: [] }),
    acceptAgentStart: (id, input) => acceptAgentStart(ownerId, computer, id, input, now),
    acknowledgeAgentStart: async (id, input) => { await receiptAgentStart(ownerId, computer, id, input, now); return { ok: true }; },
  };
  let service;
  const application = createRuntimeApplication({ principal, controllers, ownerClient,
    participation: { listTools: () => [], command: async () => { chatClaims++; throw new Error('The coordinating chat must not claim participation.'); } },
  });
  service = await startRuntimeService({ principal, application, controllers });
  const pump = createWebAgentStarts({ home, principal, ownerClient, controllers, addAgent: ownerClient.addAgent, intervalMs: 600_000, now, platform: 'darwin',
    capabilities: async () => [{ id: 'codex', available: true, reason: 'ready' }], githubSignIn: async () => 'ready', syncAccess: async () => {},
    repositoryWait: async () => ({waitingFor:githubAccess?null:'github',code:githubAccess?'ready':'git_authentication_failed',checkedAt:now()}), prepareCheckout: async () => { checkoutCount++; },
  });
  const clients = [];
  async function connect() {
    const client = new Client({ name: 'synthetic-coordinator', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }));
    return client;
  }
  await pump.poll();
  return { projectId, principal, controllers, store, gate, events, pump, connect, now,
    counts: () => ({ chatClaims, checkoutCount }), setAccess: () => { githubAccess = true; at += 61_000; },
    agents: () => collection(`projects/${projectId}/agents`).get(),
    request: async id => (await readWebAgentStart(ownerId, id, now)).request,
    async close() { await Promise.allSettled(clients.map(client => client.close())); await pump.close(); await service.close(); await controllers.close(); await store.close(); await rm(home, { recursive: true, force: true }); },
  };
}

test('coordinator queues a separate agent, disconnects, and project readiness launches it exactly once without a chat work window', async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    expect((await f.agents()).size).toBe(0);
    expect((await f.store.listMissionSummaries({ ...f.principal, limit: 10 })).missions).toEqual([]);
    const input = { project_id: f.projectId, agent_name: 'background-fox', provider: 'codex', model: 'synthetic-model', task: 'Synthetic bounded work' };
    const added = parse(await client.callTool({ name: 'add_project_agent', arguments: input }));
    expect(added.run).toMatchObject({ state: 'pending', provider: 'codex', model: 'synthetic-model', task: input.task });
    expect((await f.request(added.run.id)).deadlineAt).toBeNull();
    const retry = parse(await client.callTool({ name: 'add_project_agent', arguments: input }));
    expect(retry.run.id).toBe(added.run.id);
    expect((await f.agents()).size).toBe(1);
    await f.pump.poll();
    expect(f.counts()).toEqual({ chatClaims: 0, checkoutCount: 0 });
    await client.close();

    // Project start alone cannot bypass pause or repository readiness.
    const endsAt = Date.now() + 60 * 60_000;
    await seedRuntime(f.projectId, { started: true, paused: true, endsAt }); await f.pump.poll();
    expect((await f.request(added.run.id)).state).toBe('pending');
    await seedRuntime(f.projectId, { paused: false }); await f.pump.poll();
    await until(() => f.request(added.run.id), request => request.waitingFor === 'github');
    expect(f.counts().checkoutCount).toBe(0);
    f.setAccess(); await f.pump.poll();
    const ref = { missionId: added.run.id, target: { ...f.principal, projectId: f.projectId, agentId: added.agent_id } };
    await until(() => f.controllers.getMission(ref).catch(() => null), mission => mission?.currentTurnStage === 'submitted');
    expect((await f.request(added.run.id)).state).toBe('starting');
    await writeFile(f.gate, 'go');
    await until(() => f.controllers.getMission(ref), mission => mission?.currentTurnStage === 'applied');
    await f.pump.poll();
    const working = await until(() => f.request(added.run.id), request => request.state === 'working');
    // The run's deadline is the job's end time, not a length of its own.
    expect(working.deadlineAt).toBe(endsAt);
    expect(working.acceptedAt).toBeGreaterThan(working.createdAt);

    // Reconnecting or replaying the same add doesn't restart work or extend its time.
    const reconnected = await f.connect();
    const replay = parse(await reconnected.callTool({ name: 'add_project_agent', arguments: input }));
    expect(replay.run).toMatchObject({ id: added.run.id, state: 'working' });
    await f.pump.poll();
    expect((await readFile(f.events, 'utf8')).trim().split('\n')).toHaveLength(1);
    // Cloned while the start waited, then checked again at launch (8ed5e802); a replay prepares nothing more.
    expect(f.counts()).toEqual({ chatClaims: 0, checkoutCount: 2 });
  } finally { await f.close(); }
}, 30_000);

test('closing a project with approved queued work never launches it after the coordinating chat disconnects', async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    const added = parse(await client.callTool({ name: 'add_project_agent', arguments: { project_id: f.projectId, agent_name: 'waiting-fox', provider: 'codex' } }));
    await client.close(); f.setAccess();
    await seedRuntime(f.projectId, { completedAt: f.now(), paused: true });
    await f.pump.poll();
    expect((await f.request(added.run.id)).state).not.toBe('working');
    expect((await f.store.listMissionSummaries({ ...f.principal, limit: 10 })).missions).toEqual([]);
    expect(f.counts()).toEqual({ chatClaims: 0, checkoutCount: 0 });
  } finally { await f.close(); }
}, 30_000);

test('Alon regression: failed repository access is diagnosable over MCP and Stop prevents later launch after reconnect',async()=>{
  const f=await fixture();
  try{
    const client=await f.connect();
    const addInput={project_id:f.projectId,agent_name:'alon-regression',provider:'codex'};
    const added=parse(await client.callTool({name:'add_project_agent',arguments:addInput}));
    await seedRuntime(f.projectId,{started:true,paused:false,endsAt:Date.now()+60*60_000});await f.pump.poll();
    await until(()=>f.request(added.run.id),r=>r.repository?.code==='git_authentication_failed');
    const query={missionId:added.run.id,target:{projectId:f.projectId,agentId:added.agent_id}};
    const diagnostics=parse(await client.callTool({name:'get_agent_run_diagnostics',arguments:query}));
    expect(diagnostics).toMatchObject({kind:'queued_start',modelStarted:false,request:{state:'pending',waitingFor:'github',repository:{code:'git_authentication_failed'}}});
    const command={...query,operationId:randomUUID(),kind:'stop',payload:{}};
    expect(parse(await client.callTool({name:'control_agent',arguments:command}))).toMatchObject({cancelled:true,request:{code:'cancelled'}});
    await client.close();
    const reconnected=await f.connect();
    expect(parse(await reconnected.callTool({name:'get_agent_control_result',arguments:{operationId:command.operationId,target:query.target}}))).toMatchObject({cancelled:true});
    expect(parse(await reconnected.callTool({name:'control_agent',arguments:command}))).toMatchObject({cancelled:true,replayed:true});
    const replay=parse(await reconnected.callTool({name:'add_project_agent',arguments:addInput}));
    expect(replay.run).toMatchObject({id:added.run.id,state:'failed',code:'cancelled'});
    f.setAccess();await f.pump.poll();
    expect((await f.request(added.run.id)).state).toBe('failed');
    expect(f.counts()).toEqual({chatClaims:0,checkoutCount:0});
    expect((await f.store.listMissionSummaries({...f.principal,limit:10})).missions).toEqual([]);
    expect((await f.agents()).size).toBe(1);
  }finally{await f.close();}
},30_000);
