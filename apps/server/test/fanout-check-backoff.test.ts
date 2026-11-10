import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db, inProject } from '../src/firestore.js';
import { checkLapsedFanouts, createFanout, deliverProjectWide, fanoutCheckStats } from '../src/v2/fanout.js';
import { fanouts } from '../src/v2/records.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

// Every API process checks each project with agent traffic for lapsed fanouts, and each check bills
// at least one read. An idle project backs off to one check a minute; found or locally unfinished work
// keeps the five-second cadence (finding #10, TEAM-PLAN F1). The check state is process-wide, so the
// whole sequence runs in one test.
let at: number;
beforeEach(async () => {
  await resetEmulator(); at = 2_100_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => at);
});
afterEach(() => { vi.restoreAllMocks(); });

const inTest = <T>(work: () => T) => inProject(TEST_PROJECT, work);
const settle = async () => {
  for (let i = 0; i < 100 && fanoutCheckStats().inFlight > 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(fanoutCheckStats().inFlight).toBe(0);
};
// Another instance or the worker created this source: no local delivery attempt.
const pendingElsewhere = (body: string, lease?: { owner: string; until: number }) => inTest(() => db.runTransaction(async tx => {
  const id = createFanout(tx, 'announcement', { body }, at);
  if (lease) tx.update(fanouts().doc(id), { leaseOwner: lease.owner, leaseUntil: lease.until });
  return id;
}));
const status = (id: string) => inTest(async () => (await fanouts().doc(id).get()).data()?.status);
// Returns whether this request started a check.
async function touch(): Promise<boolean> {
  const before = fanoutCheckStats().checks;
  inTest(() => checkLapsedFanouts(() => at));
  await settle();
  return fanoutCheckStats().checks > before;
}

test('idle checks back off to one a minute; found or locally unfinished work restores five seconds', async () => {
  await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }], agents: [{ person: 0, name: 'Runner' }] });
  const empty = fanoutCheckStats().emptyChecks;
  expect(await touch()).toBe(true);
  expect(fanoutCheckStats().emptyChecks).toBe(empty + 1);

  // One empty check: the next is due after 10 s, so a source lapsed elsewhere waits for it.
  const first = await pendingElsewhere('First');
  at += 6_000;
  expect(await touch()).toBe(false);
  expect(await status(first)).toBe('pending');
  at += 4_000;
  expect(await touch()).toBe(true);
  expect(await status(first)).toBe('done');

  // A check that found work restores the base cadence.
  const second = await pendingElsewhere('Second');
  at += 5_000;
  expect(await touch()).toBe(true);
  expect(await status(second)).toBe('done');

  // Empty checks double the interval up to 60 s: 5, 10, 20, 40, 60, 60.
  for (const interval of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    at += interval - 1_000;
    expect(await touch()).toBe(false);
    at += 1_000;
    expect(await touch()).toBe(true);
  }

  // A local slice that finishes leaves the backed-off interval alone.
  const local = await pendingElsewhere('Local');
  await inTest(() => deliverProjectWide(local, () => at));
  expect(await status(local)).toBe('done');
  at += 5_000;
  expect(await touch()).toBe(false);

  // A local slice that cannot finish (here another process holds the lease) restores five seconds.
  at += 55_000;
  expect(await touch()).toBe(true);
  const held = await pendingElsewhere('Held', { owner: 'elsewhere', until: at + 1_000 });
  await inTest(() => deliverProjectWide(held, () => at));
  expect(await status(held)).toBe('pending');
  at += 5_000;
  expect(await touch()).toBe(true);
  expect(await status(held)).toBe('done');
});
