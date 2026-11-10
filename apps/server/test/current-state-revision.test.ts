// AI-generated regression tests for the explicit, writer-complete revision fence.
import { createHash } from 'node:crypto';
import { type Transaction } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { currentProjectId, db, inProject } from '../src/firestore.js';
import { presence } from '../src/v2/records.js';
import { configureCurrentState, currentStateStats, readCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { readCurrentStateProgress, readCurrentStateRefresh } from '../src/view/current-state-progress-reader.js';
import { prepareCurrentStateProgress } from '../src/view/current-state-progress.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
const root = () => db.collection('projects').doc(currentProjectId());
let owner = '', id = '', at = 90_000_000, undo = () => {}, canonicalReads = 0;
const bump = async (tx: Transaction, agent: string, dirty = true) => {
  const ref = presence().doc(agent);
  const signal = await prepareCurrentStateProgress(tx, [ref]); signal(ref);
  if (!dirty) tx.delete(root().collection('currentStateChanges').doc(agent));
};
const read = (cursor?: string) => scope(() => readCurrentState(owner, true, cursor, at));
async function write(text: string, dirty = true) {
  await scope(() => db.runTransaction(async tx => {
    await bump(tx, id, dirty); tx.update(presence().doc(id), { 'agent.focus': { text, updatedAt: ++at } });
  }));
}
beforeEach(async () => {
  stopCurrentState(); await resetEmulator(); canonicalReads = 0; at += 1_000_000;
  const fixture = await seed({ profiles: [{ name: 'Owner', email: 'revision@example.test' }], agents: [{ person: 0, name: 'Revision' }] });
  owner = fixture.personIds[0]!; id = fixture.agents[0]!.agentId;
  await scope(() => presence().doc(id).set({ runId: null, runEndedAt: null,
    agent: { name: 'Revision', ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' } } as never));
  undo = configureCurrentState({ clock: () => at,
    refresh: async previous => { const result = await readCurrentStateRefresh(previous); if (result.full) canonicalReads++; return result; } });
});
afterEach(() => { undo(); stopCurrentState(); });

test('quiet 15s cadence is proved by bounded vector reads without full status or membership seeds', async () => {
  const first = await read(); expect(first.rows).toHaveLength(1);
  at += 15_000; const quiet = await read(first.cursor);
  expect(quiet).toMatchObject({ complete: true, rows: [], watermarkAgeMs: 0 });
  expect(canonicalReads).toBe(1);
  expect(currentStateStats()).toMatchObject({ attaches: 1, listenerSnapshots: 0, progressQuiet: 1 });
});

test('immediate write then read catches up through dirty IDs with all status callbacks withheld', async () => {
  const first = await read(); await write('immediate');
  const changed = await read(first.cursor);
  expect(changed.rows).toEqual([expect.objectContaining({ id, focus: { text: 'immediate', updatedAt: at } })]);
  expect(canonicalReads).toBe(1); expect(currentStateStats().progressDeltas).toBe(1);
});

test('advanced revision without a dirty signal refuses equality and recovers from a fresh canonical read', async () => {
  const first = await read(); await write('withheld-dirty', false);
  const changed = await read(first.cursor);
  expect(changed.rows).toEqual([expect.objectContaining({ id, focus: expect.objectContaining({ text: 'withheld-dirty' }) })]);
  expect(canonicalReads).toBe(2);
});

test('atomic delete is replayed at the same commit revision after reconnect/cold process', async () => {
  const first = await read();
  await scope(() => db.runTransaction(async tx => { await bump(tx, id); tx.delete(presence().doc(id)); }));
  const removed = await read(first.cursor); expect(removed.rows).toEqual([expect.objectContaining({ id, removed: true })]);
  stopCurrentState();
  const cold = await read(first.cursor);
  expect(cold.rows).toEqual(removed.rows); expect(cold.complete).toBe(true);
});

test('a read after an acknowledged write cannot share an older in-flight proof', async () => {
  const first = await read(); await write('first');
  let unblock!: () => void, reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { unblock = resolve; });
  let paused = false;
  const restore = configureCurrentState({ refresh: async previous => {
    const snapshot = await readCurrentStateRefresh(previous);
    if (!paused) { paused = true; reached(); await gate; }
    return snapshot;
  } });
  try {
    const older = read(first.cursor); await waiting; await write('second');
    const newer = read(first.cursor); unblock();
    const answers = await Promise.all([older, newer]);
    expect(answers[1].rows).toContainEqual(expect.objectContaining({ focus: expect.objectContaining({ text: 'second' }) }));
  } finally { unblock(); restore(); }
});

test('malformed shards cannot prove currentness or advance the published cursor', async () => {
  const first = await read();
  await scope(() => root().collection('currentStateProgress').doc((createHash('sha256').update(id).digest()[0]! % 16).toString().padStart(2, '0')).update({ revision: -1 }));
  expect((await scope(readCurrentStateProgress)).active).toBe(false);
  await expect(read(first.cursor)).rejects.toThrow('progress is malformed');
  await scope(() => root().collection('currentStateProgress').doc((createHash('sha256').update(id).digest()[0]! % 16).toString().padStart(2, '0')).update({ revision: 0 }));
  expect((await read(first.cursor)).complete).toBe(true);
});
