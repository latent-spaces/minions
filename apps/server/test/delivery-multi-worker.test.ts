// Model-free correctness study. Workers have independent dispatcher state, but share this
// process and a disposable Firestore emulator. This is not Cloud Run/Tasks capacity proof.
import { createHash } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { agents, db, inProject, profiles } from '../src/firestore.js';
import { fixtureProjectRecords } from '../scripts/project-fixture.js';
import { createFanout, runFanout } from '../src/v2/fanout.js';
import { dispatchFanoutJob, fanoutJobId, fanoutJobs, reserveFanoutRound, type Dispatch } from '../src/v2/fanout-jobs.js';
import { singleFlight } from '../src/v2/fanout-worker.js';
import { fanouts, inboxItems } from '../src/v2/records.js';
import { resetEmulator } from './helpers.js';

beforeEach(resetEmulator);
const T = 2_000_000;
const OWNER = 'multi-worker-owner';

async function writeAll(entries: { path: string; body: object }[]) {
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = db.batch();
    for (const { path, body } of entries.slice(offset, offset + 400)) batch.set(db.doc(path), body);
    await batch.commit();
  }
}

async function fixture(count = 20, hotRecipients = 205) {
  await profiles.doc(OWNER).set({ name: 'Synthetic owner', email: 'synthetic@example.test', removedAt: null });
  const projects = [];
  for (let i = 0; i < count; i++) {
    // Deterministically cover all shard ranges; project zero spans three recipient pages.
    const id = (i % 16).toString(16) + createHash('sha256').update(`multi-worker-${i}`).digest('hex').slice(1);
    const recipients = Array.from({ length: i === 0 ? hotRecipients : 3 }, (_, n) => `recipient-${String(n).padStart(3, '0')}`);
    await writeAll(fixtureProjectRecords(id, { ownerProfileId: OWNER,
      definition: { title: 'Synthetic delivery study', goal: 'Recovery', rules: 'Isolated', mergeApproval: 'humans' },
      runtime: { revision: 1, configuredAt: 1, configuredBy: OWNER, setupFinalizedAt: 1,
        repoUrl: 'https://github.com/example/study', startsAt: 0, started: true, paused: false },
    }));
    const sources = await inProject(id, async () => {
      const base = agents().path;
      const agent = (createdAt: number, revokedAt: number | null) => ({ ownerProfileId: OWNER, connectionEpoch: 0,
        name: 'Synthetic', tokenHash: 'unused', tokenIssuedAt: 1, createdAt, revokedAt });
      await writeAll([
        ...recipients.map(name => ({ path: `${base}/${name}`, body: agent(1, null) })),
        { path: `${base}/revoked`, body: agent(1, 2) },
        { path: `${base}/joined-later`, body: agent(T + 1, null) },
      ]);
      const ids = [];
      for (let n = 0; n < 2; n++) ids.push(await db.runTransaction(async tx =>
        createFanout(tx, 'announcement', { body: `Synthetic ${i}/${n}` }, T)));
      return ids;
    });
    projects.push({ id, recipients, sources });
  }
  return projects;
}

test.each([1, 4])('four simulated workers recover queue and page failures with %i shard(s)', async shards => {
  const projects = await fixture();
  const byJob = new Map(projects.flatMap(project => project.sources.map(source =>
    [fanoutJobId(project.id, source), { project, source }] as const)));
  let at = T;
  const now = () => at;
  const trace: { worker: number; shard: number; dispatches: Dispatch[] }[] = [];
  const workers = Array.from({ length: 4 }, (_, worker) => {
    let rotation = worker % shards;
    return singleFlight(async () => {
      const shard = rotation++ % shards;
      const result = await reserveFanoutRound(now, { shard, shards });
      trace.push({ worker, shard, dispatches: result.dispatches });
      return result;
    });
  });
  const perShard = Array.from({ length: shards }, (_, shard) => projects.filter(project =>
    Math.floor(parseInt(project.id[0], 16) * shards / 16) === shard).length);
  const perWorkerBound = shards * Math.max(...perShard.map(count => Math.ceil(count / 16)));
  async function rounds() {
    const start = trace.length;
    // Bursty callers exercise each worker's own trailing round. Count actual rounds rather
    // than returned promises: callers joining a single flight receive the same hints.
    for (let cycle = 0; cycle < Math.ceil(perWorkerBound / 2); cycle++) {
      await Promise.all(workers.flatMap(round => [round(), round(), round()]));
    }
    return trace.slice(start).flatMap(round => round.dispatches);
  }

  const first = await rounds();
  expect(new Set(first.map(hint => hint.jobId)).size).toBe(first.length);
  expect(new Set(first.map(hint => byJob.get(hint.jobId)!.project.id)).size).toBe(projects.length);
  for (let worker = 0; worker < workers.length; worker++) {
    expect(trace.filter(round => round.worker === worker)).toHaveLength(perWorkerBound);
  }
  for (const round of trace) {
    const ids = round.dispatches.map(hint => byJob.get(hint.jobId)!.project.id);
    expect(new Set(ids).size).toBe(ids.length); // one project cannot consume two slots in one round
    for (const id of ids) expect(Math.floor(parseInt(id[0], 16) * shards / 16)).toBe(round.shard);
  }
  const crashed = first.find(hint => byJob.get(hint.jobId)!.project.id === projects[0].id)!;
  const lost = first.find(hint => byJob.get(hint.jobId)!.project.id === projects[1].id)!;
  expect(crashed.generation).toBe(1);
  expect(lost.generation).toBe(1);
  const crashContext = byJob.get(crashed.jobId)!;
  // Abrupt exit: bypass dispatch's exception handler so no graceful failure bookkeeping
  // helps recovery. Claim + first page commit use three clock reads; kill on the next page.
  let clockReads = 0;
  await expect(inProject(crashContext.project.id, () => runFanout(crashContext.source, () => {
    if (++clockReads === 4) throw new Error('synthetic worker death');
    return at;
  }, crashed.generation))).rejects.toThrow('synthetic worker death');
  const stalled = await inProject(crashContext.project.id, async () => (await fanouts().doc(crashContext.source).get()).data()!);
  // joined-later sorts into page one but is outside the source's audience.
  expect(stalled).toMatchObject({ status: 'pending', delivered: 99 });
  expect(stalled.leaseUntil).toBe(T + 30_000);
  expect(await dispatchFanoutJob(crashed, now)).toBe('leased');

  // The queue abandons one hint, reverses the rest, and sends concurrent duplicates.
  let duplicatePairs = 0;
  for (const hint of [...first].reverse()) {
    if (hint.jobId === lost.jobId || hint.jobId === crashed.jobId) continue;
    // Two actual duplicate races are sufficient; doing this for every source mainly
    // measures the emulator's multi-second transaction lock-upgrade retries.
    const outcomes = duplicatePairs++ < 2
      ? await Promise.all([dispatchFanoutJob(hint, now), dispatchFanoutJob(hint, now)])
      : [await dispatchFanoutJob(hint, now)];
    expect(outcomes).toContain('done');
    expect(outcomes.every(value => ['done', 'leased', 'stale'].includes(value))).toBe(true);
    expect(await dispatchFanoutJob(hint, now)).toBe('stale');
  }
  at = T + 29_999;
  expect(await rounds()).toEqual([]);
  at = T + 30_000;
  // Replacement workers have no prior local state or remembered enqueue outcome.
  const replacements = Array.from({ length: shards }, (_, shard) => singleFlight(() =>
    reserveFanoutRound(now, { shard, shards })));
  const recovered = (await Promise.all(replacements.map(round => round()))).flatMap(round => round.dispatches);
  expect(recovered.map(hint => hint.jobId).sort()).toEqual([crashed.jobId, lost.jobId].sort());
  expect(recovered.every(hint => hint.generation === 2)).toBe(true);
  // D5: delayed generation-1 hints still run their pending jobs (fenced by generation 2, the expired source lease
  // and per-recipient markers); the newer generation-2 hints then find finished work.
  for (const old of [crashed, lost]) expect(await dispatchFanoutJob(old, now)).toBe('done');
  for (const hint of [...recovered].reverse()) expect(await dispatchFanoutJob(hint, now)).toBe('stale');
  for (const hint of [...first, ...recovered]) expect(await dispatchFanoutJob(hint, now)).toBe('stale');

  for (const project of projects) await inProject(project.id, async () => {
    for (const recipient of project.recipients) {
      const items = (await inboxItems(recipient).orderBy('seq').get()).docs.map(doc => doc.data());
      expect(items.map(item => item.seq)).toEqual([1, 2]);
      expect(items.map(item => item.sourceId).sort()).toEqual([...project.sources].sort());
    }
    for (const excluded of ['revoked', 'joined-later']) expect((await inboxItems(excluded).get()).empty).toBe(true);
    for (const source of project.sources) {
      expect((await fanouts().doc(source).get()).data()).toMatchObject({ status: 'done', delivered: project.recipients.length });
      expect((await fanoutJobs.doc(fanoutJobId(project.id, source)).get()).data()).toMatchObject({ status: 'done', delivered: project.recipients.length });
    }
  });
}, 120_000);

test('D5: a queued hint delayed past re-reservation still delivers once, so queue age alone cannot starve a job', async () => {
  const [project] = await fixture(1, 1);
  let at = T;
  // Keep one source to make the recovery condition independent of other queued work.
  const unused = project.sources.pop()!;
  await fanoutJobs.doc(fanoutJobId(project.id, unused)).delete();
  await inProject(project.id, () => fanouts().doc(unused).delete());
  const [queued] = (await reserveFanoutRound(() => at)).dispatches;
  expect(queued.generation).toBe(1);
  // Before D5 this schedule renewed generations 1 to 5 with zero recipient progress: each re-reservation
  // revoked the accepted hint still waiting in the queue. Now the delayed hint runs the pending job.
  let newest = queued;
  for (let cycle = 0; cycle < 4; cycle++) {
    at += 30_001;
    const [replacement] = (await reserveFanoutRound(() => at)).dispatches;
    expect(replacement).toEqual({ jobId: queued.jobId, generation: newest.generation + 1 });
    newest = replacement;
  }
  expect(await dispatchFanoutJob(queued, () => at)).toBe('done');
  expect(await inProject(project.id, async () => (await inboxItems(project.recipients[0]).get()).size)).toBe(1);
  // Every later hint, newest included, finds finished work and delivers nothing more.
  expect(await dispatchFanoutJob(newest, () => at)).toBe('stale');
  expect(await dispatchFanoutJob(queued, () => at)).toBe('stale');
  expect(await inProject(project.id, async () => (await inboxItems(project.recipients[0]).get()).size)).toBe(1);
  expect((await fanoutJobs.doc(queued.jobId).get()).data()).toMatchObject({ status: 'done', delivered: 1, generation: 5 });
});

test('exactly 400 live discovery rows need another invocation to observe the empty final page', async () => {
  // 399 eligible + joined-later = 400 discovered rows; revoked is excluded by discovery.
  const [project] = await fixture(1, 399);
  const source = project.sources[0];
  await inProject(project.id, async () => {
    expect((await agents().where('revokedAt', '==', null).count().get()).data().count).toBe(400);
    expect(await runFanout(source, () => T)).toBe('pending');
    expect((await fanouts().doc(source).get()).data()).toMatchObject({ status: 'pending', delivered: 399 });
    expect(await runFanout(source, () => T)).toBe('done');
    expect((await fanouts().doc(source).get()).data()).toMatchObject({ status: 'done', delivered: 399 });
    expect((await inboxItems('joined-later').get()).empty).toBe(true);
  });
}, 30_000);
