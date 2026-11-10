import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db, inProject } from '../src/firestore.js';
import { syncWorkerSession, workerPointer } from '../src/projects/worker-sessions.js';
import { communicationAgents } from '../src/view/communication-agents.js';
import { presence } from '../src/v2/records.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

let at = 3_000_000;
const now = () => at, scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
let read: string[] = [];
beforeEach(async () => {
  await resetEmulator(); at += 1_000_000; read = [];
  const getAll = db.getAll.bind(db);
  vi.spyOn(db, 'getAll').mockImplementation((...refs: Parameters<typeof db.getAll>) => {
    for (const ref of refs) if (ref && typeof ref === 'object' && 'path' in ref) read.push((ref as { path: string }).path);
    return getAll(...refs);
  });
});
afterEach(() => vi.restoreAllMocks());

async function worker() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }], agents: [{ person: 0, name: 'alice-fox' }] });
  const agent = f.agents[0].agentId, missionId = randomUUID();
  const run = await scope(() => startRun(agent, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now));
  await scope(() => reportPhase(agent, run.run_id, { phase: 'turn' }, now));
  const sync = (phase: string, projectPauseRevision?: number) => scope(() => syncWorkerSession(agent, { run_id: run.run_id, missionId,
    startedAt: at, phase, remainingSlots: 64, generation: 1, ...(projectPauseRevision ? { projectPauseRevision } : {}) }, now));
  return { agent, reader: f.personIds[0], missionId, sync };
}
const observe = async (agent: string, reader: string) => {
  read = [];
  return (await scope(() => communicationAgents({ ids: agent }, reader, at))).agents[0];
};
const sessionReads = (agent: string) => read.filter(path => path.includes(`workerSessions/${agent}/runs/`)).length;

test('the status read takes the worker state from the canonical worker group, without reading the session', async () => {
  const w = await worker();
  await w.sync('working');
  expect((await scope(() => presence().doc(w.agent).get())).data()?.worker).toMatchObject({ phase: 'working', lastContactAt: at });
  expect(await observe(w.agent, w.reader)).toMatchObject({ state: 'working', lastContactAt: at });
  expect(sessionReads(w.agent)).toBe(0);
  // Pause confirmation follows the same session fields, so it reads the same through the summary.
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 2, pauseRequest: { revision: 2, requestedAt: at } });
  expect((await observe(w.agent, w.reader)).state).toBe('pausing');
  await w.sync('paused', 2);
  expect(await observe(w.agent, w.reader)).toMatchObject({ state: 'paused', projectPause: { revision: 2, confirmedAt: at } });
  expect(sessionReads(w.agent)).toBe(0);
});

test('a pointer without a summary does not cause a session fallback', async () => {
  const w = await worker();
  await w.sync('working');
  const withSummary = await observe(w.agent, w.reader);
  await scope(() => workerPointer(w.agent).set({ missionId: w.missionId }));
  expect(await observe(w.agent, w.reader)).toEqual(withSummary);
  expect(sessionReads(w.agent)).toBe(0);
});
