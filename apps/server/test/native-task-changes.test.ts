// T2 task change feed (c5-task-data-model.md §3 A): the cursor is a Firestore time, so it means the same on every
// instance and does not depend on any process clock (the lesson of S3's per-process cursors).
import { randomUUID } from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { beforeEach, expect, test } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { db, inProject, profiles } from '../src/firestore.js';
import { FEED_OVERLAP_MS, getNativeTask, listNativeTaskChanges, listNativeTasks, listNativeTaskSummaryChanges, mutateNativeTask, nativeTasks } from '../src/projects/native-tasks.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { idTokenFor, resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';

beforeEach(resetEmulator);
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const now = () => 1000;
async function person(): Promise<ProgressActor & { kind: 'person' }> {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'feed-admin@example.test' }] });
  return { kind: 'person', person: { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! } };
}
const create = (actor: ProgressActor, title: string, clock = now) =>
  mutateNativeTask(actor, { operation: 'create', clientRequestId: randomUUID(), title }, clock).then(r => r.task);
const retitle = (actor: ProgressActor, task: { id: string; revision: number }, title: string, clock = now) =>
  mutateNativeTask(actor, { operation: 'update', clientRequestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, title }, clock).then(r => r.task);
// Follow a cursor until the feed is caught up; keep the highest revision seen per task.
// `floors` keeps, per task@revision, the cursor floor (ms) of the poll that first delivered it.
const floorMs = (cursor: string) => { const [s, n] = cursor.split('~')[0].split('.'); return Number(s) * 1000 + Number(n) / 1e6; };
async function drain(actor: ProgressActor, cursor: string, seen = new Map<string, number>(), limit = 50, floors = new Map<string, number>()) {
  let more = true, pages = 0, fresh = 0;
  while (more) {
    const page = await listNativeTaskSummaryChanges(actor, { since: cursor, limit }, now);
    for (const task of page.tasks) {
      if ((seen.get(task.id) ?? 0) < task.revision) fresh++;
      seen.set(task.id, Math.max(seen.get(task.id) ?? 0, task.revision));
      const key = `${task.id}@${task.revision}`; if (!floors.has(key)) floors.set(key, floorMs(cursor));
    }
    cursor = page.cursor; more = page.more; pages++;
  }
  return { cursor, seen, pages, fresh };
}

test('a cursor taken before listing returns the tasks written after it, oldest first, then no new revision', async () => scope(async () => {
  const admin = await person();
  const old = await create(admin, 'Before the cursor');
  // A task last written well before the overlap is not repeated.
  await nativeTasks().doc('task_quiet').set({ ...old, id: 'task_quiet', title: 'Quiet', changedAt: Timestamp.fromMillis(Date.now() - 2 * FEED_OVERLAP_MS) } as never);
  const start = await listNativeTaskSummaryChanges(admin, {}, now);
  expect(start).toMatchObject({ tasks: [], more: false });
  const a = await create(admin, 'After A'), b = await create(admin, 'After B');
  const changed = await retitle(admin, old, 'Edited after the cursor');
  const page = await listNativeTaskSummaryChanges(admin, { since: start.cursor }, now);
  expect(page.tasks.map(t => t.id)).toEqual([a.id, b.id, old.id]);
  expect(page.tasks[2]).toEqual({ id: old.id, title: 'Edited after the cursor', status: 'backlog', assignedAgentId: null, priority: 'normal', revision: changed.revision });
  expect(page.more).toBe(false);
  // The next poll repeats the overlap (same revisions) and brings nothing new.
  const seen = new Map(page.tasks.map(t => [t.id, t.revision]));
  expect((await drain(admin, page.cursor, seen)).fresh).toBe(0);
}));

test('process clocks do not matter: a write from a process 10 minutes behind is still delivered', async () => scope(async () => {
  const admin = await person();
  const ahead = () => 10 * 60_000 + 1000, behind = () => 1000;
  await create(admin, 'Written by the fast process', ahead);
  const start = await listNativeTaskSummaryChanges(admin, {}, ahead);
  const late = await create(admin, 'Written by the slow process', behind);
  // An app-clock watermark (updatedAt > the fast process's time) would skip this write.
  expect(late.updatedAt).toBeLessThan(ahead());
  expect((await listNativeTaskSummaryChanges(admin, { since: start.cursor }, ahead)).tasks.map(t => t.id)).toContain(late.id);
}));

test('concurrent writers on skewed clocks while a reader polls: the reader ends with every final revision', async () => scope(async () => {
  const admin = await person();
  const tasks = await Promise.all(Array.from({ length: 12 }, (_, i) => create(admin, `Concurrent ${i}`)));
  const start = await listNativeTaskSummaryChanges(admin, {}, now);
  const final = new Map<string, number>();
  let writing = true, cursor = start.cursor;
  const seen = new Map<string, number>(), floors = new Map<string, number>();
  let polls = 0;
  const reader = (async () => { while (writing) { cursor = (await drain(admin, cursor, seen, 5, floors)).cursor; polls++; } })();
  // Four writers ("instances") with clocks up to ±5 min apart, each editing its own three tasks four times.
  await Promise.all([0, 1, 2, 3].map(async w => {
    const clock = () => 1000 + (w - 2) * 150_000;
    for (let round = 0; round < 4; round++) for (const i of [w, w + 4, w + 8]) {
      const current = (await nativeTasks().doc(tasks[i].id).get()).data()!;
      final.set(tasks[i].id, (await retitle(admin, current, `w${w} r${round}`, clock)).revision);
    }
  }));
  writing = false; await reader;
  await drain(admin, cursor, seen, 50, floors);
  expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(final));
  // How far behind its poll's cursor each final write was stamped: > 0 ms means a strict `> cursor` feed would skip it.
  const lags = await Promise.all(tasks.map(async t => {
    const stamp = ((await nativeTasks().doc(t.id).get()).get('changedAt') as Timestamp).toMillis();
    return floors.get(`${t.id}@${final.get(t.id)}`)! - stamp;
  }));
  console.info(JSON.stringify({ taskChangeFeedLag: { polls, writes: 48, finalWritesBehindCursor: lags.filter(l => l > 0).length, maxLagMs: +Math.max(...lags).toFixed(3) } }));
  expect(Math.max(...lags)).toBeLessThan(FEED_OVERLAP_MS);
  expect([...final.values()].every(revision => revision === 5)).toBe(true);
}));

test('a write stamped just before the cursor but visible only after it is still delivered (deterministic form of the race)', async () => scope(async () => {
  const admin = await person();
  const start = await listNativeTaskSummaryChanges(admin, {}, now);
  const caught = await listNativeTaskSummaryChanges(admin, { since: start.cursor }, now);
  // As measured above (stamps up to ~17 ms behind the delivering poll's cursor locally): stamped 20 ms before this cursor.
  const task = await create(admin, 'Stamped early');
  await nativeTasks().doc(task.id).update({ changedAt: Timestamp.fromMillis(floorMs(caught.cursor) - 20) });
  expect((await listNativeTaskSummaryChanges(admin, { since: caught.cursor }, now)).tasks.map(t => t.id)).toContain(task.id);
}));

test('the documented limit: a write visible more than the overlap after its stamp is missed, and nothing signals it', async () => scope(async () => {
  const admin = await person();
  const start = await listNativeTaskSummaryChanges(admin, {}, now);
  const caught = await listNativeTaskSummaryChanges(admin, { since: start.cursor }, now);
  const task = await create(admin, 'Stamped beyond the overlap');
  await nativeTasks().doc(task.id).update({ changedAt: Timestamp.fromMillis(floorMs(caught.cursor) - FEED_OVERLAP_MS - 1) });
  const next = await listNativeTaskSummaryChanges(admin, { since: caught.cursor }, now);
  expect(next.tasks.map(t => t.id)).not.toContain(task.id);
  expect(Object.keys(next).sort()).toEqual(['cursor', 'more', 'tasks']);
  // The task itself and the list remain authoritative.
  expect((await getNativeTask(admin, task.id, {}, now)).task.revision).toBe(1);
  expect((await listNativeTasks(admin, {}, now)).tasks.map(t => t.id)).toContain(task.id);
}));

test('cursor times outside Firestore\'s Timestamp range are refused as bad input', async () => scope(async () => {
  const admin = await person();
  for (const since of ['999999999999.000000000', '1.000000000~999999999999.000000000~task_x'])
    await expect(listNativeTaskSummaryChanges(admin, { since }, now)).rejects.toMatchObject({ code: 'bad_input' });
  expect((await listNativeTaskSummaryChanges(admin, { since: '253402300799.999999999' }, now)).tasks).toEqual([]);
}));

test('pages continue after their last row; a task changed while paging appears again later', async () => scope(async () => {
  const admin = await person();
  const start = await listNativeTaskSummaryChanges(admin, {}, now);
  const tasks = [];
  for (let i = 0; i < 12; i++) tasks.push(await create(admin, `Paged ${i}`));
  const one = await listNativeTaskSummaryChanges(admin, { since: start.cursor, limit: 5 }, now);
  expect(one.tasks.map(t => t.id)).toEqual(tasks.slice(0, 5).map(t => t.id));
  expect(one.more).toBe(true);
  expect(one.cursor).toMatch(/~task_/);
  // The first task changes between pages: it moves to the end rather than being lost.
  await retitle(admin, tasks[0], 'Changed while paging');
  const rest = await drain(admin, one.cursor, new Map(), 5);
  expect([...rest.seen.keys()]).toEqual([...tasks.slice(5).map(t => t.id), tasks[0].id]);
  expect(rest.seen.get(tasks[0].id)).toBe(2);
  expect(rest.pages).toBe(2);
}));

test('the commit time stays internal: lists, details, mutation results, replays and history never show it', async () => scope(async () => {
  const admin = await person();
  const input = { operation: 'create', clientRequestId: randomUUID(), title: 'Internal field' };
  const made = await mutateNativeTask(admin, input, now);
  const edited = await mutateNativeTask(admin, { operation: 'update', clientRequestId: randomUUID(), taskId: made.task.id, expectedRevision: 1, title: 'Edited' }, now);
  expect((await nativeTasks().doc(made.task.id).get()).get('changedAt')).toBeDefined();
  const outputs = [made, edited, await mutateNativeTask(admin, input, now), await listNativeTasks(admin, {}, now),
    await getNativeTask(admin, made.task.id, {}, now), await listNativeTaskChanges(admin, { since: '0.000000000' }, now)];
  for (const output of outputs) expect(JSON.stringify(output)).not.toContain('changedAt');
  expect((await getNativeTask(admin, made.task.id, {}, now)).activity.map(event => event.revision)).toEqual([1, 2]);
}));

test('tasks written before the feed existed are absent until their next write; the list still has them', async () => scope(async () => {
  const admin = await person();
  const template = await create(admin, 'Template');
  await nativeTasks().doc('task_legacy').set({ ...template, id: 'task_legacy', title: 'Legacy' });
  const all = await listNativeTaskSummaryChanges(admin, { since: '0.000000000' }, now);
  expect(all.tasks.map(t => t.id)).toEqual([template.id]);
  expect((await listNativeTasks(admin, {}, now)).tasks.map(t => t.id).sort()).toEqual(['task_legacy', template.id].sort());
  await retitle(admin, (await nativeTasks().doc('task_legacy').get()).data()!, 'Legacy, edited');
  expect((await listNativeTaskSummaryChanges(admin, { since: all.cursor }, now)).tasks.map(t => t.id)).toEqual([template.id, 'task_legacy']);
}));

test('counted: an idle poll avoids list rows and exact subtask progress reads', async () => scope(async () => {
  const admin = await person();
  const template = await create(admin, 'Counted template');
  const quiet = Timestamp.fromMillis(Date.now() - 2 * FEED_OVERLAP_MS);
  await nativeTasks().doc(template.id).update({ changedAt: quiet });
  for (let i = 0; i < 59; i++) await nativeTasks().doc(`task_counted_${i}`).set({ ...template, id: `task_counted_${i}`, title: `Counted ${i}`, changedAt: quiet } as never);
  const start = await listNativeTaskSummaryChanges(admin, {}, now);
  let reads = 0;
  const original = db.runTransaction.bind(db);
  const counting = (async (fn: (tx: never) => unknown, options?: object) => original(async tx => {
    const get = tx.get.bind(tx);
    (tx as { get: unknown }).get = async (target: unknown) => {
      const result = await get(target as never) as { docs?: unknown[] };
      reads += result.docs ? Math.max(1, result.docs.length) : 1; return result;
    };
    return fn(tx as never);
  }, options as never)) as typeof db.runTransaction;
  (db as { runTransaction: unknown }).runTransaction = counting;
  try {
    reads = 0; await listNativeTaskSummaryChanges(admin, { since: start.cursor }, now); const idle = reads;
    reads = 0; await listNativeTasks(admin, { limit: '50' }, now); const list = reads;
    await retitle(admin, (await nativeTasks().orderBy('title').limit(1).get()).docs[0].data(), 'One change');
    reads = 0; await listNativeTaskSummaryChanges(admin, { since: start.cursor }, now); const oneChange = reads;
    console.info(JSON.stringify({ taskChangeFeed: { idlePollReads: idle, oneChangeReads: oneChange, listPage50Reads: list } }));
    // A person's authorization is 3 reads; the list reads 51 rows and 50 empty child queries.
    expect(idle).toBe(4);
    expect(oneChange).toBe(4);
    expect(list).toBe(104);
  } finally { (db as { runTransaction: unknown }).runTransaction = original; }
}));

test('HTTP: /tasks/changes is its own route for members, and a malformed cursor is refused', async () => {
  const admin = await scope(person), token = await idTokenFor('feed-admin@example.test');
  const app = express(); app.use('/api/projects', projectManagementRoutes(now));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects/${TEST_PROJECT}/tasks/changes`;
    const headers = { authorization: `Bearer ${token}`, 'x-minions-profile-id': admin.person.id };
    const first = await fetch(url, { headers });
    expect(first.status).toBe(200);
    const { cursor } = await first.json();
    await scope(() => create(admin, 'Over HTTP'));
    const next = await (await fetch(`${url}?since=${encodeURIComponent(cursor)}`, { headers })).json();
    expect(next.tasks.map((t: { title: string }) => t.title)).toEqual(['Over HTTP']);
    expect((await fetch(`${url}?since=yesterday`, { headers })).status).toBe(400);
    expect((await fetch(`${url}?status=backlog`, { headers })).status).toBe(400);
  } finally { server.closeAllConnections(); server.close(); }
});
