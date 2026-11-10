import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { Transaction } from 'firebase-admin/firestore';
import { endProjectWork } from '../src/projects/close-work.js';
import { webAgentStarts } from '../src/owner/web-agent-starts.js';
import { runs } from '../src/v2/records.js';
import { projects } from '../src/projects/records.js';
import { db, inProject } from '../src/firestore.js';
import { prepareCurrentStateProgress, currentStateProgressShard, deleteCurrentStateSource } from '../src/view/current-state-progress.js';
import { recordContact, reportPhase, startRun } from '../src/v2/runs.js';
import { presence } from '../src/v2/records.js';
import { syncWorkerSession } from '../src/projects/worker-sessions.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
import { TransactionPrototype } from './store-prototypes.js';

beforeEach(resetEmulator);
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
const base = `projects/${TEST_PROJECT}`;
const progress = (id: string) => db.doc(`${base}/currentStateProgress/${currentStateProgressShard(id)}`);
const change = (id: string) => db.doc(`${base}/currentStateChanges/${id}`);

async function sameCommit(id: string) {
  const [status, dirty, revision] = await Promise.all([scope(() => presence().doc(id).get()), change(id).get(), progress(id).get()]);
  expect(dirty.get('revision')).toBe(revision.get('revision'));
  expect(dirty.updateTime!.isEqual(status.updateTime!)).toBe(true);
  expect(revision.updateTime!.isEqual(status.updateTime!)).toBe(true);
  expect(revision.data()).toMatchObject({ schema: 2, epoch: 'sequence-v1' });
  return revision.get('revision') as number;
}

test('start/contact/phase/worker writes atomically change progress, rejected old worker changes nothing', async () => {
  const f = await seed({ profiles: [{ name: 'P1', email: 'p1@example.test' }], agents: [{ person: 0, name: 'P1' }] });
  const id = f.agents[0]!.agentId;
  let at = 2_000_000_000_000;
  const started = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'P1-test', takeover: false }, () => at));
  expect(await sameCommit(id)).toBe(2);
  at += 120_000;
  await scope(() => recordContact(id, started.run_id, at)); expect(await sameCommit(id)).toBe(3);
  // Throttled contact and receipt replay make no change, so do not advance the fence.
  await scope(() => recordContact(id, started.run_id, at)); expect(await sameCommit(id)).toBe(3);
  await scope(() => reportPhase(id, started.run_id, { phase: 'turn' }, () => at)); expect(await sameCommit(id)).toBe(4);
  const session = { run_id: started.run_id, missionId: randomUUID(), generation: 1, startedAt: at,
    remainingSlots: 0, phase: 'working' };
  await scope(() => syncWorkerSession(id, session, () => at)); expect(await sameCommit(id)).toBe(5);
  at += 1_000;
  await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'P1-test', takeover: true }, () => at));
  const before = await sameCommit(id);
  await expect(scope(() => syncWorkerSession(id, session, () => at))).rejects.toThrow();
  expect(await sameCommit(id)).toBe(before);
});

test('rollback and SDK retry cannot leave an unfenced source or suppress the retry fence', async () => {
  const id = 'retry';
  let attempts = 0;
  await db.runTransaction(async tx => {
    attempts++;
    const ref = db.doc(`${base}/presence/${id}`);
    const signal = await prepareCurrentStateProgress(tx, [ref]); signal(ref); tx.set(ref, { runId: null, runEndedAt: null });
    if (attempts === 1) { const retry = Object.assign(new Error('injected abort'), { code: 10 }); throw retry; }
  });
  expect(attempts).toBe(2); expect(await sameCommit(id)).toBe(1);
  await expect(db.runTransaction(async tx => {
    const ref = db.doc(`${base}/presence/${id}`);
    const signal = await prepareCurrentStateProgress(tx, [ref]); signal(ref); tx.set(ref, { changed: true }); throw new Error('injected failure');
  })).rejects.toThrow('injected failure');
  expect(await sameCommit(id)).toBe(1);
});

test('atomic delete retains its tombstone; batch and cross-project cleanup use the source namespace', async () => {
  const id = 'deleted', other = 'a'.repeat(64);
  await db.doc(`${base}/presence/${id}`).set({ runId: null });
  await db.runTransaction(async tx => {
    const local = db.doc(`${base}/presence/${id}`), cross = db.doc(`projects/${other}/presence/${id}`);
    const signal = await prepareCurrentStateProgress(tx, [local, cross]);
    deleteCurrentStateSource(tx, local, signal); signal(cross); tx.set(cross, { runId: null });
  });
  expect((await db.doc(`${base}/presence/${id}`).get()).exists).toBe(false);
  const tombstone = await change(id).get(); expect(tombstone.exists).toBe(true);
  expect((await progress(id).get()).updateTime!.isEqual(tombstone.updateTime!)).toBe(true);
  expect((await db.doc(`projects/${other}/currentStateChanges/${id}`).get()).exists).toBe(true);
  await expect(db.runTransaction(async tx => prepareCurrentStateProgress(tx, [db.doc('profiles/unrelated')]))).rejects.toThrow('project status reference');
});

// Complement the existing presence-field-groups inventory. These exact writer statements must be fenced, rather
// than trusting a helper name somewhere else in the file. A newly introduced direct write fails this guard.
const root = join(import.meta.dirname, '../src');
function files(folder: string): string[] { return readdirSync(folder).flatMap(name => {
  const path = join(folder, name); return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
}); }
test('every direct status write and both group writers have an immediately adjacent atomic fence; no direct deletes exist', () => {
  let direct = 0;
  for (const path of files(root)) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/tx\.set\(presence\(\)\.doc\(([^)]+)\),/g)) {
      direct++;
      const before = source.slice(0, match.index).trimEnd();
      expect(before.endsWith(`statusProgress(presence().doc(${match[1]}));`), path).toBe(true);
    }
    expect(source, path).not.toMatch(/(?:agents|presence|runs)\(\)\.doc\([^)]*\)\.(?:delete|set|update|create)\(/);
    expect(source, path).not.toMatch(/tx\.delete\((?:agents|presence|runs)\(\)\.doc/);
  }
  expect(direct).toBe(7);
  const groups = readFileSync(join(root, 'v2/agent-group.ts'), 'utf8');
  expect([...groups.matchAll(/progress\(status\);\n  tx\.set\(status,/g)]).toHaveLength(2);
});


test('multi-page project close drains all work with every atomic transaction below 500 writes', async () => {
  await seed();
  const at = 2_000_000_000_000;
  const project = (await projects.doc(TEST_PROJECT).get()).data()!;
  await seedRuntime(TEST_PROJECT, { completedAt: at, paused: true });
  const batch = db.batch();
  for (let i = 0; i < 151; i++) batch.set(db.doc(`${base}/runs/chat-${i}`), { runId: `r-${i}`, mode: 'current_chat', endedAt: null });
  for (let i = 0; i < 201; i++) batch.set(webAgentStarts.doc(`queued-${i}`), { projectId: TEST_PROJECT, state: 'pending' } as never);
  await batch.commit();
  const counts = new Map<Transaction, number>();
  const spies = (['set', 'update', 'create', 'delete'] as const).map(name => {
    const original = TransactionPrototype[name] as (...args: unknown[]) => Transaction;
    return vi.spyOn(TransactionPrototype, name).mockImplementation(function(this: Transaction, ...args: unknown[]) {
      counts.set(this, (counts.get(this) ?? 0) + 1);
      return original.apply(this, args);
    } as never);
  });
  try { await endProjectWork(TEST_PROJECT, () => at, project.revision); }
  finally { for (const spy of spies) spy.mockRestore(); }
  expect([...counts.values()].every(n => n <= 500)).toBe(true);
  expect([...counts.values()].filter(n => n > 0).length).toBeGreaterThan(1);
  expect((await scope(() => runs().where('endedAt', '==', null).get())).empty).toBe(true);
  expect((await webAgentStarts.where('projectId', '==', TEST_PROJECT).where('state', '==', 'pending').get()).empty).toBe(true);
  expect((await db.collection(`${base}/currentStateChanges`).get()).size).toBe(151);
});
