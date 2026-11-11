// H2 merged heartbeat prototype (c4-runtime-control.md): OFF unless MLSWARM_V2_HEARTBEAT=1. Disposable emulator.
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Transaction } from 'firebase-admin/firestore';
import { inProject } from '../src/firestore.js';
import { v2Routes } from '../src/v2/routes.js';
import { startRun } from '../src/v2/runs.js';
import { presence } from '../src/v2/records.js';
import { workerPointer, workerSessions } from '../src/projects/worker-sessions.js';
import { resetEmulator, scoped, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
import { TransactionPrototype } from './store-prototypes.js';

let server: Server, base: string, clock = Date.now();
const now = () => clock;
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(scoped(v2Routes(now)));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { await resetEmulator(); process.env.MLSWARM_V2_HEARTBEAT = '1'; clock += 120_000; });
afterEach(() => { delete process.env.MLSWARM_V2_HEARTBEAT; });

const post = async (token: string, path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};
async function agents(count: number) {
  const f = await seed({ profiles: [{ name: 'Heartbeat person', email: 'heartbeat@example.test' }],
    agents: Array.from({ length: count }, (_, i) => ({ person: 0, name: `Heartbeat worker ${i}` })) });
  return Promise.all(f.agents.map(async a => {
    const run = await scope(() => startRun(a.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
    const session = { missionId: randomUUID(), generation: 1, startedAt: clock, deadlineAt: clock + 3_600_000, remainingSlots: 0, phase: 'waiting' };
    return { id: a.agentId, token: a.token, runId: run.run_id, session };
  }));
}
const stored = async (id: string) => {
  const contact = (await scope(() => presence().doc(id).get())).data();
  const missionId = (await scope(() => workerPointer(id).get())).data()?.missionId;
  const session = missionId ? (await scope(() => workerSessions(id).doc(missionId).get())).data() : undefined;
  return { contactAt: contact?.lastContactAt, phase: session?.phase, pause: session?.projectPauseRevision, lastContactAt: session?.lastContactAt };
};

test('the route is off by default: 404, and the old pair is unchanged', async () => {
  const [a] = await agents(1);
  delete process.env.MLSWARM_V2_HEARTBEAT;
  expect((await post(a.token, '/heartbeat', { run_id: a.runId, observe: {} })).status).toBe(404);
  expect((await post(a.token, '/wait', { run_id: a.runId })).status).toBe(200);
  expect((await post(a.token, '/worker-session', { ...a.session, run_id: a.runId })).status).toBe(200);
});

test('one heartbeat stores and answers what /wait plus /worker-session do', async () => {
  const [pair, beat] = await agents(2);
  const waited = await post(pair.token, '/wait', { run_id: pair.runId });
  const synced = await post(pair.token, '/worker-session', { ...pair.session, run_id: pair.runId });
  const merged = await post(beat.token, '/heartbeat', { run_id: beat.runId, observe: {}, session: beat.session });
  expect([waited.status, synced.status, merged.status]).toEqual([200, 200, 200]);
  const { session: mergedSession, ...mergedContact } = merged.json;
  expect(Object.keys(mergedContact).sort()).toEqual(Object.keys(waited.json).sort());
  expect(mergedContact).toEqual({ ...waited.json, work: mergedContact.work });
  expect(mergedContact.work).toEqual(expect.objectContaining({ revision: expect.any(Number) }));
  expect({ ...mergedSession, missionId: 'm' }).toEqual({ ...synced.json, missionId: 'm' });
  expect(await stored(beat.id)).toEqual(await stored(pair.id));
});

test('a session-only beat right after a contact beat confirms Pause without a 429', async () => {
  const [a] = await agents(1);
  expect((await post(a.token, '/heartbeat', { run_id: a.runId, observe: {}, session: a.session })).status).toBe(200);
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 1, pauseRequest: { revision: 1, requestedAt: clock } });
  // Within the /wait spacing window: a second contact beat is spaced, a session-only beat is not.
  expect((await post(a.token, '/heartbeat', { run_id: a.runId, observe: {} })).status).toBe(429);
  const confirm = await post(a.token, '/heartbeat', { run_id: a.runId, session: { ...a.session, phase: 'paused', projectPauseRevision: 1 } });
  expect(confirm.status).toBe(200);
  expect(confirm.json.work).toBeUndefined();
  expect(await stored(a.id)).toMatchObject({ phase: 'paused', pause: 1 });
});

test('a refused session part still records contact; a superseded run refuses the whole beat', async () => {
  const [a] = await agents(1);
  expect((await post(a.token, '/heartbeat', { run_id: a.runId, observe: {}, session: a.session })).status).toBe(200);
  clock += 120_000;
  // Same mission with a changed generation is refused as /worker-session refuses it, after the contact.
  const bad = await post(a.token, '/heartbeat', { run_id: a.runId, observe: {}, session: { ...a.session, generation: 2 } });
  expect(bad.status).toBe(200);
  expect(bad.json.session_error).toMatchObject({ code: 'bad_input' });
  expect(bad.json.pending).toEqual(expect.any(Number));
  expect((await stored(a.id)).contactAt).toBe(clock);
  // A takeover supersedes the run: the beat is refused as /wait refuses it.
  await scope(() => startRun(a.id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: true }, now));
  clock += 120_000;
  expect((await post(a.token, '/heartbeat', { run_id: a.runId, observe: {}, session: a.session })).status).toBe(409);
  expect((await post(a.token, '/heartbeat', { run_id: a.runId, session: a.session })).status).toBe(409);
});

test('the common beat (contact without a report, plus a session) fences the run once', async () => {
  const [pair, beat] = await agents(2);
  const runReads: string[] = [];
  const get = TransactionPrototype.get;
  const spy = vi.spyOn(TransactionPrototype, 'get').mockImplementation(function (this: Transaction, ref: any) {
    if (typeof ref?.path === 'string' && /\/runs\/[^/]+$/.test(ref.path)) runReads.push(ref.path);
    return (get as any).call(this, ref);
  });
  try {
    expect((await post(pair.token, '/wait', { run_id: pair.runId })).status).toBe(200);
    expect((await post(pair.token, '/worker-session', { ...pair.session, run_id: pair.runId })).status).toBe(200);
    const pairReads = runReads.filter(path => path.endsWith(pair.id)).length;
    expect((await post(beat.token, '/heartbeat', { run_id: beat.runId, observe: {}, session: beat.session })).status).toBe(200);
    const beatReads = runReads.filter(path => path.endsWith(beat.id)).length;
    // Both also re-read the run in the periodic contact write (recordContact). The beat drops one fence.
    expect(pairReads).toBeGreaterThanOrEqual(2);
    expect(beatReads).toBe(pairReads - 1);
  } finally { spy.mockRestore(); }
});
