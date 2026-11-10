import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { v2Routes } from '../src/v2/routes.js';
import { startRun, reportPhase, assertCurrentRun } from '../src/v2/runs.js';
import { heldProjectControl, waitForProjectControl } from '../src/projects/project-control.js';
import { resetEmulator, scoped, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
import { membershipDoc } from '../src/projects/access.js';

let server: Server, base: string;
const at = () => Date.now();
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(scoped(v2Routes(at)));
  server = app.listen(0,'127.0.0.1'); await new Promise<void>(resolve => server.once('listening',resolve));
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);
async function fixture() {
  const f = await seed({profiles:[{name:'Test person',email:'project-control@example.test'}],agents:[{person:0,name:'Test worker'}]});
  const run = await scope(() => startRun(f.agents[0].agentId,{clientRunId:randomUUID(),runnerVersion:'synthetic-no-model',takeover:false},at));
  return {...f,run};
}

test('held project control wakes on committed Pause, reports its exact revision, and cancels on disconnect',async () => {
  await fixture();
  const abort = new AbortController();
  const initial = await scope(() => waitForProjectControl(undefined,abort.signal));
  let resolved = false;
  const held = scope(() => waitForProjectControl(initial.revision,abort.signal)).then(value => {resolved=true;return value;});
  await new Promise(resolve => setTimeout(resolve,40)); expect(resolved).toBe(false);
  const requestedAt = at();
  await seedRuntime(TEST_PROJECT,{paused:true,revision:1,pauseRequest:{revision:1,requestedAt}});
  expect(await held).toMatchObject({paused:true,revision:1,pauseRequest:{revision:1,requestedAt}});
  const cancelled = scope(() => waitForProjectControl(1,abort.signal));
  const rejection = expect(cancelled).rejects.toMatchObject({code:'bad_input'});
  abort.abort(); await rejection;
});

test('project control requires the current authorized run and phase turn refuses paused work',async () => {
  const f = await fixture();
  const request = (run_id: string, token = f.agents[0].token) => fetch(`${base}/project-control`,{method:'POST',
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({run_id})});
  expect((await request(f.run.run_id,'invalid-token')).status).toBe(401);
  expect((await request(randomUUID())).status).toBe(409);
  const result = await request(f.run.run_id);
  expect(result.status).toBe(200); expect(await result.json()).toMatchObject({project:{paused:false}});
  await seedRuntime(TEST_PROJECT,{paused:true,revision:1,pauseRequest:{revision:1,requestedAt:at()}});
  await expect(scope(() => reportPhase(f.agents[0].agentId,f.run.run_id,{phase:'turn'},at))).rejects.toMatchObject({code:'paused'});
  // Confirmations and history remain writable; pausing does not end participation.
  await expect(scope(() => reportPhase(f.agents[0].agentId,f.run.run_id,{phase:'paused'},at))).resolves.toBeDefined();
});

test('a quiet hold skips the second run check; new state still needs a current run and membership',async () => {
  for (const revoke of ['superseded', 'removed'] as const) {
    await resetEmulator();
    const f = await fixture(), agentId = f.agents[0].agentId, signal = new AbortController().signal;
    const held = (after: number | undefined, timeoutMs = 300) =>
      scope(() => heldProjectControl(after, signal, () => assertCurrentRun(agentId, f.run.run_id, at), timeoutMs));
    const revision = (await held(undefined)).revision;
    const doRevoke = () => revoke === 'superseded'
      ? scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: true }, at))
      : membershipDoc(TEST_PROJECT, f.personIds[0]).delete();
    // Revoked during a quiet hold: the unchanged answer is the caller's own revision, so it is not re-checked.
    const quiet = held(revision);
    await new Promise(resolve => setTimeout(resolve, 50)); await doRevoke();
    expect(await quiet).toMatchObject({ revision });
    // Any new revision, lower or higher, is delivered only after a fresh check; the next open refuses at once.
    await expect(held(revision + 5)).rejects.toBeDefined();
    await seedRuntime(TEST_PROJECT, { paused: true, revision: revision + 1, pauseRequest: { revision: revision + 1, requestedAt: at() } });
    await expect(held(revision)).rejects.toBeDefined();
  }
}, 60_000); // Two bounded reset rounds (2 × 20 s), plus fixture and hold checks.
