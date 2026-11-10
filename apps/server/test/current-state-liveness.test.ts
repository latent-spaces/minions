// Essential former listener regressions, ported to transactional progress: quiet currentness, failures,
// concurrent freshness, revocation, conflict recovery and lifecycle cleanup. No model or cloud service.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { presence } from '../src/v2/records.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { rev } from '../src/view/current-state-core.js';
import { readCurrentStateRefresh } from '../src/view/current-state-progress-reader.js';
import { configureCurrentState, currentStateStats, readCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { seed, resetEmulator, TEST_PROJECT } from './helpers.js';
import { updateCanonicalStatus } from './canonical-status-fixture.js';
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
let now = 1_000_000, owner = '', id = '', runId = '', undo = () => {};
const read = (cursor?: string) => scope(() => readCurrentState(owner, true, cursor, now));
beforeEach(async () => {
  stopCurrentState(); await resetEmulator(); now += 1_000_000;
  const f = await seed({ profiles: [{ name: 'Owner', email: 'progress-live@example.test' }], agents: [{ person: 0, name: 'Live' }] });
  owner = f.personIds[0]!; id = f.agents[0]!.agentId;
  const run = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => now));
  runId = run.run_id;
  await scope(() => reportPhase(id, runId, { phase: 'turn' }, () => now));
  undo = configureCurrentState({ clock: () => now });
});
afterEach(() => { undo(); stopCurrentState(); });

test('quiet 15-second polls advance a proved floor without seed reads, reattachment or writes', async () => {
  let answer = await read(); const before = currentStateStats();
  for (let i = 0; i < 4; i++) {
    now += 15_000; answer = await read(answer.cursor);
    expect(answer).toMatchObject({ complete: true, notReady: false, rows: [], watermarkAgeMs: 0 });
  }
  const after = currentStateStats();
  expect(after.canonicalReads).toBe(before.canonicalReads);
  expect(after.tombstoneDocs).toBe(before.tombstoneDocs);
  expect(after.changes).toBe(before.changes);
  expect(after.fenceDocs - before.fenceDocs).toBe(4);
  expect(after.reattaches).toBe(0); expect(after.listenerSeedDocs).toBe(0);
});

test('concurrent quiet viewers share the projection, each with a post-request transaction', async () => {
  const first = await read(); now += 15_000;
  const before = currentStateStats();
  const answers = await Promise.all(Array.from({ length: 4 }, () => read(first.cursor)));
  expect(answers.every(a => a.complete && !a.rows.length && a.watermarkAgeMs === 0)).toBe(true);
  const after = currentStateStats();
  expect(after.canonicalReads).toBe(before.canonicalReads);
  expect(after.fences - before.fences).toBe(4); expect(after.attaches).toBe(1);
});

test('SDK failure never publishes stale success, releases the failed cache, and the next request recovers', async () => {
  const first = await read();
  await scope(() => reportPhase(id, runId, { phase: 'stopping' }, () => now));
  configureCurrentState({ refresh: async () => { throw new Error('injected transport failure'); } });
  await expect(read(first.cursor)).rejects.toThrow('injected transport failure');
  expect(currentStateStats().cachedProjects).toBe(0);
  configureCurrentState({ refresh: readCurrentStateRefresh });
  const recovered = await read(first.cursor);
  expect(recovered.rows).toContainEqual(expect.objectContaining({ id, state: 'stopped' }));
  expect(recovered.watermark! >= first.watermark!).toBe(true);
});

test('a revocation appears in the first request after its atomic commit', async () => {
  const first = await read(); now += 15_000;
  await scope(() => revokeOwned(owner, id, () => now));
  expect((await read(first.cursor)).rows).toContainEqual(expect.objectContaining({ id, state: 'revoked' }));
  expect(currentStateStats().reattaches).toBe(0);
});

test('same-revision conflicting contents invalidate the cache, never loop; next request reseeds current truth', async () => {
  const first = await read();
  const snapshot = await scope(() => presence().get());
  const restore = configureCurrentState({ refresh: async previous => {
    const result = await readCurrentStateRefresh(previous);
    const doc = snapshot.docs[0]!;
    return { ...result, full: false, snapshot: { size: 1, readTime: result.fence.readTime,
      docChanges: () => [{ type: 'modified', doc: { id, updateTime: doc.updateTime,
        data: () => ({ ...doc.data(), phase: 'idle' }) } }] } as never };
  } });
  try { await expect(read(first.cursor)).rejects.toThrow('changed content without a new commit time'); }
  finally { restore(); }
  expect(currentStateStats().cachedProjects).toBe(0);
  expect((await read()).rows).toContainEqual(expect.objectContaining({ id, state: 'working' }));
});

test('a completed poll still re-evaluates offline/deadline timers without a new source commit', async () => {
  const first = await read(); now += 90_000;
  const expired = await read(first.cursor);
  expect(expired.rows).toContainEqual(expect.objectContaining({ id, state: 'offline' }));
  expect(currentStateStats().canonicalReads).toBe(1);
});

test('linger releases the cache; reconnect sees committed work from the held cursor', async () => {
  configureCurrentState({ lingerMs: 20 });
  const first = await read();
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(currentStateStats().cachedProjects).toBe(0);
  await scope(() => updateCanonicalStatus(id, { 'agent.focus': { text: 'after detach', updatedAt: ++now } }));
  expect((await read(first.cursor)).rows).toContainEqual(expect.objectContaining({ id, focus: { text: 'after detach', updatedAt: now } }));
});


test('another reader dependency failure cannot discard a post-write proof or poison the shared cache', async () => {
  const first = await read();
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const depsStarted = deferred(), failA = deferred(), refreshStarted = deferred(), releaseB = deferred();
  let depsCalls = 0, refreshCalls = 0;
  configureCurrentState({
    afterDepsRead: async () => {
      if (++depsCalls === 1) { depsStarted.resolve(); await failA.promise; throw new Error('injected dependency failure'); }
    },
    refresh: async previous => {
      const result = await readCurrentStateRefresh(previous);
      if (++refreshCalls === 2) { refreshStarted.resolve(); await releaseB.promise; }
      return result;
    },
  });
  const a = read(first.cursor), failed = expect(a).rejects.toThrow('injected dependency failure');
  try {
    await depsStarted.promise;
    await scope(() => updateCanonicalStatus(id, { 'agent.focus': { text: 'fresh B', updatedAt: ++now } }));
    const b = read(first.cursor); await refreshStarted.promise;
    failA.resolve(); await failed; releaseB.resolve();
    expect((await b).rows).toContainEqual(expect.objectContaining({ id, focus: { text: 'fresh B', updatedAt: now } }));
  } finally { failA.resolve(); releaseB.resolve(); await failed; }
});


test('a response keeps the proof and delivery time of its fixed rows across concurrent refreshes', async () => {
  const first = await read();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const waiting = new Promise<void>(done => { started = done; });
  let calls = 0, proof = '';
  configureCurrentState({
    refresh: async previous => {
      const result = await readCurrentStateRefresh(previous);
      if (!proof) proof = rev(result.fence.readTime.seconds, result.fence.readTime.nanoseconds);
      return result;
    },
    afterDepsRead: async () => { if (++calls === 1) { started(); await gate; } },
  });
  const a = read(first.cursor);
  try {
    await waiting;
    now += 1000;
    await scope(() => updateCanonicalStatus(id, { 'agent.focus': { text: 'later proof', updatedAt: now } }));
    const b = await read(first.cursor);
    expect(b.watermark! > proof).toBe(true);
    release();
    const answer = await a;
    expect(answer.watermark).toBe(proof);
    expect(answer.watermarkAgeMs).toBe(1000);
    expect(answer.rows).toEqual([]);
  } finally { release(); await a; }
});
