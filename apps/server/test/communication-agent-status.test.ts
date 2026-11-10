import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { agents, inProject, projectCollection } from '../src/firestore.js';
import { presence, runs } from '../src/v2/records.js';
import { startRun, startChatParticipation, reportPhase } from '../src/v2/runs.js';
import { syncWorkerSession, listMyWorkers } from '../src/projects/worker-sessions.js';
import { membershipDoc } from '../src/projects/access.js';
import { viewRoutes } from '../src/view/routes.js';
import { registerAgent } from '../src/onboarding/registration.js';
import { communicationAgents, readCanonicalAgentStates, readReadyCanonicalContacts, resetStatusSourceReads, statusSourceReads } from '../src/view/communication-agents.js';
import { idTokenFor, resetEmulator, scoped, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
import { FirestorePrototype } from './store-prototypes.js';

let server: Server, base: string, at = 1_000_000;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeAll(async () => {
  const app = express(); app.use(scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { await resetEmulator(); at += 1_000_000; });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }], agents: [{ person: 0, name: 'alice-fox' }] });
  const run = await scope(() => startRun(f.agents[0].agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => at));
  await scope(() => reportPhase(f.agents[0].agentId, run.run_id, { phase: 'turn' }, () => at));
  return { ...f, run, agent: f.agents[0].agentId, reader: f.personIds[0], token: await idTokenFor('alice@example.test') };
}
const get = async (ids: string, token?: string) => {
  const response = await fetch(`${base}/communication/agents?ids=${encodeURIComponent(ids)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, data: await response.json() };
};
const observe = (agent: string, reader: string) => scope(() => communicationAgents({ ids: agent }, reader, at)).then(page => page.agents[0]);

test('member-only batch returns focus and current state, without private worker content or credentials', async () => {
  const f = await fixture(), missionId = randomUUID();
  await scope(() => agents().doc(f.agent).update({ focus: { text: 'Finishing the map controls.', updatedAt: at, runId: f.run.run_id } }));
  await scope(() => syncWorkerSession(f.agent, { run_id: f.run.run_id, missionId, startedAt: at,
    phase: 'working', remainingSlots: 64, generation: 1 }, () => at));
  await scope(() => projectCollection(`agentSteering/${f.agent}/missions`).doc(missionId).set({ messages: [{ body: 'PRIVATE STEERING', id: 'secret' }] }));
  const result = await get(f.agent, f.token);
  expect(result.status).toBe(200);
  expect(result.data.agents[0]).toMatchObject({ id: f.agent, mine: true, state: 'working', focus: { text: 'Finishing the map controls.', updatedAt: at } });
  expect(Object.keys(result.data.agents[0]).sort()).toEqual(['focus','freshUntil','id','lastContactAt','mine','name','personaChoice','reportedAt','state']);
  expect(JSON.stringify(result.data)).not.toContain('PRIVATE STEERING');
  expect(JSON.stringify(result.data)).not.toContain(f.run.run_id); expect(JSON.stringify(result.data)).not.toContain(f.agents[0].token);
  expect((await get(f.agent)).status).toBe(401);
  await membershipDoc(TEST_PROJECT, f.reader).update({ status: 'removed' });
  expect((await get(f.agent, f.token)).status).not.toBe(200);
});

test('fresh runner phases distinguish working and idle; expired and superseded observations never say working', async () => {
  const f = await fixture();
  expect((await observe(f.agent, f.reader)).state).toBe('working');
  at += 90_000;
  expect((await observe(f.agent, f.reader)).state).toBe('offline');
  await scope(() => reportPhase(f.agent, f.run.run_id, { phase: 'idle' }, () => at));
  expect((await observe(f.agent, f.reader)).state).toBe('idle');
  const next = await scope(() => startRun(f.agent, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: true }, () => at));
  await expect(scope(() => reportPhase(f.agent, f.run.run_id, { phase: 'turn' }, () => at))).rejects.toMatchObject({ code: 'run_superseded' });
  expect((await observe(f.agent, f.reader)).state).toBe('idle');
  await scope(() => reportPhase(f.agent, next.run_id, { phase: 'stopping' }, () => at));
  expect((await observe(f.agent, f.reader)).state).toBe('stopped');
});

test('project Pause stays visible until its exact runtime confirmation; stale and expired feedback cannot confirm it', async () => {
  const f = await fixture(), missionId = f.run.run_id;
  const sync = (phase: string, revision?: number) => scope(() => syncWorkerSession(f.agent, { run_id: missionId, missionId,
    startedAt: at, phase, remainingSlots: 64, generation: 1,
    ...(revision === undefined ? {} : {projectPauseRevision: revision}) }, () => at));
  await sync('working');
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 1, pauseRequest: { revision: 1, requestedAt: at } });
  expect(await observe(f.agent, f.reader)).toMatchObject({ state:'pausing', projectPause:{revision:1,confirmedAt:null,externalChat:false} });
  await sync('paused'); // Older services and individual Pause cannot manufacture project confirmation.
  expect((await observe(f.agent, f.reader)).state).toBe('pausing');
  await sync('paused', 1);
  expect(await observe(f.agent, f.reader)).toMatchObject({ state:'paused',projectPause:{revision:1,confirmedAt:at} });
  expect((await scope(()=>listMyWorkers(f.reader,()=>at))).agents[0].projectPause).toMatchObject({revision:1,confirmedAt:at});
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 3, pauseRequest: { revision: 3, requestedAt: at } });
  await sync('paused', 1);
  expect((await observe(f.agent, f.reader)).state).toBe('pausing');
  await sync('paused', 3);
  expect((await observe(f.agent, f.reader)).state).toBe('paused');
  at += 90000;
  await scope(() => reportPhase(f.agent, f.run.run_id, { phase:'paused' }, () => at));
  // Fresh presence from another writer does not renew the worker's confirmation.
  expect((await observe(f.agent, f.reader)).state).toBe('pause_unconfirmed');
});

test('external coding chat and old services stay unconfirmed, and ended runs do not pretend to be waiting for Pause', async () => {
  const f = await fixture();
  await seedRuntime(TEST_PROJECT, { paused:true,revision:1,pauseRequest:{revision:1,requestedAt:at} });
  await scope(() => reportPhase(f.agent, f.run.run_id, { phase: 'stopping' }, () => at));
  const chat = await scope(() => startChatParticipation(f.agent, { clientRunId: randomUUID(), runnerVersion: 'test',
    approvedAt: at, deadlineAt: at + 30 * 60_000 }, () => at));
  expect(await observe(f.agent, f.reader)).toMatchObject({state:'pause_unconfirmed',projectPause:{externalChat:true,confirmedAt:null}});
  at += 30001;
  expect((await observe(f.agent, f.reader)).state).toBe('pause_unconfirmed');
  await scope(() => reportPhase(f.agent, chat.run_id, { phase: 'stopping' }, () => at));
  expect(await observe(f.agent, f.reader)).toMatchObject({state:'stopped'});
  expect((await observe(f.agent, f.reader)).projectPause).toBeUndefined();
});

// Production writers, then request-time reads: these are covered-path assertions, not shape-only fixtures.
test('covered run lifecycle and explicit never-run marker do not read legacy runs; MCP sees every write immediately', async () => {
  const f = await fixture();
  const never = await scope(() => registerAgent(f.reader, 'registered-never-run', () => at));
  const { findAgents } = await import('../src/v2/agents.js');
  const original = FirestorePrototype.getAll;
  const runReads: string[] = [];
  FirestorePrototype.getAll = function (this: Firestore, ...refs: Parameters<Firestore['getAll']>) {
    for (const ref of refs) if ('path' in ref && /(^|\/)projects\/[^/]+\/runs\/[^/]+$/.test(ref.path)) runReads.push(ref.path);
    return original.apply(this, refs);
  } as Firestore['getAll'];
  try {
    resetStatusSourceReads();
    expect((await observe(f.agent, f.reader)).state).toBe('working');
    expect((await observe(never.agentId, f.reader)).state).toBe('unknown');
    const mcp = () => scope(() => findAgents({}, () => at, f.reader));
    expect((await mcp()).agents.find(a => a.agentId === f.agent)?.state).toBe('working');
    expect(statusSourceReads.incompleteRows).toBe(0);
    expect(runReads).toEqual([]);
    // Stop the real writer, read immediately, then replay the same stop. Neither read consults runs.
    await scope(() => reportPhase(f.agent, f.run.run_id, { phase: 'stopping' }, () => at));
    runReads.length = 0; resetStatusSourceReads();
    expect((await mcp()).agents.find(a => a.agentId === f.agent)?.state).toBe('stopped');
    expect(runReads).toEqual([]); expect(statusSourceReads.incompleteRows).toBe(0);
    await scope(() => reportPhase(f.agent, f.run.run_id, { phase: 'stopping' }, () => at));
    runReads.length = 0;
    expect((await observe(f.agent, f.reader)).state).toBe('stopped');
    expect(runReads).toEqual([]);
  } finally { FirestorePrototype.getAll = original; }
});

test('historical incomplete rows retain identity without reading or inventing legacy run observations', async () => {
  const f = await seed({ profiles: [{ name: 'Legacy', email: 'legacy-state@example.test' }],
    agents: [{ person: 0, name: 'missing-status' }, { person: 0, name: 'ambiguous-status' }] });
  const [missing, ambiguous] = f.agents.map(a => a.agentId);
  const { agentGroup } = await import('../src/v2/agent-group.js');
  await scope(async () => {
    await presence().doc(missing).delete();
    const agent = (await agents().doc(ambiguous).get()).data()!;
    await presence().doc(ambiguous).set({ agent: agentGroup(agent) } as never);
    await runs().doc(ambiguous).set({ runId: randomUUID(), endedAt: at - 1 } as never);
  });
  resetStatusSourceReads();
  const original = FirestorePrototype.getAll, runReads: string[] = [];
  FirestorePrototype.getAll = function (this: Firestore, ...refs: Parameters<Firestore['getAll']>) {
    for (const ref of refs) if ('path' in ref && /(^|\/)projects\/[^/]+\/runs\/[^/]+$/.test(ref.path)) runReads.push(ref.path);
    return original.apply(this, refs);
  } as Firestore['getAll'];
  let answer: Awaited<ReturnType<typeof communicationAgents>>;
  try { answer = await scope(() => communicationAgents({ ids: [missing, ambiguous].join(',') }, f.personIds[0], at)); }
  finally { FirestorePrototype.getAll = original; }
  expect(runReads).toHaveLength(0);

  expect(answer.agents).toHaveLength(2);
  expect(answer.agents.find(a => a.id === missing)?.state).toBe('unknown');
  expect(answer.agents.find(a => a.id === ambiguous)?.state).toBe('unknown');
  expect(statusSourceReads).toMatchObject({ canonicalRows: 0, incompleteRows: 2 });
});

test('malformed canonical markers retain identity with no fabricated run and no legacy source read', async () => {
  const f = await fixture();
  await scope(() => presence().doc(f.agent).update({ runEndedAt: -1 }));
  resetStatusSourceReads();
  const answer = await observe(f.agent, f.reader);
  expect(answer).toMatchObject({ id: f.agent, state: 'unknown' });
  expect(statusSourceReads).toMatchObject({ canonicalRows: 0, incompleteRows: 1 });

});

// Pre-cutover writers are unsupported: no active writer may update only legacy records. The canonical
// read deliberately does not reconstruct from them, even if a historical run/pointer is still present.
test('legacy-only mutations do not become canonical status observations', async () => {
  const f = await fixture();
  await scope(() => runs().doc(f.agent).update({ endedAt: at }));
  resetStatusSourceReads();
  expect((await observe(f.agent, f.reader)).state).toBe('working');
  expect(statusSourceReads).toMatchObject({ canonicalRows: 1, incompleteRows: 0 });
});

test('a known explicit no-run marker makes the worker pointer irrelevant, without changing the observed state', async () => {
  const f = await seed({ profiles: [{ name: 'No run', email: 'no-run-pointer@example.test' }] });
  const created = await scope(() => registerAgent(f.personIds[0], 'pointer-not-needed', () => at));
  const { workerPointer } = await import('../src/projects/worker-sessions.js');
  await scope(() => workerPointer(created.agentId).set({ missionId: randomUUID(), summary: { runId: randomUUID(),
    phase: 'working', lastContactAt: at } } as never));
  const [agent, status] = await scope(() => Promise.all([agents().doc(created.agentId).get(), readReadyCanonicalContacts([created.agentId])]));
  const baseline = await scope(() => readCanonicalAgentStates([agent], f.personIds[0], at));
  resetStatusSourceReads();
  const known = await scope(() => readCanonicalAgentStates([agent], f.personIds[0], at, status));
  expect(known).toEqual(baseline); expect(known[0].state).toBe('unknown');
  expect(statusSourceReads).toMatchObject({ canonicalRows: 1, incompleteRows: 0 });
});
