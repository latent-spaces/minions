import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Transaction } from 'firebase-admin/firestore';
import { db, inProject } from '../src/firestore.js';
import { presence } from '../src/v2/records.js';
import { readCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { currentStateProgressShard, prepareCurrentStateProgress } from '../src/view/current-state-progress.js';
import { setCanonicalStatus } from './canonical-status-fixture.js';
import { resetEmulator, TEST_PROJECT } from './helpers.js';
import { QueryPrototype, TransactionPrototype } from './store-prototypes.js';
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeEach(async () => { stopCurrentState(); await resetEmulator(); });
afterEach(() => { vi.restoreAllMocks(); stopCurrentState(); });

test('canonical serving has no membership seed, listener, legacy run or pointer status assembly', async () => {
  const sourceRoot = join(import.meta.dirname, '../src/view');
  for (const name of ['current-status-source.ts', 'status-migration.ts', 'status-migration-audit.ts']) expect(existsSync(join(sourceRoot, name))).toBe(false);
  for (const name of ['communication-agents.ts', 'current-state.ts']) {
    const source = readFileSync(join(sourceRoot, name), 'utf8');
    expect(source).not.toMatch(/agentStateSources|readMigrationRuns|readAgentStates|WORKER_SUMMARY_SOURCE|workerPointer|runs\(\)/);
  }
  vi.spyOn(QueryPrototype, 'onSnapshot').mockImplementation(() => { throw new Error('Status must not attach listeners.'); });
  const get = TransactionPrototype.get;
  vi.spyOn(TransactionPrototype, 'get').mockImplementation(function(this: Transaction, ref: any, ...args: any[]) {
    if (ref.path) expect(ref.path).not.toMatch(/\/agents(?:\/|$)|\/runs(?:\/|$)|\/workerSessions(?:\/|$)/);
    return (get as any).call(this, ref, ...args);
  });
  await scope(() => setCanonicalStatus('a', { runId: null, runEndedAt: null,
    agent: { name: 'Canonical', ownerProfileId: 'owner', revokedAt: null, connectionEpoch: 0, focus: null, personaText: '' } }));
  const first = await scope(() => readCurrentState('viewer', true, undefined, 10_000));
  expect(first.rows).toHaveLength(1);
  expect((await scope(() => readCurrentState('viewer', true, first.cursor, 25_000))).rows).toEqual([]);
});

test('two agents sharing a shard get one atomic sequence and both replay; concurrent transactions cannot lose an increment', async () => {
  const buckets = new Map<string, string[]>();
  let ids: string[] = [];
  for (let i = 0; ids.length < 2; i++) {
    const id = `collision-${i}`, shard = currentStateProgressShard(id), bucket = [...buckets.get(shard) ?? [], id];
    buckets.set(shard, bucket); if (bucket.length === 2) ids = bucket;
  }
  const first = await scope(() => readCurrentState('viewer', true, undefined, 10_000));
  await scope(() => db.runTransaction(async tx => {
    const refs = ids.map(id => presence().doc(id));
    const signal = await prepareCurrentStateProgress(tx, refs);
    for (const ref of refs) { signal(ref); tx.set(ref, { runId: null, runEndedAt: null,
      agent: { name: ref.id, ownerProfileId: 'owner', revokedAt: null, connectionEpoch: 0, focus: null, personaText: '' } } as never); }
  }));
  const sameCommit = await scope(() => readCurrentState('viewer', true, first.cursor, 25_000));
  expect(sameCommit.rows.map(row => row.id).sort()).toEqual(ids.sort());
  const shard = db.doc(`projects/${TEST_PROJECT}/currentStateProgress/${currentStateProgressShard(ids[0]!)}`);
  expect((await shard.get()).get('revision')).toBe(1);
  await Promise.all(ids.map(id => scope(() => db.runTransaction(async tx => {
    const ref = presence().doc(id), signal = await prepareCurrentStateProgress(tx, [ref]);
    signal(ref); tx.update(ref, { 'agent.focus': { text: id, updatedAt: 1 } });
  }))));
  expect((await shard.get()).get('revision')).toBe(3);
  const concurrent = await scope(() => readCurrentState('viewer', true, sameCommit.cursor, 40_000));
  expect(concurrent.rows.map(row => row.id).sort()).toEqual(ids.sort());
});
