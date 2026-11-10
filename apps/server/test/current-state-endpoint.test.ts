import { setCanonicalStatus, updateCanonicalStatus } from './canonical-status-fixture.js';
// CS2b end to end on the emulator: one presence listener per project per process, a snapshot then changes since a
// cursor, served by either of two processes. The status documents' field groups are written here directly, as the
// CS2a writers will write them (current-state contract C3).
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { agents, inProject } from '../src/firestore.js';
import { humanRequests } from '../src/projects/human-requests.js';
import { viewRoutes } from '../src/view/routes.js';
import { currentStateStats, stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let at = 80_000_000, servers: Server[] = [], bases: string[] = [];
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

type Row = { id: string; rev: string; state?: string; mine?: boolean; focus?: { text: string } | null; removed?: true };
type Answer = { rows: Row[]; cursor: string; more: boolean; notReady: boolean; watermark: string; needsYou: string[] };
async function current(token: string, cursor?: string, process = 0) {
  const response = await fetch(`${bases[process]}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, data: await response.json() as Answer };
}
// Status documents as CS2a will write them: the run group at the top level, the agent group nested.
async function writeStatus(agentId: string, owner: string, fields: Record<string, unknown> = {}) {
  await scope(() => setCanonicalStatus(agentId,{ runId: 'run-1', lastContactAt: at, phase: 'turn', phaseAt: at, acceptingWork: true,
    runEndedAt: null, runMode: 'background',
    agent: { name: agentId, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' }, ...fields } as never, { merge: true }));
}
// Listeners deliver asynchronously: poll (real time) until the answer shows what the test expects.
async function until(read: () => Promise<{ data: Answer }>, ok: (a: Answer) => boolean) {
  for (let i = 0; i < 100; i++) { const r = await read(); if (ok(r.data)) return r.data; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('The listener did not deliver in time.');
}
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'cs2b-alice@example.test' }, { name: 'Bob', email: 'cs2b-bob@example.test' }],
    agents: [{ person: 0, name: 'alice-fox' }, { person: 1, name: 'bob-owl' }] });
  const [aliceAgent, bobAgent] = f.agents.map(a => a.agentId) as [string, string];
  await writeStatus(aliceAgent, f.personIds[0]!); await writeStatus(bobAgent, f.personIds[1]!);
  return { f, aliceAgent, bobAgent, alice: await idTokenFor('cs2b-alice@example.test'), bob: await idTokenFor('cs2b-bob@example.test') };
}

test('a snapshot, then only the agent that changed, from either process; mine is per viewer', async () => {
  const { aliceAgent, bobAgent, alice, bob } = await fixture();
  const first = await until(() => current(alice), a => a.rows.length === 2);
  expect(first.rows.map(r => [r.id, r.state, r.mine]).sort()).toEqual([[aliceAgent, 'working', true], [bobAgent, 'working', false]].sort());
  expect((await current(bob, undefined, 1)).data.rows.find(r => r.id === aliceAgent)?.mine).toBe(false);
  // A focus change on Alice's agent: the next answer, from the other process, carries only that agent.
  await scope(() => updateCanonicalStatus(aliceAgent,{ 'agent.focus': { text: 'Shipping CS2b', updatedAt: at } }));
  const next = await until(() => current(alice, first.cursor, 1), a => a.rows.length > 0);
  expect(next.rows.map(r => [r.id, r.focus?.text])).toEqual([[aliceAgent, 'Shipping CS2b']]);
  // Nothing new: an empty answer that keeps the cursor.
  const quiet = await current(alice, next.cursor, 0);
  expect(quiet.data.rows).toEqual([]);
  expect(quiet.data.cursor >= next.cursor || quiet.data.cursor === next.cursor).toBe(true);
  expect(currentStateStats().cachedProjects).toBe(1);  // one listener per project per process (both routers share this test process)
});

test('revocation is a field: the agent arrives revoked, never silently disappears', async () => {
  const { bobAgent, alice } = await fixture();
  const first = await until(() => current(alice), a => a.rows.length === 2);
  await scope(() => updateCanonicalStatus(bobAgent,{ 'agent.revokedAt': at }));
  const next = await until(() => current(alice, first.cursor), a => a.rows.length > 0);
  expect(next.rows).toMatchObject([{ id: bobAgent, state: 'revoked' }]);
});

test('an incomplete historical status without an identity group is removed from canonical current state', async () => {
  const { f, alice } = await fixture();
  const third = 'carol-cat';
  await scope(() => agents().doc(third).set({ ownerProfileId: f.personIds[0], connectionEpoch: 0, name: third, tokenHash: 'x', tokenIssuedAt: 1, createdAt: 1, revokedAt: null } as never));
  await scope(() => setCanonicalStatus(third,{ runId: 'r', lastContactAt: at, phase: 'idle', phaseAt: at } as never));
  const answer = await until(() => current(alice), a => a.rows.length === 3);
  // No historical agent/run assembly is performed; the canonical row is unavailable.
  expect(answer.rows.find(r => r.id === third)).toMatchObject({ id: third, removed: true });
});

test('Needs you is the viewer\'s own and never in the shared rows; there is no switch: the read always answers (card v19)', async () => {
  const { f, aliceAgent, alice, bob } = await fixture();
  await humanRequests.doc('need-cs2b').set({ projectId: TEST_PROJECT, agentId: aliceAgent, assigneeProfileId: f.personIds[0],
    visibility: 'private', status: 'open', createdAt: at } as never);
  const a = await until(() => current(alice), x => x.rows.length === 2);
  expect(a.needsYou).toEqual([aliceAgent]);
  expect(a.rows.every(r => r.state !== 'needs_you')).toBe(true);
  expect((await current(bob)).data.needsYou).toEqual([]);
  // The retired kill switch has no effect: setting the old variable still serves the endpoint (no 404 to the feed).
  process.env.MLSWARM_CURRENT_STATE_ENABLED = 'false';
  try { expect((await current(alice)).status).toBe(200); } finally { delete process.env.MLSWARM_CURRENT_STATE_ENABLED; }
});

test('a malformed cursor or extra query is refused', async () => {
  const { alice } = await fixture();
  await until(() => current(alice), a => a.rows.length === 2);
  expect((await current(alice, 'not-a-cursor')).status).toBe(400);
  const extra = await fetch(`${bases[0]}/communication/agents/current?since=1`, { headers: { authorization: `Bearer ${alice}` } });
  expect(extra.status).toBe(400);
});
