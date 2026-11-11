import { setCanonicalStatus } from './canonical-status-fixture.js';
// What a complete status row's state depends on besides its own document (c3; c1's CS2b review items 1-2, codex-1's
// access and clock-only findings): the project pause, the owners' access, and time itself. None of them writes the
// presence document, so a delta built only from changed documents would keep showing the old state. Contract v2.3: the
// held row is re-sent with its source rev and a newer evaluatedAt; the pause goes whole in every answer (C7); access is
// read on every answer, never from a listener (C7). Status documents are written here directly as complete CS2a
// documents (contract C3); pause, membership and profile changes go through their real records (emulator).
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { webAgentStarts } from '../src/owner/web-agent-starts.js';
import { viewRoutes } from '../src/view/routes.js';
import { configureCurrentState, currentStateStats, readCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

const T = 95_000_000;
let at = T, server: Server | undefined, base = '';
const scope = <T>(work: () => Promise<T>) => inProject(TEST_PROJECT, work);
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

type Row = { id: string; rev: string; evaluatedAt?: number; state?: string; freshUntil?: number | null; projectPause?: { revision: number } };
type Answer = { rows: Row[]; cursor: string; more: boolean; complete: boolean; pause: { revision: number } | null };
async function current(token: string, cursor?: string) {
  const response = await fetch(`${base}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return await response.json() as Answer;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<V>(read: () => Promise<V>, ok: (value: V) => boolean) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (ok(value)) return value; await sleep(50); }
  throw new Error('Not delivered in time.');
}
// A complete status document of a running worker: run group, worker group (gate 2 (a)) and agent group.
async function writeStatus(agentId: string, owner: string, worker: { lastContactAt: number; deadlineAt: number; phase?: string }) {
  await scope(() => setCanonicalStatus(agentId,{ runId: 'run-1', lastContactAt: worker.lastContactAt, phase: 'turn', phaseAt: worker.lastContactAt,
    acceptingWork: true, runEndedAt: null, runMode: 'background',
    worker: { runId: 'run-1', phase: worker.phase ?? 'working', lastContactAt: worker.lastContactAt, deadlineAt: worker.deadlineAt, projectPauseRevision: null },
    agent: { name: agentId, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' } } as never));
}
// Alice views; Bob (another member) owns the agent, so his access is a dependency of its row.
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'dep-alice@example.test' }, { name: 'Bob', email: 'dep-bob@example.test' }],
    agents: [{ person: 1, name: 'bob-fox' }] });
  await seedRuntime(TEST_PROJECT, { started: true, paused: false });
  const fox = f.agents[0]!.agentId, bob = f.personIds[1]!;
  await writeStatus(fox, bob, { lastContactAt: T, deadlineAt: T + 600_000 });
  return { fox, bob, token: await idTokenFor('dep-alice@example.test') };
}
const row = (answer: Answer, id: string) => answer.rows.find(r => r.id === id);
// A held row re-sent without a source write: the same source rev, a newer evaluatedAt (contract v2.3).
function resent(held: Answer, next: Answer, id: string) {
  const before = row(held, id)!, after = row(next, id)!;
  expect(after.rev).toBe(before.rev);
  expect(after.evaluatedAt!).toBeGreaterThan(before.evaluatedAt!);
  return after;
}

test('a project pause and its end, with no status write, reach a delta client in the next answers', async () => {
  const { fox, token } = await fixture();
  const first = await until(() => current(token), a => row(a, fox)?.state === 'working');
  expect(first.pause).toBeNull();
  at += 1_000;
  expect((await current(token, first.cursor)).rows).toEqual([]);
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 1, pauseRequest: { revision: 1, requestedAt: at } });
  // The very next answer: the pause is read per answer, so no listener lag. Every held row is re-derived.
  at += 1_000;
  const paused = await current(token, first.cursor);
  expect(paused).toMatchObject({ complete: true, pause: { revision: 1 } });
  expect(resent(first, paused, fox)).toMatchObject({ state: 'pausing', projectPause: { revision: 1 } });
  at += 1_000;
  expect((await current(token, paused.cursor)).rows).toEqual([]);  // and only once
  await seedRuntime(TEST_PROJECT, { paused: false, revision: 2, pauseRequest: undefined });
  at += 1_000;
  const resumed = await current(token, paused.cursor);
  expect(resumed.pause).toBeNull();
  expect(resent(paused, resumed, fox).state).toBe('working');
  expect(row(resumed, fox)?.projectPause).toBeUndefined();
});

test('an owner\'s membership removal, and separately a profile removal, revoke unchanged rows in the next answer', async () => {
  const { fox, bob, token } = await fixture();
  const first = await until(() => current(token), a => row(a, fox)?.state === 'working');
  const member = (await scope(() => membershipDoc(TEST_PROJECT, bob).get())).data()!;
  await scope(() => membershipDoc(TEST_PROJECT, bob).set({ ...member, status: 'removed', statusChangedAt: at, revision: member.revision + 1 }));
  at += 1_000;
  const revoked = await current(token, first.cursor);
  expect(resent(first, revoked, fox).state).toBe('revoked');
  // Restore the membership, then remove Bob's profile: the owners' profiles are watched too.
  await scope(() => membershipDoc(TEST_PROJECT, bob).set({ ...member, revision: member.revision + 2 }));
  at += 1_000;
  const back = await current(token, revoked.cursor);
  expect(row(back, fox)?.state).toBe('working');
  await profiles.doc(bob).update({ removedAt: at });
  at += 1_000;
  expect(row(await current(token, back.cursor), fox)?.state).toBe('revoked');
});

test('clock-only transitions are re-sent with their unchanged rev: contact + 90 s → Offline; a passed end time changes nothing', async () => {
  const { fox, bob, token } = await fixture();
  const first = await until(() => current(token), a => row(a, fox)?.state === 'working');
  const held = row(first, fox)!;
  // Nothing due yet: nothing re-sent.
  at = T + 30_000;
  expect((await current(token, first.cursor)).rows).toEqual([]);
  at = T + 89_000;
  const before = await current(token, first.cursor);
  expect(before.rows).toEqual([]);
  // contact + 90 s passes with no write: the worker shows Offline, re-sent once with the rev the client holds.
  at = T + 90_000;
  const offline = await current(token, before.cursor);
  expect(offline.rows).toEqual([expect.objectContaining({ id: fox, rev: held.rev, state: 'offline' })]);
  resent(first, offline, fox);
  expect((await current(token, offline.cursor)).rows).toEqual([]);
  // A fresh contact, then its end time passes with no write: still Working, nothing re-sent.
  at = T + 100_000;
  await writeStatus(fox, bob, { lastContactAt: at, deadlineAt: T + 120_000 });
  const contact = await until(() => current(token, offline.cursor), a => row(a, fox)?.state === 'working');
  at = T + 120_000;
  expect((await current(token, contact.cursor)).rows).toEqual([]);
});

test('a pause that is not confirmed turns pause_unconfirmed after 30 s with no write', async () => {
  const { fox, bob, token } = await fixture();
  // Between turns a worker confirms at once; one still in its turn stays pausing while the turn finishes.
  await writeStatus(fox, bob, { lastContactAt: T, deadlineAt: T + 600_000, phase: 'waiting' });
  await seedRuntime(TEST_PROJECT, { paused: true, revision: 1, pauseRequest: { revision: 1, requestedAt: T } });
  const first = await until(() => current(token), a => row(a, fox)?.state === 'pausing');
  at = T + 29_999;
  expect((await current(token, first.cursor)).rows).toEqual([]);
  at = T + 30_000;
  const late = await current(token, first.cursor);
  expect(late.rows).toEqual([expect.objectContaining({ id: fox, state: 'pause_unconfirmed' })]);
  await writeStatus(fox, bob, { lastContactAt: at, deadlineAt: T + 600_000 });
  await until(() => current(token, late.cursor), a => row(a, fox)?.state === 'pausing');
});

test('access and pause are read on every answer (c1, c14): one dependency read per answer, nothing cached', async () => {
  const { fox, token } = await fixture();
  let answer = await until(() => current(token), a => row(a, fox)?.state === 'working');
  const reads = currentStateStats().depsReads;
  for (let i = 0; i < 5; i++) { at += 1_000; answer = await current(token, answer.cursor); }
  expect(currentStateStats().depsReads - reads).toBe(5);
  expect(currentStateStats().rederived).toBe(0);  // a quiet project re-sends nothing
});

test('a row sent on an earlier page is brought up to now when the answer completes (c7\'s quiet-client case), and pages are pinned at T1', async () => {
  const restore = configureCurrentState({ pageSize: 1 });
  try {
    const f = await seed({ profiles: [{ name: 'Alice', email: 'dep-alice@example.test' }], agents: [{ person: 0, name: 'alice-fox' }, { person: 0, name: 'alice-owl' }] });
    await seedRuntime(TEST_PROJECT, { started: true, paused: false });
    const owner = f.personIds[0]!, [x, y] = f.agents.map(a => a.agentId).sort() as [string, string];
    const token = await idTokenFor('dep-alice@example.test');
    const write = (contact: number) => Promise.all([x, y].map(id => writeStatus(id, owner, { lastContactAt: contact, deadlineAt: T + 3_600_000 })));
    await write(T);
    // A complete first read at T (two pages of one row), then a quiet client: E = T.
    const view = new Map<string, Row>();
    const apply = (a: Answer) => { for (const r of a.rows) view.set(r.id, r); return a; };
    let a = apply(await until(() => current(token), r => r.rows.length === 1));
    while (a.more) a = apply(await current(token, a.cursor));
    expect([...view.values()].map(r => r.state)).toEqual(['working', 'working']);
    // Both agents make a new contact at T + 10 s; the client asks again only at T + 99 s.
    await write(T + 10_000);
    at = T + 99_000;
    const page1 = apply(await until(() => current(token, a.cursor), r => r.rows.length > 0));
    expect(page1).toMatchObject({ more: true, complete: false });
    expect(page1.rows).toEqual([expect.objectContaining({ id: x, state: 'working', evaluatedAt: T + 99_000 })]);
    // A process whose clock is below this answer's T1 does not serve its next page.
    at = T + 98_000;
    expect(await current(token, page1.cursor)).toMatchObject({ notReady: true, rows: [], cursor: page1.cursor });
    // Completed at T + 101 s: x (sent Working at T1) has expired since, so it is re-sent Offline, not left Working.
    at = T + 101_000;
    const page2 = apply(await current(token, page1.cursor));
    expect(page2.complete).toBe(true);
    expect(view.get(x)).toMatchObject({ state: 'offline', evaluatedAt: T + 101_000 });
    expect(view.get(y)).toMatchObject({ state: 'offline' });
    at = T + 102_000;
    expect((await current(token, page2.cursor)).rows).toEqual([]);
  } finally { restore(); }
});

// Dependencies are never older than the documents they are applied to (contract C7, c2's read-point rule): what the
// listener delivers while the dependency read is in flight waits for the next answer, never derived with an older read.
async function raceFixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'dep-alice@example.test' }, { name: 'Bob', email: 'dep-bob@example.test' }],
    agents: [{ person: 0, name: 'alice-fox' }, { person: 1, name: 'bob-owl' }, { person: 0, name: 'alice-elk' }] });
  await seedRuntime(TEST_PROJECT, { started: true, paused: false });
  const [alice, bob] = f.personIds as [string, string], [fox, owl, elk] = f.agents.map(a => a.agentId) as [string, string, string];
  const token = await idTokenFor('dep-alice@example.test');
  const restore = configureCurrentState({});
  await writeStatus(fox, alice, { lastContactAt: T, deadlineAt: T + 600_000 });
  const first = await until(() => current(token), a => row(a, fox)?.state === 'working');
  // Commit the new status AFTER the current answer has captured rows and read dependencies. It must wait
  // for the next answer, including owner access and any accompanying queued-start dependency.
  const releaseDuringNextRead = async (write: () => Promise<unknown>, during: () => Promise<unknown> = async () => {}) => {
    let released = false;
    configureCurrentState({ afterDepsRead: async () => {
      if (released) return; released = true;
      await write(); await during();
    } });
  };
  return { alice, bob, fox, owl, elk, token, first, restore, releaseDuringNextRead };
}

test('a new owner\'s agent arriving while the dependency read is in flight waits for the next answer, never Revoked (codex-1\'s race)', async () => {
  const { bob, owl, token, first, restore, releaseDuringNextRead } = await raceFixture();
  try {
    await releaseDuringNextRead(() => writeStatus(owl, bob, { lastContactAt: T, deadlineAt: T + 600_000 }));
    at = T + 1_000;
    const raced = await current(token, first.cursor);
    expect(row(raced, owl)).toBeUndefined();  // not derived with a read that did not cover its owner
    at = T + 2_000;
    expect(row(await current(token, raced.cursor), owl)?.state).toBe('working');
  } finally { restore(); }
});

test('a known owner\'s new agent and its web start, committed while the dependency read is in flight, reach the next answer as Waiting (codex-1 d878c933 race)', async () => {
  const { alice, elk, token, first, restore, releaseDuringNextRead } = await raceFixture();
  try {
    await releaseDuringNextRead(() => writeStatus(elk, alice, { lastContactAt: T, deadlineAt: T + 600_000 }),
      () => webAgentStarts.doc(`deps-race-${elk}`).set({ profileId: alice, projectId: TEST_PROJECT, agentId: elk, state: 'pending', name: elk,
        createdAt: T, pickupByAt: T + 600_000, activeUntil: T + 600_000 } as never));
    at = T + 1_000;
    const raced = await current(token, first.cursor);
    expect(row(raced, elk)?.state ?? 'absent').not.toBe('working');  // never derived with the older open-starts read
    at = T + 2_000;
    const next = await current(token, raced.cursor);
    expect(row(next, elk)?.state ?? row(raced, elk)?.state).toBe('waiting');
  } finally { restore(); }
});

test('a web start for a held agent, with no status write, makes it Waiting in the next answer and back after it ends (queued from today\'s query)', async () => {
  const { fox, bob, token } = await fixture();
  const first = await until(() => current(token), a => row(a, fox)?.state === 'working');
  // The status document's start group is not trusted yet (contract C3 0f8979cb gate): today's starts query decides.
  const start = webAgentStarts.doc(`deps-${fox}`);
  await start.set({ profileId: bob, projectId: TEST_PROJECT, agentId: fox, state: 'pending', name: fox, createdAt: T,
    pickupByAt: T + 600_000, activeUntil: T + 600_000 } as never);
  at += 1_000;
  const waiting = await current(token, first.cursor);
  expect(resent(first, waiting, fox).state).toBe('waiting');
  await start.update({ state: 'cancelled' });
  at += 1_000;
  expect(resent(waiting, await current(token, waiting.cursor), fox).state).toBe('working');
});

// Card v19 (no fallback): the old answer to more open starts than one read covered was the status feed. Every open start
// is now read, however many, so queued is never partial and never handed to the old path (c2's original concern).
test('more open web starts than the former 500 page: every one is read and the agent shows Waiting, never a partial queued set', async () => {
  const { fox, bob, token } = await fixture();
  const first = await until(() => current(token), a => row(a, fox)?.state === 'working');
  for (let chunk = 0; chunk < 3; chunk++) {
    const batch = webAgentStarts.firestore.batch();
    for (let i = 0; i < 200; i++) batch.set(webAgentStarts.doc(`deps-many-${chunk}-${i}`), { profileId: bob, projectId: TEST_PROJECT,
      agentId: `other-${chunk}-${i}`, state: 'pending', name: 'other', createdAt: T, pickupByAt: T + 600_000, activeUntil: T + 600_000 } as never);
    await batch.commit();
  }
  // fox's own start sorts after all 600 others by id, past where the former limit stopped reading.
  await webAgentStarts.doc('deps-zz-last').set({ profileId: bob, projectId: TEST_PROJECT, agentId: fox, state: 'pending', name: fox,
    createdAt: T, pickupByAt: T + 600_000, activeUntil: T + 600_000 } as never);
  at += 1_000;
  const next = await current(token, first.cursor);
  expect(next).not.toHaveProperty('fallback');
  expect(resent(first, next, fox).state).toBe('waiting');
});

test('a cursor names its project: another project refuses it as bad input, never serving a falsely complete answer (codex-3)', async () => {
  const { fox, bob } = await fixture();
  const other = 'b'.repeat(64);
  // Project B has an agent whose status was written before project A's cursor was issued.
  await inProject(other, () => setCanonicalStatus('b-agent',{ runId: 'r', lastContactAt: T, phase: 'turn', phaseAt: T, acceptingWork: true,
    runEndedAt: null, runMode: 'background',
    agent: { name: 'b-agent', ownerProfileId: bob, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' } } as never));
  let fromA = await scope(() => readCurrentState(bob, false, undefined, T));
  for (let i = 0; i < 100 && !row(fromA as never, fox); i++) { await new Promise(r => setTimeout(r, 20)); fromA = await scope(() => readCurrentState(bob, false, undefined, T)); }
  expect(fromA.complete).toBe(true);
  await expect(inProject(other, () => readCurrentState(bob, false, fromA.cursor, T + 1))).rejects.toMatchObject({ code: 'bad_input' });
  // B's own first read lists its agent.
  let fromB = await inProject(other, () => readCurrentState(bob, false, undefined, T + 1));
  for (let i = 0; i < 100 && !fromB.rows.some(r => r.id === 'b-agent'); i++) {
    await new Promise(r => setTimeout(r, 20)); fromB = await inProject(other, () => readCurrentState(bob, false, undefined, T + 1));
  }
  expect(fromB.rows.map(r => r.id)).toEqual(['b-agent']);
  // And B's cursor works at B.
  expect((await inProject(other, () => readCurrentState(bob, false, fromB.cursor, T + 2))).rows).toEqual([]);
});
