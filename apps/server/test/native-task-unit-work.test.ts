// Counted work of today's native task model (Firestore), for the task data-model comparison
// (research/platform-scale/c5-task-data-model.md). Emulator SDK counts, not billing: a document get is one read,
// a query is max(1, rows). Bytes are the JSON size of what each request reads or writes.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db, inProject, profiles } from '../src/firestore.js';
import { listNativeTaskSummaries, mutateNativeTask, nativeTasks } from '../src/projects/native-tasks.js';
import { startRun } from '../src/v2/runs.js';
import { loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';

const now = () => 1000, scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const work = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null));
beforeEach(async () => {
  await resetEmulator();
  const tx = await db.runTransaction(async t => Object.getPrototypeOf(t));
  const get = tx.get, set = tx.set, create = tx.create;
  vi.spyOn(tx, 'get').mockImplementation(async function (this: unknown, target: unknown) {
    const result = await get.call(this, target) as { docs?: { data(): unknown }[]; data?: () => unknown };
    if (result.docs) { work.reads += Math.max(1, result.docs.length); for (const doc of result.docs) work.readBytes += size(doc.data()); }
    else { work.reads += 1; work.readBytes += size(result.data?.()); }
    return result;
  });
  for (const [name, original] of [['set', set], ['create', create]] as const)
    vi.spyOn(tx, name).mockImplementation(function (this: unknown, ref: unknown, data: unknown, ...rest: unknown[]) {
      work.writes += 1; work.writeBytes += size(data); return (original as Function).call(this, ref, data, ...rest);
    });
});
afterEach(() => vi.restoreAllMocks());
const measure = async <T>(run: () => Promise<T>) => {
  Object.assign(work, { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 });
  const result = await run();
  return { result, ...work };
};

test('task list, search and claim: documents and bytes per request in the current model', async () => scope(async () => {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test' }], agents: [{ person: 0, name: 'Otter' }] });
  const person: ProgressActor = { kind: 'person', person: { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! } };
  const agent = await loadAgent(f.agents[0].agentId), runId = randomUUID();
  await startRun(agent.id, { clientRunId: runId, runnerVersion: 'unit-work', takeover: false }, now);
  const runner: ProgressActor = { kind: 'agent', agent, runId };
  // One real task as the template, then 259 copies with ~2 KB descriptions written directly (fast fixture).
  const template = (await mutateNativeTask(person, { operation: 'create', clientRequestId: randomUUID(), title: 'Seed task' }, now)).task;
  const description = 'Acceptance details. '.repeat(100);
  for (let i = 0; i < 259; i += 1) {
    const id = `task_${String(i).padStart(64, '0')}`;
    await nativeTasks().doc(id).set({ ...template, id, title: i === 258 ? 'Rare needle task' : `Routine task ${i}`, description,
      status: i % 3 === 0 ? 'done' : 'backlog' });
  }
  const page = await measure(() => listNativeTaskSummaries(person, { limit: '50' }, now));
  const filtered = await measure(() => listNativeTaskSummaries(person, { limit: '50', status: 'backlog' }, now));
  const search1 = await measure(() => listNativeTaskSummaries(person, { search: 'needle' }, now));
  const search2 = await measure(() => listNativeTaskSummaries(person, { search: 'needle', cursor: search1.result.nextCursor! }, now));
  const target = page.result.tasks.find(task => task.status === 'backlog')!;
  const claim = await measure(() => mutateNativeTask(runner, { operation: 'claim', clientRequestId: randomUUID(), taskId: target.id, expectedRevision: target.revision }, now));
  const row = (m: typeof work) => ({ reads: m.reads, readKiB: +(m.readBytes / 1024).toFixed(1), writes: m.writes, writeKiB: +(m.writeBytes / 1024).toFixed(1) });
  const returned = +(size(page.result) / 1024).toFixed(1);
  console.info(JSON.stringify({ taskUnitWork: { summaryPage50: { ...row(page), returnedKiB: returned }, statusPage50: row(filtered),
    searchPage1: { ...row(search1), matches: search1.result.tasks.length }, searchPage2: { ...row(search2), matches: search2.result.tasks.length },
    claim: row(claim) } }));
  // Compact summaries read only their fields (T1 projection). Before it, whole task documents were read:
  // 127.8 KiB for this page and 501 KiB for a search page (c5-task-data-model.md).
  expect(page.result.tasks).toHaveLength(50);
  expect(page.readBytes).toBeLessThan(1.5 * size(page.result));
  expect(search1.readBytes).toBeLessThan(100 * 1024);
  // A sparse title search scans 200 candidates (+1 to detect more) and can return an empty page with a cursor.
  expect(search1.result.tasks).toHaveLength(0);
  expect(search1.result.nextCursor).not.toBeNull();
  expect(search1.reads).toBeGreaterThanOrEqual(201);
  expect(search2.result.tasks.map(task => task.title)).toEqual(['Rare needle task']);
  // A claim writes the task, a full-snapshot activity event and a receipt holding the task: three copies.
  expect(claim.writes).toBe(3);
  expect(claim.writeBytes).toBeGreaterThan(3 * size({ ...template, description }) * 0.9);
}), 120_000);
