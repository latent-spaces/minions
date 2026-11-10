// The 60 s contact write holds across API instances: the stored contact decides, not each process's memory.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { V2_LIMITS } from '../src/config.js';
import { inProject } from '../src/firestore.js';
import { recordContact, startRun } from '../src/v2/runs.js';
import { presence } from '../src/v2/records.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

let clock = Date.now();
const now = () => clock;
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const windowMs = V2_LIMITS.contactWriteSeconds * 1000;
beforeEach(async () => { await resetEmulator(); clock += 10 * windowMs; });

async function started() {
  const f = await seed({ profiles: [{ name: 'Contact person', email: 'contact@example.test' }], agents: [{ person: 0, name: 'Contact worker' }] });
  const id = f.agents[0].agentId;
  const run = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
  return { id, runId: run.run_id };
}
const storedAt = async (id: string) => (await scope(() => presence().doc(id).get())).data()?.lastContactAt;

test('a contact stored by any instance within the window is kept and returned; the next one after it is written', async () => {
  const { id, runId } = await started();
  const startAt = clock;  // startRun stored this contact
  expect(await scope(() => recordContact(id, runId, startAt + 20_000))).toBe(startAt);
  expect(await storedAt(id)).toBe(startAt);
  expect(await scope(() => recordContact(id, runId, startAt + windowMs - 1))).toBe(startAt);
  expect(await scope(() => recordContact(id, runId, startAt + windowMs))).toBe(startAt + windowMs);
  expect(await storedAt(id)).toBe(startAt + windowMs);
});

test('another run\'s or a future contact is not trusted, and a superseded run is refused even when contact is fresh', async () => {
  const { id, runId } = await started();
  await scope(() => presence().doc(id).set({ runId: 'other-run', lastContactAt: clock }, { merge: true }));
  expect(await scope(() => recordContact(id, runId, clock + 1_000))).toBe(clock + 1_000);
  await scope(() => presence().doc(id).set({ lastContactAt: clock + 30_000 }, { merge: true }));
  expect(await scope(() => recordContact(id, runId, clock + 2_000))).toBe(clock + 2_000);
  await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: true }, now));
  await expect(scope(() => recordContact(id, runId, clock + 3_000))).rejects.toMatchObject({ code: 'run_superseded' });
});

test('ten instances with random routing write about once per window, not on most polls', async () => {
  const { id, runId } = await started();
  // Each instance's memory, as routes.ts keeps it: when it last learned of a stored contact for this agent.
  const instances = Array.from({ length: 10 }, () => -Infinity);
  let seedState = 7, writes = 0, last = await storedAt(id);
  const random = () => (seedState = (seedState * 48271) % 2147483647) / 2147483647;
  const polls = 30;  // 10 minutes at 20 s
  for (let poll = 1; poll <= polls; poll++) {
    const at = clock + poll * 20_000, i = Math.floor(random() * instances.length);
    if (instances[i] > at - windowMs) continue;  // contactDue: this instance wrote or learned recently
    instances[i] = await scope(() => recordContact(id, runId, at));
    const stored = await storedAt(id);
    if (stored !== last) { writes++; last = stored; }
    // The stored contact is never older than the window plus one poll, so it stays inside the 90 s fresh window.
    expect(at - stored!).toBeLessThan(windowMs + 20_000);
  }
  // A per-process throttle alone writes on ≈10/13 of polls here (≈23); one write per 60 s is 10.
  expect(writes).toBeLessThanOrEqual(Math.ceil((polls * 20_000) / windowMs));
});
