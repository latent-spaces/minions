// D4 acceptance against a pinned integration archive. Only explicit tests use four
// shards; production stays at one. This measures emulator correctness, not capacity.
import { beforeEach, expect, test } from 'vitest';
import { db } from '../src/firestore.js';
import { fanoutJobId, reserveFanoutRound, type Dispatch } from '../src/v2/fanout-jobs.js';
import { resetEmulator } from './helpers.js';

beforeEach(resetEmulator);
const T = 80_000_000;
const CAP = 60; // D4 source contract at integration ef33bcde; original pre-D4 source must fail.

async function seed() {
  const batch = db.batch();
  const jobs = new Map<string, string>();
  // Twenty-four projects per contiguous id range, ninety-six pending jobs total.
  for (let shard = 0; shard < 4; shard++) for (let i = 0; i < 24; i++) {
    const projectId = (shard * 4).toString(16) + i.toString(16).padStart(63, '0');
    const sourceId = `source-${shard}-${i}`;
    const id = fanoutJobId(projectId, sourceId);
    jobs.set(id, projectId);
    batch.set(db.doc(`fanoutProjects/${projectId}`), { projectId });
    batch.set(db.doc(`fanoutJobs/${id}`), { projectId, sourceId, createdAt: T,
      updatedAt: T, status: 'pending', readyAt: T, generation: 0, delivered: 0, failure: null });
  }
  await batch.commit();
  return jobs;
}

const live = async (at: number) => (await db.collection('fanoutJobs')
  .where('status', '==', 'pending').where('readyAt', '>', at).count().get()).data().count;

for (const shards of [1, 4]) test(`D4 global cap holds for four concurrent selectors at S=${shards}, then frees capacity and recovers expired reservations`, async () => {
  const projects = await seed();
  let at = T;
  const wave = async () => {
    const rounds = await Promise.all(Array.from({ length: 4 }, (_, worker) =>
      reserveFanoutRound(() => at, { shard: worker % shards, shards })));
    const hints = rounds.flatMap(round => round.dispatches);
    expect(new Set(hints.map(hint => hint.jobId)).size).toBe(hints.length);
    for (const [worker, round] of rounds.entries()) {
      expect(round.dispatches.length).toBeLessThanOrEqual(16);
      for (const hint of round.dispatches) {
        const projectId = projects.get(hint.jobId)!;
        expect(projectId).toBeDefined();
        expect(Math.floor(parseInt(projectId[0], 16) * shards / 16)).toBe(worker % shards);
      }
    }
    return hints;
  };
  const first = await wave();
  expect(first).toHaveLength(CAP);
  expect(first.every(hint => hint.generation === 1)).toBe(true);
  expect(await live(at)).toBe(CAP);
  expect(await wave()).toEqual([]);

  // Complete all selected jobs, preserving the selector cursor and the other jobs.
  const completed = db.batch();
  for (const hint of first) completed.update(db.doc(`fanoutJobs/${hint.jobId}`), { status: 'done' });
  await completed.commit();
  expect(await live(at)).toBe(0);
  // A range with many finished heads may consume a bounded round skipping them.
  const rest: Dispatch[] = [];
  for (let round = 0; round < 8 && rest.length < projects.size - first.length; round++) rest.push(...await wave());
  expect(rest).toHaveLength(36);
  expect(new Set([...first, ...rest].map(hint => hint.jobId)).size).toBe(projects.size);
  expect(await live(at)).toBe(36);
  // Abandon every remaining enqueue. Expiry removes all live reservations and
  // replacement independent selectors eventually re-reserve every unfinished job.
  at += 30_000;
  expect(await live(at)).toBe(0);
  const recovered: Dispatch[] = [];
  for (let round = 0; round < 8 && recovered.length < rest.length; round++) recovered.push(...await wave());
  expect(recovered.map(hint => hint.jobId).sort()).toEqual(rest.map(hint => hint.jobId).sort());
  expect(recovered.every(hint => hint.generation === 2)).toBe(true);
  expect(await live(at)).toBe(36);
}, 120_000);
