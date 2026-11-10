// Exact historical totals without migration; progress proves quiet/busy reads.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { combineReportedUsage, type ReportedUsage } from '@mlswarm/contracts';
import { agents, db, inProject, type Transaction } from '../src/firestore.js';
import { runnerUsage, type LastTurn } from '../src/v2/records.js';
import { startRun, reportPhase } from '../src/v2/runs.js';
import { reportTurn } from '../src/v2/turn-reports.js';
import { prepareUsageProgress, usageChanges, usageProgress, usageShard } from '../src/v2/usage-progress.js';
import { readProjectUsage, projectUsageStats, configureProjectUsage, stopProjectUsage } from '../src/view/project-usage.js';
import { resetEmulator, seed, addAgent, seedCurrentStateReady, TEST_PROJECT } from './helpers.js';
import { CURRENT_STATE_CUTOVER_RECEIPT } from '../src/view/current-state-cutover.js';
import { instrumentFirestoreWork, meter, work } from './firestore-work-meter.js';
import { TransactionPrototype } from './store-prototypes.js';

const at = 7_000_000, now = () => at;
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const read = () => scope(() => readProjectUsage(now));
const turn = (sequence: number, semantics: 'uncached' | 'includes-cache' = 'uncached'): LastTurn => ({ kind: 'turn', outcome: 'succeeded', endedAt: at,
  usage: { sequence, model: 'm', seconds: 1, inputSemantics: semantics,
    tokens: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, modelCalls: 1 } } });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Person', email: 'usage@example.test' }], agents: [{ person: 0, name: 'Agent' }] });
  const id = f.agents[0]!.agentId, owner = f.personIds[0]!;
  const run = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic', takeover: false }, now));
  return { id, owner, runId: run.run_id };
}
async function oracle() {
  return scope(async () => {
    const [docs, count] = await Promise.all([runnerUsage().get(), agents().count().get()]);
    const rows = docs.docs.map(d => d.data()), total = Math.max(count.data().count, rows.length);
    return { ...combineReportedUsage([...rows as ReportedUsage[], ...Array<null>(total - rows.length).fill(null)]),
      lastReportedAt: rows.reduce<number | null>((n, r) => Number.isFinite(r.lastReportedAt) ? Math.max(n ?? 0, r.lastReportedAt) : n, null), serverTime: at };
  });
}
beforeEach(resetEmulator);
afterEach(() => { vi.restoreAllMocks(); stopProjectUsage(); });

test('one unaggregated historical row among 5000 cannot force quiet full scans or writes', async () => {
  await seed();
  await scope(async () => {
    for (let n = 0; n < 5000; n += 200) {
      const batch = db.batch();
      for (let k = n; k < n + 200; k++) batch.set(runnerUsage().doc(`historical-${k}`), { turns: 1, input: 20, output: 5, cacheRead: 3, cacheWrite: 2,
        tokenCoverage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, inputSemantics: k === 0 ? 'mixed' : 'uncached', lastReportedAt: k } as never);
      await batch.commit();
    }
  });
  const expected = await oracle(), restore = instrumentFirestoreWork();
  const cold = work(), quiet = work();
  try {
    expect(await meter.run(cold, read)).toEqual(expected);
    for (let i = 0; i < 4; i++) expect(await meter.run(quiet, read)).toEqual(expected);
    expect(cold.writes + quiet.writes).toBe(0);
    expect(quiet.reads).toBe(8); // receipt + empty vector per poll, no COUNT or usage-row read
    expect(projectUsageStats()).toMatchObject({ seeds: 1, quiet: 4, seedRows: 5000 });
  } finally { restore(); }
});

test('whole normalized rows preserve partial/mixed counters, duplicate evidence and never-report agents', async () => {
  const f = await fixture(); await scope(() => addAgent(f.owner, 'Never reports', now));
  await scope(() => reportTurn(f.id, f.runId, turn(1), now));
  expect(await read()).toEqual(await oracle());
  const before = await scope(() => usageProgress().get());
  expect((await scope(() => reportTurn(f.id, f.runId, turn(1), now))).duplicate).toBe(true);
  expect((await scope(() => usageProgress().get())).docs.map(d => d.updateTime.toMillis())).toEqual(before.docs.map(d => d.updateTime.toMillis()));
  await expect(scope(() => reportTurn(f.id, f.runId, { ...turn(1), outcome: 'failed' }, now))).rejects.toThrow('different evidence');
  await scope(() => reportTurn(f.id, f.runId, turn(2, 'includes-cache'), now));
  expect(await read()).toEqual(await oracle());
  expect((await read()).input).toBeNull(); // mixed semantics invalidates formerly known input
  expect((await read()).output).toMatchObject({ value: 10, partial: true });
});

test('historical completion after takeover advances usage without changing status progress', async () => {
  const f = await fixture(); await read();
  await scope(() => startRun(f.id, { clientRunId: randomUUID(), runnerVersion: 'new', takeover: true }, now));
  const status = db.collection(`projects/${TEST_PROJECT}/currentStateProgress`), before = await status.get();
  await scope(() => reportTurn(f.id, f.runId, turn(1), now));
  expect((await status.get()).docs.map(d => d.updateTime.toMillis())).toEqual(before.docs.map(d => d.updateTime.toMillis()));
  expect((await read()).reports).toBe(1); expect(await read()).toEqual(await oracle());
});

test('creation-only progress changes agent denominator without a seed, usage query, or COUNT', async () => {
  const f = await fixture(); await scope(() => reportTurn(f.id, f.runId, turn(1), now)); await read();
  await scope(() => addAgent(f.owner, 'Later', now));
  const restore = instrumentFirestoreWork(), bucket = work();
  try {
    const value = await meter.run(bucket, read);
    expect(value).toMatchObject({ agents: 2, output: { value: 5, partial: true } });
    expect(projectUsageStats().seeds).toBe(1); expect(projectUsageStats().headReads).toBe(0);
    expect(bucket.reads).toBeLessThanOrEqual(3);
  } finally { restore(); }
});

test('coalesced changed heads and signaled deletions replace historical totals and lower last report time', async () => {
  const f = await fixture(); await scope(() => reportTurn(f.id, f.runId, turn(1), () => 9000)); await read();
  await scope(() => reportTurn(f.id, f.runId, turn(2), () => 8000));
  expect((await read()).lastReportedAt).toBe(8000); expect(await read()).toEqual(await oracle());
  await scope(() => db.runTransaction(async tx => { const mark = await prepareUsageProgress(tx, [f.id]); mark(f.id, 'usage'); tx.delete(runnerUsage().doc(f.id)); }));
  expect(await read()).toMatchObject({ agents: 1, reports: 0, lastReportedAt: null });
});

test('same-shard concurrent receipts serialize without losing work, including phase-report usage', async () => {
  const f = await fixture(); await read();
  await Promise.all(Array.from({ length: 5 }, (_, k) => scope(() => reportTurn(f.id, f.runId, turn(k + 1), now))));
  await scope(() => reportPhase(f.id, f.runId, { phase: 'idle', lastTurn: turn(6) }, now));
  expect((await read()).reports).toBe(6); expect(await read()).toEqual(await oracle());
});

test('receipt/counter reset and eviction seed consistent truth; old status-only admission is refused', async () => {
  const f = await fixture(); await scope(() => reportTurn(f.id, f.runId, turn(1), now)); await read();
  await db.doc(CURRENT_STATE_CUTOVER_RECEIPT).update({ schema: 1 });
  await expect(read()).rejects.toMatchObject({ code: 'project_busy' });
  await seedCurrentStateReady(); expect(await read()).toEqual(await oracle());
  // Stopped-service maintenance must close admission and clear both protocol collections.
  // Resetting only counters in-place is unsupported and cannot establish a writer floor.
  await db.doc(CURRENT_STATE_CUTOVER_RECEIPT).delete();
  await expect(read()).rejects.toMatchObject({ code: 'project_busy' });
  await scope(async () => {
    for (const doc of (await usageProgress().get()).docs) await doc.ref.delete();
    for (const doc of (await usageChanges().get()).docs) await doc.ref.delete();
  });
  await seedCurrentStateReady(); expect(await read()).toEqual(await oracle());
  await scope(() => reportTurn(f.id, f.runId, turn(2), now));
  expect(await read()).toEqual(await oracle());
  const undo = configureProjectUsage({ bytes: 0 });
  try { await read(); expect(projectUsageStats().projects).toBe(0); expect(await read()).toEqual(await oracle()); }
  finally { undo(); }
});

test('malformed or missing replay evidence fails clearly without publishing stale success', async () => {
  const f = await fixture(); await read(); await scope(() => reportTurn(f.id, f.runId, turn(1), now));
  await scope(() => usageChanges().doc(f.id).delete());
  await expect(read()).rejects.toThrow('without replay evidence');
  expect(projectUsageStats().projects).toBe(0);
  expect(await read()).toEqual(await oracle()); // counted canonical recovery after a failed proof
});

test('SDK failure detaches projection; the next request recovers and concurrent requests each prove freshness', async () => {
  const f = await fixture(); await read();
  const get = vi.spyOn(TransactionPrototype, 'get').mockRejectedValueOnce(new Error('injected transport failure'));
  await expect(read()).rejects.toThrow('injected transport failure'); get.mockRestore();
  expect(projectUsageStats().projects).toBe(0);
  await scope(() => reportTurn(f.id, f.runId, turn(1), now));
  const before = projectUsageStats().attempts;
  const values = await Promise.all([read(), read(), read(), read()]);
  expect(values.every(v => v.reports === 1)).toBe(true);
  expect(projectUsageStats().attempts - before).toBe(4);
});


test('token-less and missing per-field counters preserve exact historical partial accounting', async () => {
  const f = await fixture();
  const absent = turn(1); absent.usage!.tokens = null;
  await scope(() => reportTurn(f.id, f.runId, absent, now));
  const partial = turn(2); partial.usage!.tokens!.cacheRead = null;
  await scope(() => reportTurn(f.id, f.runId, partial, now));
  expect(await read()).toEqual(await oracle());
  expect(await read()).toMatchObject({ reports: 2, input: null, uncached: null, cacheRead: null, output: { value: 5, reports: 1, partial: true } });
});

test('different IDs in one shard batch preserve every creation and coalesced usage head', async () => {
  await seed();
  const ids: string[] = []; for (let n = 0; ids.length < 2; n++) if (usageShard(`collision-${n}`) === '00') ids.push(`collision-${n}`);
  await read();
  await scope(() => db.runTransaction(async tx => {
    const mark = await prepareUsageProgress(tx, ids);
    for (const id of ids) {
      mark(id, 'created'); mark(id, 'created'); mark(id, 'usage');
      tx.create(agents().doc(id), { name: id, ownerProfileId: 'synthetic', revokedAt: null } as never);
      tx.set(runnerUsage().doc(id), { turns: 1, output: 7, tokenCoverage: { output: 1 }, lastReportedAt: -1 } as never);
    }
  }));
  expect((await scope(() => usageProgress().doc('00').get())).get('created')).toBe(2);
  expect(await read()).toMatchObject({ agents: 2, reports: 2, output: { value: 14 }, lastReportedAt: 0 });
  expect(await read()).toEqual(await oracle());
});

test('a request after an acknowledged write cannot join a pre-write in-flight proof', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const original = db.runTransaction.bind(db); let proofs = 0;
  const spy = vi.spyOn(db, 'runTransaction').mockImplementation(((fn: (tx: Transaction) => Promise<unknown>, options: { readOnly?: boolean }) =>
    original(async tx => { const result = await fn(tx); if (options?.readOnly && ++proofs === 1) { entered(); await gate; } return result; }, options as never)) as never);
  const a = read();
  try {
    await started; await scope(() => reportTurn(f.id, f.runId, turn(1), now));
    const b = read(); release();
    expect((await a).reports).toBe(0); expect((await b).reports).toBe(1);
  } finally { release(); await a; spy.mockRestore(); }
});
