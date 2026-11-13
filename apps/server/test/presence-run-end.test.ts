// Current-state contract C3, the run group's end and mode, rollout stage E1: a run start writes runEndedAt null and its
// runMode; every run-ending writer sets runEndedAt in the same transaction as runs/{agent}.endedAt, so the status
// document mirrors the run. Readers are unchanged.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { endProjectWork } from '../src/projects/close-work.js';
import { projects } from '../src/projects/records.js';
import { presence, runs } from '../src/v2/records.js';
import { reportPhase, startChatParticipation, startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

let at = 2_000_000_000_000;
const now = () => at;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeEach(async () => { await resetEmulator(); at += 3_600_000; });

async function agent() {
  const f = await seed({ profiles: [{ name: 'Run owner', email: 'run-owner@example.test' }], agents: [{ person: 0, name: 'Runner' }] });
  return { owner: f.personIds[0], id: f.agents[0].agentId };
}
const start = (id: string, takeover = false) =>
  scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover }, now)).then(r => r.run_id);
const chat = (id: string) => scope(() => startChatParticipation(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-chat',
  approvedAt: at, deadlineAt: at + 600_000 }, now)).then(r => r.run_id);
const status = async (id: string) => (await scope(() => presence().doc(id).get())).data();
const run = async (id: string) => (await scope(() => runs().doc(id).get())).data();
// The status document's run fields equal the run document's.
async function expectMirrors(id: string) {
  const [s, r] = await Promise.all([status(id), run(id)]);
  expect({ runId: s?.runId, runEndedAt: s?.runEndedAt, runMode: s?.runMode })
    .toEqual({ runId: r?.runId, runEndedAt: r?.endedAt, runMode: r?.mode ?? null });
}

test('a start writes runEndedAt null and its mode; a stop report ends both; a restart and a takeover reset them', async () => {
  const { id } = await agent();
  const first = await start(id);
  await expectMirrors(id);
  expect(await status(id)).toMatchObject({ runId: first, runEndedAt: null, runMode: null });
  at += 1_000;
  await scope(() => reportPhase(id, first, { phase: 'stopping', reason: 'operator' }, now));
  await expectMirrors(id);
  expect((await status(id))?.runEndedAt).toBe(at);
  // Restart after a stop (c1): the new run's start resets the end, not only when it was absent.
  at += 1_000;
  const second = await start(id);
  await expectMirrors(id);
  expect(await status(id)).toMatchObject({ runId: second, runEndedAt: null });
  // Takeover of a live run: the new run, unended, in the same transaction as the run document.
  at += 1_000;
  const third = await start(id, true);
  await expectMirrors(id);
  expect(await status(id)).toMatchObject({ runId: third, runEndedAt: null, runMode: null });
});

test('a chat participation is mode current_chat; closing the project ends it in both documents', async () => {
  const { id } = await agent();
  await chat(id);
  await expectMirrors(id);
  expect((await status(id))?.runMode).toBe('current_chat');
  at += 1_000;
  await seedRuntime(TEST_PROJECT, { completedAt: at, paused: true });
  await endProjectWork(TEST_PROJECT, now, (await projects.doc(TEST_PROJECT).get()).data()!.revision, 'closer');
  expect((await run(id))?.endedAt).toBe(at);
  await expectMirrors(id);
});

test('revocation ends the run in the same single status write that marks it stopping', async () => {
  const { owner, id } = await agent();
  await start(id);
  at += 1_000;
  await scope(() => revokeOwned(owner, id, now));
  await expectMirrors(id);
  expect(await status(id)).toMatchObject({ phase: 'stopping', phaseAt: at, runEndedAt: at, agent: { revokedAt: at } });
});
