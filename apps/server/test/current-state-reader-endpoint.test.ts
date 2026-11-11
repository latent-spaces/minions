import { setCanonicalStatus } from './canonical-status-fixture.js';
// c12: the client reader (apps/web/src/ui/communication-map/current-state-reader.ts) driven by the actual dark endpoint
// (current-state.ts, contract v2.3) on the Firestore emulator, polled the way a client polls: each answer is applied to
// the cursor it was sent with, and every earlier response is replayed late. Status documents are written directly as
// complete CS2a documents (contract C3), as in current-state-dependencies.test.ts; pause and membership changes go
// through their real records.
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { viewRoutes } from '../src/view/routes.js';
import { configureCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, seedRuntime, TEST_PROJECT } from './helpers.js';
import { applyCurrentState, createReader, currentStateRows, restartReader, type CurrentStateAnswer, type CurrentStateReader }
  from '../../web/src/ui/communication-map/current-state-reader.js';

type Agent = { state: string; projectPause?: { revision: number } };
type Reader = CurrentStateReader<Agent>;
type Answer = CurrentStateAnswer<Agent>;
const T = 95_000_000;
let at = T, server: Server | undefined, base = '';
const scope = <V>(work: () => Promise<V>) => inProject(TEST_PROJECT, work);
beforeEach(async () => {
  stopCurrentState();
  await resetEmulator(); at = T;
  const app = express(); app.use(scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  stopCurrentState();
  server?.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve()));
});

async function fetchAnswer(token: string, cursor: string | null) {
  const response = await fetch(`${base}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return await response.json() as Answer;
}
// One poll, as a client makes it: the reader's own cursor, the answer applied to the cursor it was sent with.
const log: { sent: string | null; answer: Answer }[] = [];
async function poll(reader: Reader, token: string) {
  const sent = reader.cursor, answer = await fetchAnswer(token, sent);
  log.push({ sent, answer });
  return applyCurrentState(reader, sent, answer);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function pollUntil(reader: Reader, token: string, ok: (r: Reader) => boolean) {
  for (let i = 0; i < 100; i++) { reader = await poll(reader, token); if (ok(reader)) return reader; await sleep(50); }
  throw new Error('Not delivered in time.');
}
const state = (reader: Reader, id: string) => currentStateRows(reader).find(r => r.id === id)?.state;
// Every earlier response delivered again, late: none may change what the reader holds.
function replayAll(reader: Reader) {
  for (const { sent, answer } of log) expect(applyCurrentState(reader, sent, answer)).toBe(reader);
}

async function writeStatus(agentId: string, owner: string, lastContactAt: number, deadlineAt: number) {
  await scope(() => setCanonicalStatus(agentId,{ runId: 'run-1', lastContactAt, phase: 'turn', phaseAt: lastContactAt,
    acceptingWork: true, runEndedAt: null, runMode: 'background',
    worker: { runId: 'run-1', phase: 'working', lastContactAt, deadlineAt, projectPauseRevision: null },
    agent: { name: agentId, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' } } as never));
}
async function fixture() {
  log.length = 0;
  const f = await seed({ profiles: [{ name: 'Alice', email: 'c12-alice@example.test' }, { name: 'Bob', email: 'c12-bob@example.test' }],
    agents: [{ person: 1, name: 'bob-fox' }, { person: 1, name: 'bob-owl' }] });
  await seedRuntime(TEST_PROJECT, { started: true, paused: false });
  const [fox, owl] = f.agents.map(a => a.agentId) as [string, string], bob = f.personIds[1]!;
  await writeStatus(fox, bob, T, T + 600_000);
  await writeStatus(owl, bob, T, T + 600_000);
  return { fox, owl, bob, token: await idTokenFor('c12-alice@example.test') };
}

test('pause, resume, revocation and Offline reach the reader, held rows never regress under replayed answers', async () => {
  const { fox, owl, bob, token } = await fixture();
  let reader = await pollUntil(createReader<Agent>(), token, r => r.complete && state(r, fox) === 'working' && state(r, owl) === 'working');
  expect(reader.pause).toBeNull();
  // Pause with no status write: re-sent rows at the same rev with a later evaluatedAt; the pause arrives whole.
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 1, pauseRequest: { revision: 1, requestedAt: at } });
  at += 1_000;
  reader = await poll(reader, token);
  expect(reader.complete).toBe(true);
  expect(reader.pause).toMatchObject({ revision: 1 });
  expect([state(reader, fox), state(reader, owl)]).toEqual(['pausing', 'pausing']);
  replayAll(reader);
  // Resume.
  await seedRuntime(TEST_PROJECT, { paused: false, revision: 2, pauseRequest: undefined });
  at += 1_000;
  reader = await poll(reader, token);
  expect(reader.pause).toBeNull();
  expect([state(reader, fox), state(reader, owl)]).toEqual(['working', 'working']);
  replayAll(reader);
  // The owner's membership removal: both rows revoked in the next answer, with no presence write.
  const member = (await scope(() => membershipDoc(TEST_PROJECT, bob).get())).data()!;
  await scope(() => membershipDoc(TEST_PROJECT, bob).set({ ...member, status: 'removed', statusChangedAt: at, revision: member.revision + 1 }));
  at += 1_000;
  reader = await poll(reader, token);
  expect([state(reader, fox), state(reader, owl)]).toEqual(['revoked', 'revoked']);
  replayAll(reader);
  await scope(() => membershipDoc(TEST_PROJECT, bob).set({ ...member, revision: member.revision + 2 }));
  at += 1_000;
  reader = await poll(reader, token);
  expect([state(reader, fox), state(reader, owl)]).toEqual(['working', 'working']);
  // contact + 90 s with no write: Offline, re-sent once.
  at = T + 90_000;
  reader = await poll(reader, token);
  expect([state(reader, fox), state(reader, owl)]).toEqual(['offline', 'offline']);
  replayAll(reader);
  // A fresh contact for fox only: a source write, a greater rev.
  at = T + 100_000;
  await writeStatus(fox, bob, at, T + 600_000);
  reader = await pollUntil(reader, token, r => state(r, fox) === 'working');
  expect(state(reader, owl)).toBe('offline');
  replayAll(reader);
});

test('a process whose clock is behind the last answer\'s E answers notReady; the reader keeps its rows and cursor', async () => {
  const { fox, token } = await fixture();
  let reader = await pollUntil(createReader<Agent>(), token, r => r.complete && state(r, fox) === 'working');
  at = T + 90_000;
  reader = await poll(reader, token);
  expect(state(reader, fox)).toBe('offline');
  const cursor = reader.cursor;
  // The same client reaches a process 2 s behind: it must not answer from an earlier evaluation (Online again).
  at = T + 88_000;
  const behind = await poll(reader, token);
  expect(log.at(-1)!.answer.notReady).toBe(true);
  expect(behind.notReady).toBe(true);
  expect(behind.cursor).toBe(cursor);
  expect(state(behind, fox)).toBe('offline');
  // Back on time: the next answer continues from the same cursor.
  at = T + 91_000;
  reader = await poll(behind, token);
  expect(reader.notReady).toBe(false);
  expect(state(reader, fox)).toBe('offline');
});

test('paged answers (page size 2, five agents): writes and a pause between pages, a reconnect keeps every agent on screen', async () => {
  const restore = configureCurrentState({ pageSize: 2 });
  try {
    log.length = 0;
    const f = await seed({ profiles: [{ name: 'Alice', email: 'c12-page-alice@example.test' }, { name: 'Bob', email: 'c12-page-bob@example.test' }],
      agents: [0, 1, 2, 3, 4].map(n => ({ person: 1, name: `bob-${n}` })) });
    await seedRuntime(TEST_PROJECT, { started: true, paused: false });
    const ids = f.agents.map(a => a.agentId), bob = f.personIds[1]!, token = await idTokenFor('c12-page-alice@example.test');
    for (const id of ids) await writeStatus(id, bob, T, T + 600_000);
    const all = (r: Reader, s: string) => ids.every(id => state(r, id) === s);
    let reader = await pollUntil(createReader<Agent>(), token, r => r.complete && all(r, 'working'));
    // A paged first read after a reconnect: the old rows stay until it completes; a write and a pause land mid-read.
    reader = restartReader(reader);
    let pages = 0;
    reader = await poll(reader, token); pages++;
    expect(reader.complete).toBe(false);
    expect(currentStateRows(reader)).toHaveLength(5);
    at += 1_000;
    await writeStatus(ids[4]!, bob, at, T + 600_000);
    await seedRuntime(TEST_PROJECT, { paused: true, revision: 1, pauseRequest: { revision: 1, requestedAt: at } });
    while (!reader.complete && pages < 20) {
      reader = await poll(reader, token); pages++;
      expect(currentStateRows(reader)).toHaveLength(5);
    }
    expect(reader.complete).toBe(true);
    expect(pages).toBeLessThanOrEqual(4);
    // The next answers bring every agent to the paused state and the pause itself, whatever page each row was on.
    at += 1_000;
    reader = await pollUntil(reader, token, r => r.complete && r.pause !== null && all(r, 'pausing'));
    expect(reader.pause).toMatchObject({ revision: 1 });
    replayAll(reader);
  } finally { restore(); }
});
