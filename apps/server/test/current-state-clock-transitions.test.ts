import { setCanonicalStatus } from './canonical-status-fixture.js';
// Failing-first acceptance for the CS2b current-state read (c10, buddy c3; TEAM-PLAN "One vertical slice", open freeze
// question 2): transitions that change an agent's state WITHOUT a write to its status document. The listener sees no
// change for them, so the delta after a cursor is empty; a viewer holding that cursor must still be able to reach the
// state a fresh snapshot shows at the same moment. Contract C4: Offline (contact + 90 s) and
// pause_unconfirmed are evaluated at read and re-evaluated by the client from the row's timestamps. Contract C7: the
// project pause request is sent whole in each answer.
//
// The rule: for each agent whose state in a fresh snapshot at t2 differs from its state at t1, the delta at t2 must
// carry that agent's row at the snapshot's state, or carry the project pause whole (pause and resume), or the client
// must be able to derive the target state from fields the contract names (c1's review): freshUntil ≤ t2 → Offline
// (C4), the answer's pause requestedAt + 30 s ≤ t2 → pause_unconfirmed (C4, C7).
// A bare "some timestamp is due" is not enough: re-asking returns an empty delta again because no source changed.
// The answer-level pause is any top-level key naming pause with a revision (c2 picks the name). Writes are real
// (emulator); the read clock is the route's injected `now`.
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { viewRoutes } from '../src/view/routes.js';
import { stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

const FRESH_MS = 90_000;
let at = 70_000_000, server: Server | undefined, base = '';
const scope = <T>(work: () => Promise<T>) => inProject(TEST_PROJECT, work);
beforeEach(async () => {
  stopCurrentState();
  await resetEmulator(); at += 10_000_000;
  const app = express(); app.use(scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server?.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve()));
});
afterAll(() => stopCurrentState());

type Row = { id: string; state?: string; removed?: true; [field: string]: unknown };
type Answer = { rows: Row[]; cursor: string; [field: string]: unknown };
async function current(token: string, cursor?: string) {
  const response = await fetch(`${base}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return await response.json() as Answer;
}
async function until(read: () => Promise<Answer>, ok: (a: Answer) => boolean) {
  for (let i = 0; i < 100; i++) { const a = await read(); if (ok(a)) return a; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('The listener did not deliver in time.');
}
// A complete status document (CS2a field groups), with the worker summary written into presence.worker (gate 2 (a)).
async function writeStatus(agentId: string, owner: string, fields: Record<string, unknown> = {}) {
  await scope(() => setCanonicalStatus(agentId,{ runId: 'run-1', lastContactAt: at, phase: 'turn', phaseAt: at, acceptingWork: true,
    runEndedAt: null, runMode: 'background',
    agent: { name: agentId, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' }, ...fields } as never, { merge: true }));
}
const worker = (over: Record<string, unknown> = {}) =>
  ({ runId: 'run-1', phase: 'working', lastContactAt: at, projectPauseRevision: null, ...over });
async function fixture(status: Record<string, unknown> = {}) {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'clock-alice@example.test' }], agents: [{ person: 0, name: 'alice-fox' }] });
  const fox = f.agents[0]!.agentId, owner = f.personIds[0]!;
  await writeStatus(fox, owner, status);
  return { fox, owner, token: await idTokenFor('clock-alice@example.test') };
}
const rowOf = (answer: Answer, id: string) => answer.rows.find(row => row.id === id);
// Contract v2.3 (c2 de00ba0e): a row re-sent because a clock boundary passed, with no source write, keeps its source rev and
// adds evaluatedAt, so a client replacing on (rev, evaluatedAt) greater takes it. Checked only when the delta re-sends it.
function expectResent(before: Answer, after: Answer, id: string) {
  const held = rowOf(before, id)!, sent = rowOf(after, id);
  if (!sent) return;
  expect(sent.rev).toBe(held.rev);
  expect(typeof sent.evaluatedAt).toBe('number');
  if (typeof held.evaluatedAt === 'number') expect(sent.evaluatedAt as number).toBeGreaterThan(held.evaluatedAt);
}
// Some top-level field of the answer that carries the project pause (C7; the name is c2's), matched by its revision.
const pauseIn = (answer: Answer, revision: number) => Object.entries(answer).some(([key, value]) => /pause/i.test(key)
  && value !== null && typeof value === 'object' && (value as { revision?: unknown }).revision === revision);
// The named fields of the t1 row that fall due in (t1, t2] (c1: never "any numeric field").
const NAMED = ['freshUntil'] as const;
const dueIn = (row: Row, t1: number, t2: number) => NAMED.filter(key => typeof row[key] === 'number'
  && (row[key] as number) > t1 && (row[key] as number) <= t2);
// The pause request an answer carries whole (C7), whatever c2 names the key.
const pauseOf = (answer: Answer) => Object.entries(answer).find(([key, value]) => /pause/i.test(key) && value !== null
  && typeof value === 'object' && typeof (value as { requestedAt?: unknown }).requestedAt === 'number')?.[1] as { requestedAt: number } | undefined;

test('pause with no presence change: a viewer holding a cursor learns the pause in its next answer', async () => {
  const { fox, token } = await fixture({ worker: worker() });
  const first = await until(() => current(token), a => a.rows.length === 1);
  expect(rowOf(first, fox)).toMatchObject({ state: 'working' });
  // The owner pauses the project: one write to the project document, none to presence.
  at += 1_000;
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 7, pauseRequest: { revision: 7, requestedAt: at } });
  // Positive control: the endpoint's own derivation sees the pause in a fresh snapshot.
  const snapshot = await current(token);
  expect(rowOf(snapshot, fox)).toMatchObject({ state: 'pausing', projectPause: { revision: 7 } });
  // The delta: either the agent's row at its paused-side state, or the pause request whole in the answer (C7).
  const delta = await current(token, first.cursor);
  expectResent(first, delta, fox);
  expect(delta).not.toHaveProperty('fallback');
  const reached = rowOf(delta, fox)?.state === 'pausing' || pauseIn(delta, 7);
  expect({ rows: delta.rows.length, pauseInAnswer: pauseIn(delta, 7), reached }).toMatchObject({ reached: true });
});

test('resume with no presence change: a viewer holding a paused-side cursor learns the resume', async () => {
  const { fox, token } = await fixture({ worker: worker() });
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 7, pauseRequest: { revision: 7, requestedAt: at } });
  const first = await until(() => current(token), a => a.rows.length === 1);
  expect(rowOf(first, fox)).toMatchObject({ state: 'pausing' });
  at += 1_000;
  await seedRuntime(TEST_PROJECT, { paused: false, revision: 8, pauseRequest: undefined });
  expect(rowOf(await current(token), fox)).toMatchObject({ state: 'working' });
  const delta = await current(token, first.cursor);
  expectResent(first, delta, fox);
  // A resume must be distinguishable from "nothing new": the agent's row at its resumed state, or an answer-level
  // pause field that says no pause is in force (any top-level key naming pause, present with null/false).
  const pauseCleared = Object.entries(delta).some(([key, value]) => /pause/i.test(key) && (value === null || value === false));
  expect({ rows: delta.rows.length, reached: rowOf(delta, fox)?.state === 'working' || pauseCleared }).toMatchObject({ reached: true });
});

// A status document written before 10 November 2026 can hold the worker's end time; it is not read.
test('a stored worker end time that has passed is not an ending: the worker stays Working and nothing is re-sent', async () => {
  const deadline = at + 30_000;
  const { fox, token } = await fixture({ worker: worker({ deadlineAt: deadline }) });
  const first = await until(() => current(token), a => a.rows.length === 1);
  expect(rowOf(first, fox)).toMatchObject({ state: 'working' });
  expect(JSON.stringify(first)).not.toContain('deadlineAt');
  // 31 s later, nothing written: inside the 90 s contact bound and past the stored end time.
  at = deadline + 1_000;
  expect(rowOf(await current(token), fox)).toMatchObject({ state: 'working' });
  expect((await current(token, first.cursor)).rows).toEqual([]);
});

test('contact + 90 s → Offline with no write: the t1 row\'s freshUntil is due exactly at the boundary', async () => {
  const contact = at;
  const { fox, token } = await fixture({ worker: worker() });
  const t1 = at;
  const first = await until(() => current(token), a => a.rows.length === 1);
  expect(rowOf(first, fox)).toMatchObject({ state: 'working', freshUntil: contact + FRESH_MS });
  // One millisecond before the bound: still Working on a fresh snapshot, and nothing on the row is due yet.
  at = contact + FRESH_MS - 1;
  expect(rowOf(await current(token), fox)).toMatchObject({ state: 'working' });
  expect(dueIn(rowOf(first, fox)!, t1, at)).toEqual([]);
  // At the bound: Offline on a fresh snapshot. The t1 row's freshUntil is due; the delta may also re-send the row
  // (c3's boundary re-derivation, same rev), but only at the snapshot's state.
  at = contact + FRESH_MS;
  expect(rowOf(await current(token), fox)).toMatchObject({ state: 'offline' });
  const delta = await current(token, first.cursor);
  expectResent(first, delta, fox);
  expect(rowOf(delta, fox)?.state ?? 'offline').toBe('offline');
  expect(dueIn(rowOf(first, fox)!, t1, at)).toContain('freshUntil');
  // No repeated work: from the cursor that answer returned, a quiet next answer re-sends nothing.
  at += 1_000;
  expect((await current(token, delta.cursor)).rows).toEqual([]);
});

test('pause unconfirmed after 30 s with no write: the client can tell the pause request is 30 s old', async () => {
  // A worker between turns; one still in its turn stays pausing while the turn finishes (owner decision, 9 November 2026).
  const { fox, token } = await fixture({ worker: worker({ phase: 'waiting' }) });
  const requestedAt = at;
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 9, pauseRequest: { revision: 9, requestedAt } });
  const first = await until(() => current(token), a => a.rows.length === 1);
  expect(rowOf(first, fox)).toMatchObject({ state: 'pausing' });
  at = requestedAt + 30_000;
  expect(rowOf(await current(token), fox)).toMatchObject({ state: 'pause_unconfirmed' });
  const delta = await current(token, first.cursor);
  expectResent(first, delta, fox);
  // freshUntil = min(contact + 90 s, requestedAt + 30 s) is due, but by itself reads as Offline. The client reaches
  // pause_unconfirmed from a delta row, or from the pause request's requestedAt: on the answer (C7) or on the t1 row.
  const pause = pauseOf(delta) ?? pauseOf(first) ?? (rowOf(first, fox)!.projectPause as { requestedAt?: number } | undefined);
  expect({ deltaRow: rowOf(delta, fox)?.state ?? null, pauseRequestedAt: pause?.requestedAt ?? null })
    .toSatisfy((r: { deltaRow: string | null; pauseRequestedAt: number | null }) => r.deltaRow === 'pause_unconfirmed'
      || (r.pauseRequestedAt !== null && r.pauseRequestedAt + 30_000 <= at));
});

test('a contact stamped ahead of the read clock: Offline at t1, Working once it is no longer in the future', async () => {
  // A writer whose clock runs 5 s ahead (codex-1's skew case): today's derivation ignores contacts after `now`.
  const ahead = at + 5_000;
  const { fox, token } = await fixture({ lastContactAt: ahead, phaseAt: ahead, worker: worker({ lastContactAt: ahead }) });
  const first = await until(() => current(token), a => a.rows.length === 1);
  expect(rowOf(first, fox)).toMatchObject({ state: 'offline' });
  at = ahead;
  expect(rowOf(await current(token), fox)).toMatchObject({ state: 'working' });
  // No named field on the t1 row says Working is coming (a future contact is not shown), so only a delta row can.
  const delta = await current(token, first.cursor);
  expectResent(first, delta, fox);
  expect(rowOf(delta, fox)?.state ?? null).toBe('working');
});

test('a process whose clock is behind the cursor\'s evaluation time answers notReady, never an older state (c7, v2.3 E rule)', async () => {
  // A second process on the same project whose clock reads 2 s behind the first (contract v2.3, c2 0863aaf4: a
  // process with now < E answers notReady with the same cursor and never clamps). Scope (c7): both apps run in this
  // Node process and share the module-level projection, so this isolates clock skew only, not listener or W lag (c13).
  const app = express(); app.use(scoped(viewRoutes(() => at - 2_000)));
  const behind = app.listen(0, '127.0.0.1'); await once(behind, 'listening');
  const behindBase = `http://127.0.0.1:${(behind.address() as { port: number }).port}`;
  try {
    const bound = at + FRESH_MS;
    const { fox, token } = await fixture({ worker: worker() });
    const first = await until(() => current(token), a => a.rows.length === 1);
    // 1 s past the contact bound on the first process: Offline, re-sent by the clock rule.
    at = bound + 1_000;
    const seen = await current(token, first.cursor);
    const shown = rowOf(seen, fox)?.state ?? rowOf(first, fox)!.state;
    // The lagging process reads 1 s before the bound. With seen's cursor it must not answer Working or move the
    // cursor back: notReady and the same cursor, or nothing that regresses the agent.
    const response = await fetch(`${behindBase}/communication/agents/current?cursor=${encodeURIComponent(seen.cursor)}`,
      { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const lagging = await response.json() as Answer;
    expect({ notReady: lagging.notReady === true, cursor: lagging.cursor === seen.cursor, regressed: rowOf(lagging, fox)?.state ?? null })
      .toEqual({ notReady: true, cursor: true, regressed: null });
    // Back on the first process with the same cursor: nothing is re-sent (no duplicate work after the handoff).
    at += 1_000;
    expect((await current(token, seen.cursor)).rows).toEqual([]);
    expect(shown).toBe('offline');
  } finally {
    behind.closeAllConnections(); await new Promise<void>(resolve => behind.close(() => resolve()));
  }
});
