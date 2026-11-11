// Former pointer-source regressions ported to the hard cutover: run fences, current worker contact, exact
// pause confirmation and stale-pointer independence. Only canonical observations contribute to status.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { workerPointer, syncWorkerSession } from '../src/projects/worker-sessions.js';
import { communicationAgents } from '../src/view/communication-agents.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
let now = 1_000_000;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeEach(async () => { await resetEmulator(); now += 1_000_000; });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Owner', email: 'worker-canonical@example.test' }], agents: [{ person: 0, name: 'Worker' }] });
  const id = f.agents[0]!.agentId, viewer = f.personIds[0]!;
  const run = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => now));
  const start = now, mission = randomUUID();
  const sync = (phase: string, revision?: number) => scope(() => syncWorkerSession(id, { run_id: run.run_id,
    missionId: mission, generation: 1, startedAt: start, deadlineAt: start + 600_000, remainingSlots: 1, phase,
    ...(revision ? { projectPauseRevision: revision } : {}) }, () => now));
  const read = () => scope(() => communicationAgents({ ids: id }, viewer, now)).then(page => page.agents[0]!);
  return { id, viewer, run, sync, read };
}
test('the canonical worker wins over a disagreeing pointer; an older-run worker cannot describe a restart', async () => {
  const w = await fixture(); await w.sync('working');
  await scope(() => workerPointer(w.id).set({ missionId: randomUUID(), summary: { runId: w.run.run_id,
    phase: 'stopped', lastContactAt: now, deadlineAt: now + 600_000 } } as never));
  expect(await w.read()).toMatchObject({ state: 'working', lastContactAt: now });
  const next = await scope(() => startRun(w.id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: true }, () => ++now));
  expect(await w.read()).toMatchObject({ state: 'idle' });
  await expect(w.sync('working')).rejects.toMatchObject({ code: 'run_superseded' });
  await scope(() => reportPhase(w.id, next.run_id, { phase: 'stopping' }, () => ++now));
  expect(await w.read()).toMatchObject({ state: 'stopped' });
});
test('worker contact alone keeps a run fresh; its confirmation expires independently of the run contact', async () => {
  const w = await fixture(); await w.sync('working');
  now += 80_000; await w.sync('working'); now += 15_000;
  expect(await w.read()).toMatchObject({ state: 'working', lastContactAt: now - 15_000 });
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 2, pauseRequest: { revision: 2, requestedAt: now } });
  expect((await w.read()).state).toBe('pausing');
  await w.sync('paused', 2);
  expect(await w.read()).toMatchObject({ state: 'paused', projectPause: { confirmedAt: now } });
  now += 90_000;
  await scope(() => reportPhase(w.id, w.run.run_id, { phase: 'paused' }, () => now));
  expect((await w.read()).state).toBe('pause_unconfirmed');
});
test('a passed worker deadline does not end the worker on a quiet read, and a new pause revision requires a new confirmation', async () => {
  const w = await fixture(); await w.sync('working');
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 2, pauseRequest: { revision: 2, requestedAt: now } });
  await w.sync('paused', 2);
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 3, pauseRequest: { revision: 3, requestedAt: now } });
  expect((await w.read()).state).toBe('pausing');
  now += 600_000; expect((await w.read()).state).toBe('pause_unconfirmed');
});
