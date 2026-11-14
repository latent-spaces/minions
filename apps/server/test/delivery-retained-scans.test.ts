import { beforeEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { agents, db, inProject } from '../src/firestore.js';
import { createFanout, runFanout } from '../src/v2/fanout.js';
import { fanouts, inboxItems } from '../src/v2/records.js';
import { FANOUT_OUTSTANDING_MAX, FANOUT_SHARDS, dispatchFanoutJob, fanoutBacklog, fanoutJobId, fanoutShardRange, reserveFanoutRound } from '../src/v2/fanout-jobs.js';
import { singleFlight } from '../src/v2/fanout-worker.js';
import { reconcileScheduledStarts } from '../src/projects/scheduled-start.js';
import { fixtureProjectRecords } from '../scripts/project-fixture.js';
import { DEFAULT_WORKSPACE_ID } from '../src/workspaces/schema.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const T = 1_000_000;

async function writeAll(entries: [string, object][]) {
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const [path, body] of entries.slice(i, i + 400)) batch.set(db.doc(path), body);
    await batch.commit();
  }
}

// A dispatched job that delivered everything, as the worker would leave it; frees its D4 reservation slot.
const complete = (dispatches: { jobId: string }[]) => Promise.all(dispatches.map(d => db.doc(`fanoutJobs/${d.jobId}`).update({ status: 'done' })));

test('project-wide delivery pages only live agents, so retained revoked records cost no extra invocations', () => inProject(TEST_PROJECT, async () => {
  const data = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }],
    agents: [{ person: 0, name: 'Live One' }, { person: 0, name: 'Live Two' }] });
  const owner = data.personIds[0];
  const agent = (createdAt: number, revokedAt: number | null) => ({ ownerProfileId: owner, connectionEpoch: 0, name: 'Synthetic',
    tokenHash: 'unused', tokenIssuedAt: 1, createdAt, revokedAt });
  // 450 revoked ids sort before every live id: before this change they filled five pages.
  const base = agents().path;
  await writeAll([
    ...Array.from({ length: 450 }, (_, i) => [`${base}/0-revoked-${String(i).padStart(4, '0')}`, agent(1, 2)] as [string, object]),
    [`${base}/1-live`, agent(1, null)],
    [`${base}/2-joined-later`, agent(T + 1, null)],
  ]);
  const sourceId = await db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Hello' }, T));
  expect(await runFanout(sourceId, () => T)).toBe('done');
  const source = (await fanouts().doc(sourceId).get()).data()!;
  expect(source).toMatchObject({ status: 'done', delivered: 3 });
  for (const id of [...data.agents.map(a => a.agentId), '1-live']) expect((await inboxItems(id).get()).size).toBe(1);
  expect((await inboxItems('2-joined-later').get()).empty).toBe(true);
  expect((await inboxItems('0-revoked-0000').get()).empty).toBe(true);
}));

test('scheduled starts are not delayed by retained started projects whose deadline already passed', async () => {
  const due = Date.parse('2026-10-18T12:00:00Z');
  const ownerId = 'scheduled-owner';
  const id = createHash('sha256').update('fresh-schedule').digest('hex');
  const entries = fixtureProjectRecords(id, { ownerProfileId: ownerId,
    definition: { title: 'Fresh', goal: 'Scheduled collaboration', rules: 'Isolated', mergeApproval: 'humans' },
    runtime: { revision: 1, configuredAt: due - 1000, configuredBy: ownerId, setupFinalizedAt: due - 1000,
      repoUrl: 'https://github.com/example/schedule', startsAt: 0, started: false, paused: true, awaitingKickoff: true,
      minContributors: 20, startDeadline: new Date(due).toISOString() } });
  const main = entries[0].body as any;
  main.publication = { listed: true, revision: 1 };
  entries.push({ path: `projectListings/${id}`, body: { workspaceId: main.workspaceId, title: 'Fresh', summary: 'Scheduled collaboration', category: 'community', tags: [], ownerName: 'Owner', revision: 1, publishedAt: due - 1000, updatedAt: due - 1000, prefixes: [] } });
  // 150 projects that started, or closed without starting, keep earlier deadlines and sort first.
  const retained = Array.from({ length: 150 }, (_, i) => [`projects/${String(i).padStart(64, '0')}`, {
    workspaceId: DEFAULT_WORKSPACE_ID, execution: i % 2 ? { started: true, completedAt: null } : { started: false, completedAt: due - 1 },
    setup: { startDeadline: new Date(due - 86_400_000 + i).toISOString() } }] as [string, object]);
  await writeAll([...retained, ...entries.map(entry => [entry.path, entry.body] as [string, object])]);
  expect(await reconcileScheduledStarts(() => due)).toMatchObject({ scanned: 1, started: 1, failed: 0 });
  expect((await db.doc(`projects/${id}`).get()).data()!.execution.started).toBe(true);
});

test('backlog reports a project waiting behind the round-robin cursor that a round cannot see', async () => {
  const at = 10_000_000;
  // Twenty projects with due work; the four that sort last have waited longest.
  const entries: [string, object][] = [];
  for (let i = 0; i < 20; i++) {
    const projectId = String(i).padStart(2, '0').padStart(64, 'a');
    const readyAt = at - (i >= 16 ? 600_000 : 10_000);
    entries.push([`fanoutProjects/${projectId}`, { projectId }]);
    entries.push([`fanoutJobs/${fanoutJobId(projectId, `source${i}`)}`, { projectId, sourceId: `source${i}`, createdAt: readyAt,
      updatedAt: readyAt, status: 'pending', readyAt, generation: 0, delivered: 0, failure: null }]);
  }
  await writeAll(entries);
  const round = await reserveFanoutRound(() => at);
  expect(round.dispatches).toHaveLength(16);
  expect(round.oldestDueSeconds).toBe(10);
  expect(await fanoutBacklog(() => at)).toEqual({ globalOldestDueSeconds: 600, backlogProjects: 20 });
});

test('round-robin reaches every project within ceil(P/16) rounds despite a noisy neighbour', async () => {
  const at = 20_000_000;
  const entries: [string, object][] = [];
  const job = (projectId: string, sourceId: string, readyAt: number): [string, object] => [`fanoutJobs/${fanoutJobId(projectId, sourceId)}`,
    { projectId, sourceId, createdAt: readyAt, updatedAt: readyAt, status: 'pending', readyAt, generation: 0, delivered: 0, failure: null }];
  const projectIds = Array.from({ length: 40 }, (_, i) => String(i).padStart(2, '0').padStart(64, 'b'));
  for (const projectId of projectIds) entries.push([`fanoutProjects/${projectId}`, { projectId }]);
  // The first project holds 100 older due jobs; each other project holds one.
  for (let n = 0; n < 100; n++) entries.push(job(projectIds[0], `noisy${n}`, at - 60_000 - n));
  for (const projectId of projectIds.slice(1)) entries.push(job(projectId, 'only', at - 1000));
  await writeAll(entries);
  const reached = new Map<string, number>();
  for (let round = 1; round <= 3; round++) {
    const { dispatches } = await reserveFanoutRound(() => at + round);
    const projects = await Promise.all(dispatches.map(async d => (await db.doc(`fanoutJobs/${d.jobId}`).get()).data()!.projectId as string));
    expect(new Set(projects).size).toBe(projects.length);
    for (const projectId of projects) if (!reached.has(projectId)) reached.set(projectId, round);
  }
  expect(reached.size).toBe(40);
  expect(Math.max(...reached.values())).toBe(Math.ceil(40 / 16));
});

test('gate 4 at size: one hot project and 999 small projects all progress within ceil(1000/16) rounds', async () => {
  const at = 50_000_000;
  const entries: [string, object][] = [];
  const job = (projectId: string, sourceId: string, readyAt: number): [string, object] => [`fanoutJobs/${fanoutJobId(projectId, sourceId)}`,
    { projectId, sourceId, createdAt: readyAt, updatedAt: readyAt, status: 'pending', readyAt, generation: 0, delivered: 0, failure: null }];
  const projectIds = Array.from({ length: 1000 }, (_, i) => String(i).padStart(4, '0').padStart(64, 'a'));
  const hot = projectIds[0];
  for (const projectId of projectIds) entries.push([`fanoutProjects/${projectId}`, { projectId }]);
  // The hot project queued 500 broadcasts before anyone else; each small project queued one.
  for (let n = 0; n < 500; n++) entries.push(job(hot, `hot${n}`, at - 600_000 - n));
  for (const projectId of projectIds.slice(1)) entries.push(job(projectId, 'only', at - 1000));
  await writeAll(entries);
  expect(await fanoutBacklog(() => at)).toEqual({ globalOldestDueSeconds: 600, backlogProjects: 1000 });
  const reached = new Map<string, number>();
  let hotDispatches = 0;
  const roundMs: number[] = [];
  const bound = Math.ceil(1000 / 16);
  for (let round = 1; round <= bound; round++) {
    const started = performance.now();
    const { dispatches } = await reserveFanoutRound(() => at + round);
    roundMs.push(performance.now() - started);
    await complete(dispatches);
    const projects = await Promise.all(dispatches.map(async d => (await db.doc(`fanoutJobs/${d.jobId}`).get()).data()!.projectId as string));
    // At most one job per project per round, so the hot project never takes more than one slot.
    expect(new Set(projects).size).toBe(projects.length);
    hotDispatches += projects.filter(id => id === hot).length;
    for (const projectId of projects) if (!reached.has(projectId)) reached.set(projectId, round);
  }
  roundMs.sort((a, b) => a - b);
  // Local emulator timing only, recorded as evidence of shape rather than a cloud bound.
  console.info(JSON.stringify({ event: 'gate4_rounds', projects: 1000, rounds: bound, reached: reached.size, hotDispatches,
    lastFirstReach: Math.max(...reached.values()), roundMsP50: Math.round(roundMs[bound >> 1]), roundMsMax: Math.round(roundMs.at(-1)!) }));
  expect(reached.size).toBe(1000);
  expect(Math.max(...reached.values())).toBe(bound);
  // The cursor visits the hot project once per full pass: 63 rounds of 16 slots wrap once (round 63 holds 8 + 8).
  expect(hotDispatches).toBe(2);
  // Finished small projects keep their head until the cursor revisits them: the wrap in round 63 revisited 7, now empty.
  expect((await fanoutBacklog(() => at + bound)).backlogProjects).toBe(1000 - 7);
}, 120_000);

async function seedDue(at: number, prefix: string) {
  const entries: [string, object][] = [];
  for (let i = 0; i < 40; i++) {
    const projectId = String(i).padStart(2, '0').padStart(64, prefix);
    entries.push([`fanoutProjects/${projectId}`, { projectId }]);
    entries.push([`fanoutJobs/${fanoutJobId(projectId, 'only')}`, { projectId, sourceId: 'only', createdAt: at - 1000,
      updatedAt: at - 1000, status: 'pending', readyAt: at - 1000, generation: 0, delivered: 0, failure: null }]);
  }
  await writeAll(entries);
}

test('four concurrent chained rounds never reserve the same job twice', async () => {
  const at = 30_000_000;
  // Local emulator timing only: sequential rounds on equal data are the comparison, not a cloud bound.
  await seedDue(at, 'd');
  const began = performance.now();
  for (let i = 0; i < 4; i++) await reserveFanoutRound(() => at);
  const sequentialMs = Math.round(performance.now() - began);
  await resetEmulator();
  await seedDue(at, 'c');
  const started = performance.now();
  const rounds = await Promise.all(Array.from({ length: 4 }, () => reserveFanoutRound(() => at)));
  const ids = rounds.flatMap(round => round.dispatches.map(d => d.jobId));
  console.info(JSON.stringify({ event: 'concurrent_rounds', selected: ids.length, concurrentMs: Math.round(performance.now() - started), sequentialMs }));
  expect(new Set(ids).size).toBe(ids.length);
  // Each reserved job's stored generation matches exactly one dispatch hint.
  for (const round of rounds) for (const d of round.dispatches) expect((await db.doc(`fanoutJobs/${d.jobId}`).get()).data()!.generation).toBe(d.generation);
  expect(ids.length).toBe(40);
}, 60_000);

test('single-flight rounds: callers during a round share one trailing round that starts after it', async () => {
  const log: string[] = [];
  const gates: (() => void)[] = [];
  let n = 0;
  const round = singleFlight(() => { const id = ++n; log.push(`start${id}`);
    return new Promise<number>(resolve => gates.push(() => { log.push(`end${id}`); resolve(id); })); });
  const first = round();
  const joined = [round(), round(), round()];
  expect(n).toBe(1);
  gates[0]();
  expect(await first).toBe(1);
  await new Promise(resolve => setImmediate(resolve));
  // The trailing round started only after the first ended; a caller now joins neither (it is running).
  expect(log).toEqual(['start1', 'end1', 'start2']);
  const late = round();
  gates[1]();
  expect(await Promise.all(joined)).toEqual([2, 2, 2]);
  await new Promise(resolve => setImmediate(resolve));
  gates[2]();
  expect(await late).toBe(3);
  expect(n).toBe(3);
  // A failed round still releases the trailing round.
  const failing = singleFlight(async () => { throw new Error('boom'); });
  const a = failing(), b = failing();
  await expect(a).rejects.toThrow('boom');
  await expect(b).rejects.toThrow('boom');
});

test('coalesced chained rounds: four callers run two rounds without contention and reserve distinct jobs', async () => {
  const at = 40_000_000;
  await seedDue(at, 'e');
  let rounds = 0;
  const round = singleFlight(() => { rounds++; return reserveFanoutRound(() => at); });
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 4 }, () => round()));
  const ms = Math.round(performance.now() - started);
  const ids = [...new Set(results.flatMap(r => r.dispatches.map(d => d.jobId)))];
  console.info(JSON.stringify({ event: 'coalesced_rounds', rounds, reserved: ids.length, ms }));
  expect(rounds).toBe(2);
  expect(ids).toHaveLength(32);
});

test('a fanout that dies after its first page resumes after lease expiry with no loss or duplicate', () => inProject(TEST_PROJECT, async () => {
  const data = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }] });
  const owner = data.personIds[0];
  const base = agents().path;
  await writeAll(Array.from({ length: 250 }, (_, i) => [`${base}/live-${String(i).padStart(3, '0')}`,
    { ownerProfileId: owner, connectionEpoch: 0, name: 'Synthetic', tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null }] as [string, object]));
  const sourceId = await db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Once' }, T));
  // Calls: claim (1), first page check + write time (2, 3). The fourth, in the second page, simulates process death.
  let calls = 0;
  await expect(runFanout(sourceId, () => { if (++calls >= 4) throw new Error('process died'); return T; })).rejects.toThrow('process died');
  const stalled = (await fanouts().doc(sourceId).get()).data()!;
  expect(stalled).toMatchObject({ status: 'pending', delivered: 100 });
  expect(stalled.leaseUntil).toBeGreaterThan(T);
  // Another worker cannot take over while the lease holds, then resumes from the saved cursor once it lapses.
  expect(await runFanout(sourceId, () => T + 1)).toBe('leased');
  expect(await runFanout(sourceId, () => stalled.leaseUntil)).toBe('done');
  const ids = [data.agents[0].agentId, ...Array.from({ length: 250 }, (_, i) => `live-${String(i).padStart(3, '0')}`)];
  const counts = await Promise.all(ids.map(async id => (await inboxItems(id).get()).size));
  expect(counts.every(count => count === 1)).toBe(true);
  expect((await fanouts().doc(sourceId).get()).data()).toMatchObject({ status: 'done', delivered: 251 });
}));

// D2: hex project ids spread across shards the way production sha256 ids do.
async function seedSpread(at: number, count: number, salt: string) {
  const projectIds = Array.from({ length: count }, (_, i) => createHash('sha256').update(`${salt}${i}`).digest('hex'));
  const entries: [string, object][] = [];
  for (const projectId of projectIds) {
    entries.push([`fanoutProjects/${projectId}`, { projectId }]);
    entries.push([`fanoutJobs/${fanoutJobId(projectId, 'only')}`, { projectId, sourceId: 'only', createdAt: at - 1000,
      updatedAt: at - 1000, status: 'pending', readyAt: at - 1000, generation: 0, delivered: 0, failure: null }]);
  }
  await writeAll(entries);
  return projectIds;
}
const shardOf = (id: string, shards: number) => Math.floor(parseInt(id[0], 16) * shards / 16);

test('D2 shard ranges are contiguous, cover every id and keep the single cursor document at one shard', () => {
  expect(FANOUT_SHARDS).toBe(1);
  const one = fanoutShardRange({ shard: 0, shards: 1 });
  expect([one.control.id, one.lo, one.hi]).toEqual(['roundRobin', null, null]);
  const four = [0, 1, 2, 3].map(shard => fanoutShardRange({ shard, shards: 4 }));
  expect(four.map(r => [r.control.id, r.lo, r.hi])).toEqual([
    ['roundRobin', null, '4'], ['roundRobin-1', '4', '8'], ['roundRobin-2', '8', 'c'], ['roundRobin-3', 'c', null]]);
  for (const bad of [{ shard: 0, shards: 3 }, { shard: 4, shards: 4 }, { shard: -1, shards: 2 }, { shard: 0.5, shards: 2 }]) {
    expect(() => fanoutShardRange(bad)).toThrow('Invalid fanout shard.');
  }
});

test('D2 with four shards: rotating rounds reach every project, never reserve a job twice and stay in range', async () => {
  const at = 60_000_000;
  const projectIds = await seedSpread(at, 120, 'spread');
  // A cursor left by the single-shard dispatcher lies outside shard 0 of 4 and restarts that range.
  await db.doc('fanoutControl/roundRobin').set({ cursor: 'f'.repeat(64) });
  const perShard = [0, 1, 2, 3].map(s => projectIds.filter(id => shardOf(id, 4) === s).length);
  const bound = 4 * Math.max(...perShard.map(n => Math.ceil(n / 16)));
  const reached = new Map<string, number>();
  const jobs: string[] = [];
  for (let round = 0; round < bound; round++) {
    const shard = round % 4;
    const { dispatches } = await reserveFanoutRound(() => at + round, { shard, shards: 4 });
    await complete(dispatches);
    const projects = await Promise.all(dispatches.map(async d => (await db.doc(`fanoutJobs/${d.jobId}`).get()).data()!.projectId as string));
    for (const id of projects) expect(shardOf(id, 4)).toBe(shard);
    jobs.push(...dispatches.map(d => d.jobId));
    for (const id of projects) if (!reached.has(id)) reached.set(id, round + 1);
  }
  expect(new Set(jobs).size).toBe(jobs.length);
  expect(reached.size).toBe(120);
  expect(Math.max(...reached.values())).toBeLessThanOrEqual(bound);
});

test('D2 concurrent rounds from four instances reserve distinct jobs on one cursor and on four shards', async () => {
  // Four worker instances, each with its own single flight. Timing is logged, not asserted: the emulator
  // conflicts any in-transaction where-query with any write to that collection, so it cannot show the
  // cross-shard gain that managed Firestore may give. Only correctness is proven here.
  const at = 70_000_000;
  const check = async (rounds: Awaited<ReturnType<typeof reserveFanoutRound>>[]) => {
    const ids = rounds.flatMap(round => round.dispatches.map(d => d.jobId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of rounds.flatMap(round => round.dispatches)) expect((await db.doc(`fanoutJobs/${d.jobId}`).get()).data()!.generation).toBe(d.generation);
    return ids.length;
  };
  await seedSpread(at, 48, 'one');
  const one = performance.now();
  const shared = await Promise.all(Array.from({ length: 4 }, () => reserveFanoutRound(() => at, { shard: 0, shards: 1 })));
  const sharedMs = Math.round(performance.now() - one);
  const sharedReserved = await check(shared);
  await resetEmulator();
  await seedSpread(at, 48, 'four');
  const four = performance.now();
  const sharded = await Promise.all([0, 1, 2, 3].map(shard => reserveFanoutRound(() => at, { shard, shards: 4 })));
  const shardedMs = Math.round(performance.now() - four);
  const shardedReserved = await check(sharded);
  console.info(JSON.stringify({ event: 'd2_concurrent_rounds', instances: 4, sharedMs, shardedMs, sharedReserved, shardedReserved }));
  expect(sharedReserved).toBe(48);
  // Each shard holds its own share of the 48 spread ids, so one round per shard reserves most of them.
  expect(shardedReserved).toBeGreaterThan(24);
}, 60_000);

// R3: eligible public projects all scheduled for the same second, as at an event start.
async function seedScheduled(count: number, due: number) {
  const entries: [string, object][] = [];
  for (let i = 0; i < count; i++) {
    const id = createHash('sha256').update(`burst${i}`).digest('hex');
    const records = fixtureProjectRecords(id, { ownerProfileId: 'burst-owner',
      definition: { title: `Burst ${i}`, goal: 'Scheduled collaboration', rules: 'Isolated', mergeApproval: 'humans' },
      runtime: { revision: 1, configuredAt: due - 1000, configuredBy: 'burst-owner', setupFinalizedAt: due - 1000,
        repoUrl: 'https://github.com/example/burst', startsAt: 0, started: false, paused: true, awaitingKickoff: true,
        minContributors: 20, startDeadline: new Date(due).toISOString() } });
    const main = records[0].body as any;
    main.publication = { listed: true, revision: 1 };
    records.push({ path: `projectListings/${id}`, body: { workspaceId: main.workspaceId, title: `Burst ${i}`, summary: 'Scheduled collaboration', category: 'community', tags: [], ownerName: 'Owner', revision: 1, publishedAt: due - 1000, updatedAt: due - 1000, prefixes: [] } });
    entries.push(...records.map(entry => [entry.path, entry.body] as [string, object]));
  }
  await writeAll(entries);
}
const startedCount = async () => (await db.collection('projects').where('execution.started', '==', true).count().get()).data().count;

test('R3: 250 projects scheduled for the same second all start in one reconcile call', async () => {
  const due = Date.parse('2026-10-20T09:00:00Z');
  await seedScheduled(250, due);
  const result = await reconcileScheduledStarts(() => due);
  expect(result).toMatchObject({ scanned: 250, started: 250, failed: 0, pages: 3 });
  expect(await startedCount()).toBe(250);
  // Nothing remains: the next call reads one empty page and stops.
  expect(await reconcileScheduledStarts(() => due + 60_000)).toMatchObject({ scanned: 0, started: 0, pages: 1 });
}, 120_000);

test('R3: the time budget stops after one page and the next call resumes from the saved cursor', async () => {
  const due = Date.parse('2026-10-20T10:00:00Z');
  await seedScheduled(150, due);
  // Every read of this clock moves 30 s forward, so the 20 s budget is spent by the end of page one.
  let t = due;
  const slow = () => { const at = t; t += 30_000; return at; };
  expect(await reconcileScheduledStarts(slow)).toMatchObject({ scanned: 100, started: 100, pages: 1 });
  expect(await startedCount()).toBe(100);
  expect(await reconcileScheduledStarts(() => t)).toMatchObject({ scanned: 50, started: 50, pages: 1 });
  expect(await startedCount()).toBe(150);
}, 120_000);

test('R3: a full page of due projects that cannot start ends the call, so retained records never multiply its scan', async () => {
  const due = Date.parse('2026-10-20T11:00:00Z');
  // 250 unstarted records with past deadlines that fail eligibility (no card, listing or configuration).
  await writeAll(Array.from({ length: 250 }, (_, i) => [`projects/${String(i).padStart(64, 'e')}`, {
    workspaceId: DEFAULT_WORKSPACE_ID, execution: { started: false, completedAt: null },
    setup: { startDeadline: new Date(due - 3_600_000 + i).toISOString() } }] as [string, object]));
  const result = await reconcileScheduledStarts(() => due);
  expect(result).toMatchObject({ scanned: 100, started: 0, pages: 1 });
}, 60_000);

test('gate 6 at the dispatcher with D5: a re-reserved job still accepts its delayed older hint, which delivers once', async () => {
  const data = await inProject(TEST_PROJECT, () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }] }));
  const owner = data.personIds[0];
  const base = await inProject(TEST_PROJECT, () => agents().path);
  await writeAll(Array.from({ length: 150 }, (_, i) => [`${base}/live-${String(i).padStart(3, '0')}`,
    { ownerProfileId: owner, connectionEpoch: 0, name: 'Synthetic', tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null }] as [string, object]));
  const sourceId = await inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Once' }, T)));
  // Round one reserves the job, then its queue hint is lost (enqueue failed or the worker died).
  const [lost] = (await reserveFanoutRound(() => T)).dispatches;
  expect(lost.generation).toBe(1);
  // While the reservation holds, rounds skip the job; after it expires, a new generation is reserved.
  expect((await reserveFanoutRound(() => T + 29_999)).dispatches).toEqual([]);
  const [retry] = (await reserveFanoutRound(() => T + 30_000)).dispatches;
  expect(retry).toEqual({ jobId: lost.jobId, generation: 2 });
  // A hint newer than the job is never valid: refused while the job is still pending, with no progress.
  expect(await dispatchFanoutJob({ jobId: lost.jobId, generation: 3 }, () => T + 30_001)).toBe('stale');
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'pending', delivered: 0 });
  // A run fenced by an older generation than the job's (the selector advanced between lookup and claim) writes nothing.
  expect(await inProject(TEST_PROJECT, () => runFanout(sourceId, () => T + 30_001, 1))).toBe('stale');
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'pending', delivered: 0 });
  // D5: the delayed generation-1 hint still runs the pending job (under generation 2) and delivers once. The
  // current hint and any repeat then find finished work and are stale.
  expect(await dispatchFanoutJob(lost, () => T + 30_001)).toBe('done');
  expect(await dispatchFanoutJob(retry, () => T + 30_002)).toBe('stale');
  expect(await dispatchFanoutJob(lost, () => T + 30_003)).toBe('stale');
  const ids = [data.agents[0].agentId, ...Array.from({ length: 150 }, (_, i) => `live-${String(i).padStart(3, '0')}`)];
  const counts = await inProject(TEST_PROJECT, () => Promise.all(ids.map(async id => (await inboxItems(id).get()).size)));
  expect(counts.every(count => count === 1)).toBe(true);
  expect((await db.doc(`fanoutJobs/${lost.jobId}`).get()).data()).toMatchObject({ status: 'done', generation: 2 });
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'done', delivered: 151 });
}, 60_000);

test('D4: rounds keep at most FANOUT_OUTSTANDING_MAX jobs reserved, keep round-robin order and free slots as jobs finish', async () => {
  const at = 80_000_000;
  const projectIds = (await seedSpread(at, 300, 'cap')).sort();
  const outstanding = async (t: number) => (await db.collection('fanoutJobs').where('status', '==', 'pending').where('readyAt', '>', t).count().get()).data().count;
  // Without completions, chained rounds stop at the cap instead of reserving the whole backlog.
  const first: string[] = [];
  for (let round = 0; round < 8; round++) first.push(...(await reserveFanoutRound(() => at)).dispatches.map(d => d.jobId));
  expect(FANOUT_OUTSTANDING_MAX).toBe(60);
  expect(first).toHaveLength(60);
  expect(await outstanding(at)).toBe(60);
  expect((await reserveFanoutRound(() => at)).dispatches).toEqual([]);
  // The first 60 projects in id order were reserved; a full round left the cursor where the next starts.
  const project = async (jobId: string) => (await db.doc(`fanoutJobs/${jobId}`).get()).data()!.projectId as string;
  expect(await Promise.all(first.map(project))).toEqual(projectIds.slice(0, 60));
  // Finishing 16 jobs frees 16 slots; the next round continues with project 61.
  await complete(first.slice(0, 16).map(jobId => ({ jobId })));
  const next = (await reserveFanoutRound(() => at)).dispatches;
  expect(await Promise.all(next.map(d => project(d.jobId)))).toEqual(projectIds.slice(60, 76));
  expect(await outstanding(at)).toBe(60);
  // Reservations whose hints were lost expire with the lease and stop counting, so progress resumes.
  expect(await outstanding(at + 30_000)).toBe(0);
  expect((await reserveFanoutRound(() => at + 30_000)).dispatches).toHaveLength(16);
}, 120_000);

test('D5: an older hint that finds the current holder running returns stale (no queue retry), and delivery stays exactly once', async () => {
  const data = await inProject(TEST_PROJECT, () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }] }));
  const owner = data.personIds[0];
  const base = await inProject(TEST_PROJECT, () => agents().path);
  await writeAll(Array.from({ length: 250 }, (_, i) => [`${base}/live-${String(i).padStart(3, '0')}`,
    { ownerProfileId: owner, connectionEpoch: 0, name: 'Synthetic', tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null }] as [string, object]));
  const sourceId = await inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Held' }, T)));
  const [older] = (await reserveFanoutRound(() => T)).dispatches;
  const [current] = (await reserveFanoutRound(() => T + 30_000)).dispatches;
  expect(current).toEqual({ jobId: older.jobId, generation: 2 });
  // The current hint's worker dies after its first page: the source lease stays held for 30 s.
  let calls = 0;
  await expect(dispatchFanoutJob(current, () => { if (++calls >= 4) throw new Error('process died'); return T + 30_000; })).rejects.toThrow('process died');
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'pending', delivered: 100 });
  // The delayed older hint arrives while that lease holds: nothing to add, and no 503 that would make the queue retry.
  expect(await dispatchFanoutJob(older, () => T + 30_001)).toBe('stale');
  // The current hint's retry is abandoned too. After the lease lapses, the safety net re-reserves the job...
  const [renewed] = (await reserveFanoutRound(() => T + 60_000)).dispatches;
  expect(renewed).toEqual({ jobId: older.jobId, generation: 3 });
  // ...and the dead holder's generation-2 run, fenced by a superseded generation, cannot write a page.
  expect(await inProject(TEST_PROJECT, () => runFanout(sourceId, () => T + 60_001, 2))).toBe('stale');
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'pending', delivered: 100 });
  // Any accepted hint now finishes from the saved cursor: here the oldest one, under generation 3.
  expect(await dispatchFanoutJob(older, () => T + 60_001)).toBe('done');
  for (const hint of [current, renewed]) expect(await dispatchFanoutJob(hint, () => T + 60_002)).toBe('stale');
  const ids = [data.agents[0].agentId, ...Array.from({ length: 250 }, (_, i) => `live-${String(i).padStart(3, '0')}`)];
  const counts = await inProject(TEST_PROJECT, () => Promise.all(ids.map(async id => (await inboxItems(id).get()).size)));
  expect(counts.every(count => count === 1)).toBe(true);
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'done', delivered: 251 });
}, 60_000);

test('D5: an older and the current hint dispatched concurrently deliver exactly once', async () => {
  const data = await inProject(TEST_PROJECT, () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }] }));
  const owner = data.personIds[0];
  const base = await inProject(TEST_PROJECT, () => agents().path);
  await writeAll(Array.from({ length: 150 }, (_, i) => [`${base}/live-${String(i).padStart(3, '0')}`,
    { ownerProfileId: owner, connectionEpoch: 0, name: 'Synthetic', tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null }] as [string, object]));
  const sourceId = await inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Race' }, T)));
  const [older] = (await reserveFanoutRound(() => T)).dispatches;
  const [current] = (await reserveFanoutRound(() => T + 30_000)).dispatches;
  const outcomes = await Promise.all([dispatchFanoutJob(older, () => T + 30_001), dispatchFanoutJob(current, () => T + 30_001)]);
  // One wins the source lease and finishes; the other finds it held or finished. An older hint never asks for a retry.
  expect(outcomes).toContain('done');
  expect(['stale', 'leased']).toContain(outcomes.find(o => o !== 'done') ?? 'stale');
  if (outcomes[0] !== 'done') expect(outcomes[0]).toBe('stale');
  expect(await dispatchFanoutJob(older, () => T + 30_002)).toBe('stale');
  expect(await dispatchFanoutJob(current, () => T + 30_002)).toBe('stale');
  const ids = [data.agents[0].agentId, ...Array.from({ length: 150 }, (_, i) => `live-${String(i).padStart(3, '0')}`)];
  const counts = await inProject(TEST_PROJECT, () => Promise.all(ids.map(async id => (await inboxItems(id).get()).size)));
  expect(counts.every(count => count === 1)).toBe(true);
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'done', delivered: 151 });
}, 60_000);

test('D5: the selector re-reserving between two page commits stops the holder (lost_lease); the saved cursor finishes once', async () => {
  const data = await inProject(TEST_PROJECT, () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }] }));
  const owner = data.personIds[0];
  const base = await inProject(TEST_PROJECT, () => agents().path);
  await writeAll(Array.from({ length: 250 }, (_, i) => [`${base}/live-${String(i).padStart(3, '0')}`,
    { ownerProfileId: owner, connectionEpoch: 0, name: 'Synthetic', tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null }] as [string, object]));
  const sourceId = await inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Advance' }, T)));
  const [first] = (await reserveFanoutRound(() => T)).dispatches;
  expect(first.generation).toBe(1);
  // The holder's transactions are its claim, then one per page. Just before the second page commits, the real
  // selector runs at the job's readyAt and re-reserves it, as it would for a holder it believes slow or dead.
  const original = db.runTransaction.bind(db);
  let calls = 0;
  let renewed: { jobId: string; generation: number } | undefined;
  const spy = vi.spyOn(db, 'runTransaction').mockImplementation((async (...args: Parameters<typeof db.runTransaction>) => {
    if (++calls === 3) {
      spy.mockImplementation(original as typeof db.runTransaction);
      [renewed] = (await reserveFanoutRound(() => T + 30_000)).dispatches;
    }
    return original(...args);
  }) as typeof db.runTransaction);
  try {
    expect(await inProject(TEST_PROJECT, () => runFanout(sourceId, () => T, first.generation))).toBe('lost_lease');
  } finally { spy.mockRestore(); }
  expect(renewed).toEqual({ jobId: first.jobId, generation: 2 });
  // Only the first page landed and its cursor is saved; the superseded holder wrote nothing more.
  const saved = await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data()!);
  expect(saved).toMatchObject({ status: 'pending', delivered: 100 });
  expect(saved.cursor).not.toBe('');
  // The new hint resumes from that cursor once the stopped holder's lease lapses, and delivers each recipient once.
  expect(await dispatchFanoutJob(renewed!, () => T + 30_000)).toBe('done');
  expect(await dispatchFanoutJob(first, () => T + 30_001)).toBe('stale');
  const ids = [data.agents[0].agentId, ...Array.from({ length: 250 }, (_, i) => `live-${String(i).padStart(3, '0')}`)];
  const counts = await inProject(TEST_PROJECT, () => Promise.all(ids.map(async id => (await inboxItems(id).get()).size)));
  expect(counts.every(count => count === 1)).toBe(true);
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'done', delivered: 251 });
}, 60_000);

test('D5: a stored generation that is not a safe integer of at least 1 refuses every hint and writes nothing', async () => {
  await inProject(TEST_PROJECT, () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }, { person: 0, name: 'Other' }] }));
  const sourceId = await inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Malformed' }, T)));
  const [hint] = (await reserveFanoutRound(() => T)).dispatches;
  // An older-hint comparison (<) alone would admit these: '2' and Infinity both compare above 1.
  for (const generation of ['2', Infinity, 0, 1.5]) {
    await db.doc(`fanoutJobs/${hint.jobId}`).update({ generation });
    expect(await dispatchFanoutJob(hint, () => T + 1)).toBe('stale');
  }
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'pending', delivered: 0 });
});

test('D6: each generation counts at most one older-hint failure; the current hint is unchanged and finishes once', async () => {
  await inProject(TEST_PROJECT, () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }, { person: 0, name: 'Other' }] }));
  const sourceId = await inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Budget' }, T)));
  const [older] = (await reserveFanoutRound(() => T)).dispatches;
  const [current] = (await reserveFanoutRound(() => T + 30_000)).dispatches;
  expect(current).toEqual({ jobId: older.jobId, generation: 2 });
  // Fails the run's first clock read (before any claim); later reads, such as the failure record's, succeed.
  const failing = (at: number) => { let reads = 0; return () => { if (reads++ === 0) throw new Error('delivery failed'); return at; }; };
  const job = async () => (await db.doc(`fanoutJobs/${older.jobId}`).get()).data()!;
  // Ten queued older hints fail before any claim: one failure counts for generation 2, and none asks for a retry.
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (let i = 0; i < 10; i++) expect(await dispatchFanoutJob(older, failing(T + 30_001))).toBe('stale');
  // Each logs one JSON event with the error class (never its message); only the first was recorded.
  const events = log.mock.calls.map(call => JSON.parse(call[0] as string));
  log.mockRestore();
  expect(events).toHaveLength(10);
  expect(events[0]).toEqual({ event: 'fanout_older_hint_failed', jobId: older.jobId, generation: 1, current: 2, recorded: 'retry', errorName: 'Error' });
  expect(events.slice(1).every(e => e.recorded === 'counted')).toBe(true);
  expect(await job()).toMatchObject({ status: 'pending', generation: 2, consecutiveFailures: 1, olderFailureGeneration: 2, failure: 'delivery_error' });
  // The current hint's failure is recorded as before and asks for a retry.
  await expect(dispatchFanoutJob(current, failing(T + 30_002))).rejects.toThrow('delivery failed');
  expect(await job()).toMatchObject({ status: 'pending', consecutiveFailures: 2 });
  // The older hint then succeeds: it delivers each recipient once and the current hint finds finished work.
  expect(await dispatchFanoutJob(older, () => T + 90_000)).toBe('done');
  expect(await dispatchFanoutJob(current, () => T + 90_001)).toBe('stale');
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'done', delivered: 2 });
});

test('D6: a persistent fault blocks the job even when only older hints ever run', async () => {
  await inProject(TEST_PROJECT, () => seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }], agents: [{ person: 0, name: 'Seeded' }, { person: 0, name: 'Other' }] }));
  const sourceId = await inProject(TEST_PROJECT, () => db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Poison' }, T)));
  const failing = (at: number) => { let reads = 0; return () => { if (reads++ === 0) throw new Error('poison'); return at; }; };
  const job = async (jobId: string) => (await db.doc(`fanoutJobs/${jobId}`).get()).data()!;
  // A slow queue: every hint arrives after its reservation lapsed and the job was re-reserved, so each runs as older.
  let [hint] = (await reserveFanoutRound(() => T)).dispatches;
  let at = T;
  const outcomes: string[] = [];
  for (let round = 0; round < 12 && (await job(hint.jobId)).status === 'pending'; round++) {
    at = Math.max(at + 30_000, (await job(hint.jobId)).readyAt);
    const [next] = (await reserveFanoutRound(() => at)).dispatches;
    expect(next.generation).toBe(hint.generation + 1);
    // Two queued copies of the old hint fail; only the first counts for this generation (and a blocked job refuses the second).
    outcomes.push(await dispatchFanoutJob(hint, failing(at + 1)), await dispatchFanoutJob(hint, failing(at + 2)));
    hint = next;
  }
  expect(await job(hint.jobId)).toMatchObject({ status: 'blocked', consecutiveFailures: 8, failure: 'delivery_error' });
  expect(outcomes).toEqual([...Array(14).fill('stale'), 'blocked', 'stale']);
  expect(await inProject(TEST_PROJECT, async () => (await fanouts().doc(sourceId).get()).data())).toMatchObject({ status: 'pending', delivered: 0 });
});
