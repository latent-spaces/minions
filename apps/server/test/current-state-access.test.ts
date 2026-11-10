import { setCanonicalStatus, updateCanonicalStatus } from './canonical-status-fixture.js';
// CS2b permissions (c14, failing first): access is part of every row's state, not only of the rows whose status document
// changed. An owner's membership or connection epoch lives outside presence/{agentId}, so revoking it writes no status
// document; the next answer that covers the revocation must still show that owner's agents as Revoked, from either
// process. A person who is no longer a member gets no rows at all. Same harness as current-state-endpoint.test.ts.
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { membershipDoc, membershipFenceDoc, membershipsOf } from '../src/projects/access.js';
import { viewRoutes } from '../src/view/routes.js';
import { stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let at = 90_000_000, servers: Server[] = [], bases: string[] = [];
const scope = <T>(work: () => Promise<T>) => inProject(TEST_PROJECT, work);
beforeEach(async () => {
  stopCurrentState();
  await resetEmulator(); at += 1_000_000;
  for (let i = 0; i < 2; i++) {
    const app = express(); app.use(scoped(viewRoutes(() => at)));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    servers.push(server); bases.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }
});
afterEach(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  servers = []; bases = [];
});
afterAll(() => stopCurrentState());

type Row = { id: string; rev: string; state?: string; focus?: { text: string } | null; removed?: true };
type Answer = { rows: Row[]; cursor: string; more: boolean; reset: boolean; watermark: string };
async function current(token: string, cursor?: string, process = 0) {
  const response = await fetch(`${bases[process]}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, data: await response.json() as Answer };
}
async function writeStatus(agentId: string, owner: string, fields: Record<string, unknown> = {}) {
  await scope(() => setCanonicalStatus(agentId,{ runId: 'run-1', lastContactAt: at, phase: 'turn', phaseAt: at, acceptingWork: true,
    runEndedAt: null, runMode: 'background',
    agent: { name: agentId, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' }, ...fields } as never, { merge: true }));
}
async function until(read: () => Promise<{ data: Answer }>, ok: (a: Answer) => boolean) {
  for (let i = 0; i < 100; i++) { const r = await read(); if (ok(r.data)) return r.data; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('The listener did not deliver in time.');
}
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'cs-acl-alice@example.test' }, { name: 'Bob', email: 'cs-acl-bob@example.test' }],
    agents: [{ person: 0, name: 'alice-fox' }, { person: 1, name: 'bob-owl' }] });
  const [aliceAgent, bobAgent] = f.agents.map(a => a.agentId) as [string, string];
  await writeStatus(aliceAgent, f.personIds[0]!); await writeStatus(bobAgent, f.personIds[1]!);
  const alice = await idTokenFor('cs-acl-alice@example.test'), bob = await idTokenFor('cs-acl-bob@example.test');
  const first = await until(() => current(alice), a => a.rows.length === 2);
  expect(first.rows.map(r => r.state)).toEqual(['working', 'working']);
  return { bobId: f.personIds[1]!, aliceAgent, bobAgent, alice, bob, first };
}
// Both membership records, as a removal writes them (store.ts, account-cleanup.ts); no status document is touched.
async function removeMember(profileId: string) {
  await scope(async () => {
    await membershipDoc(TEST_PROJECT, profileId).update({ status: 'removed', statusChangedAt: at, revision: 2, updatedAt: at });
    await membershipsOf(profileId).doc(TEST_PROJECT).update({ status: 'removed', statusChangedAt: at, revision: 2, updatedAt: at });
  });
}
// A later commit on another agent's status document moves the listener's W past the revocation, so an answer that
// shows this marker covers the revocation's commit time (cursor = max(since, W)).
async function afterMarker(token: string, cursor: string, agentId: string, process: number) {
  await scope(() => updateCanonicalStatus(agentId,{ 'agent.focus': { text: `marker-${process}`, updatedAt: at } }));
  return until(() => current(token, cursor, process), a => a.rows.some(r => r.id === agentId && r.focus?.text === `marker-${process}`));
}

test('a removed member\'s agents turn Revoked in the next delta, with no status write, from either process', async () => {
  const { bobId, aliceAgent, bobAgent, alice, first } = await fixture();
  await removeMember(bobId);
  for (const process of [0, 1]) {
    const next = await afterMarker(alice, first.cursor, aliceAgent, process);
    expect(next.rows.find(r => r.id === bobAgent)?.state, `process ${process}`).toBe('revoked');
  }
});

test('a connection-epoch fence ahead of the agent\'s epoch turns it Revoked in the next delta, with no status write', async () => {
  const { bobId, aliceAgent, bobAgent, alice, first } = await fixture();
  // Bob left and rejoined: his membership is active again but at epoch 1; bob-owl was connected under epoch 0.
  await scope(() => membershipFenceDoc(TEST_PROJECT, bobId).set({ profileId: bobId, projectId: TEST_PROJECT, epoch: 1 }));
  const next = await afterMarker(alice, first.cursor, aliceAgent, 1);
  expect(next.rows.find(r => r.id === bobAgent)?.state).toBe('revoked');
});

test('control: a fresh snapshot after the same removal already shows the agent Revoked', async () => {
  const { bobId, bobAgent, alice } = await fixture();
  await removeMember(bobId);
  for (const process of [0, 1]) {
    const snapshot = (await current(alice, undefined, process)).data;
    expect(snapshot.rows.find(r => r.id === bobAgent)?.state, `process ${process}`).toBe('revoked');
  }
});

test('a person who is no longer a member gets no rows, with or without a cursor, from either process', async () => {
  const { bobId, bob, first } = await fixture();
  const own = await until(() => current(bob), a => a.rows.length === 2);
  await removeMember(bobId);
  for (const process of [0, 1]) for (const cursor of [undefined, own.cursor, first.cursor]) {
    const answer = await current(bob, cursor, process);
    expect(answer.status, `process ${process} cursor ${cursor ?? 'none'}`).toBe(404);
    expect(answer.data.rows).toBeUndefined();
  }
});

// Contract v2.3 item 4, option (a) (c1, c14): owners' access is read with the authority's code on every answer, so a
// revocation reaches the next answer even while the status-document listener delivers nothing (a stall still inside its
// trusted window). Pins that row revocation display never rests on a listener's health.
test('a revocation shows in the next proved answer with no status write', async () => {
  const { bobId, bobAgent, alice, first } = await fixture();
  await removeMember(bobId);
  const next = (await current(alice, first.cursor)).data;
  expect(next.rows.find(r => r.id === bobAgent)?.state).toBe('revoked');
  await scope(() => membershipFenceDoc(TEST_PROJECT, bobId).set({ profileId: bobId, projectId: TEST_PROJECT, epoch: 2 }));
  const later = (await current(alice, next.cursor)).data;
  expect(later.rows.filter(r => r.id === bobAgent && r.state !== 'revoked')).toEqual([]);
});
