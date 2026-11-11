// Steady-state unit work of a connected session, model-free, on the disposable emulator. Counts the Firestore
// document reads and writes each runner request performs, and the process-local limiter keys a session holds, so
// capacity estimates can use counted work instead of assumed reads per request. Reads follow Firestore's billing
// rules as the SDK sees them: a document get is one read, missing or not; a query is max(1, results); a count is
// one read per 1,000 entries, at least one. Not seen: listener snapshots, index entries, retries below the SDK.
// The emulator proves counts only, never latency or throughput.
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { v2Routes } from '../src/v2/routes.js';
import { startRun } from '../src/v2/runs.js';
import { requestLimits } from '../src/request-state.js';
import { resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';
import { FirestorePrototype, QueryPrototype, TransactionPrototype, aggregatePrototype, countStoreWrites } from './store-prototypes.js';

const counted = { reads: 0, writes: 0 };
const readsOf = (result: unknown): number => {
  if (Array.isArray(result)) return result.length;
  const value = result as { size?: number; data?: () => { count?: unknown } };
  if (typeof value?.size === 'number') return Math.max(1, value.size);
  const count = typeof value?.data === 'function' ? value.data()?.count : undefined;
  return typeof count === 'number' ? Math.max(1, Math.ceil(count / 1000)) : 1;
};
function wrap(proto: object, name: string, count: (result: unknown) => void) {
  const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name];
  Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (result instanceof Promise) return result.then(value => { count(value); return value; });
    count(result);
    return result;
  } });
}
const read = (value: unknown) => { counted.reads += readsOf(value); };
const write = () => { counted.writes++; };
// Each public entry point is counted once: DocumentReference.get goes through Firestore.getAll; transaction reads
// do not re-enter these methods; transaction and direct document writes are staged on a WriteBatch.
wrap(FirestorePrototype, 'getAll', read);
wrap(TransactionPrototype, 'get', read);
wrap(TransactionPrototype, 'getAll', read);
wrap(QueryPrototype, 'get', read);
wrap(aggregatePrototype(), 'get', read);
countStoreWrites(write);

let server: Server, base: string, clock = Date.now();
const now = () => clock;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(scoped(v2Routes(now)));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);

// Background work a request starts (the lapsed-fanout check) is attributed to that request.
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
async function measured(path: string, token: string, body: object) {
  await settle(); counted.reads = 0; counted.writes = 0;
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  await settle();
  return { status: response.status, json, reads: counted.reads, writes: counted.writes };
}

async function connected(count: number) {
  const f = await seed({ profiles: [{ name: 'Unit person', email: 'unit-work@example.test' }],
    agents: Array.from({ length: count }, (_, i) => ({ person: 0, name: `Unit worker ${i}` })) });
  return Promise.all(f.agents.map(async agent => {
    const run = await inProject(TEST_PROJECT, () => startRun(agent.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
    // The body the connector's 20 s sync sends for one mission.
    const session = { run_id: run.run_id, missionId: randomUUID(), generation: 1, startedAt: clock, deadlineAt: clock + 3 * 3_600_000, remainingSlots: 0, phase: 'waiting' };
    return { token: agent.token, agentId: agent.agentId, runId: run.run_id, session };
  }));
}
const cycle = (s: Awaited<ReturnType<typeof connected>>[number]) => [
  ['/wait', { run_id: s.runId, report: { phase: 'idle', accepting_work: true } }],
  ['/worker-session', s.session],
  // First reply (no after_revision) answers at once with the same run checks as a held renewal.
  ['/project-control', { run_id: s.runId }],
] as const;

test('a connected session holds three limiter keys per process, including v2-tools for its session sync', async () => {
  const sessions = await connected(4);
  const before = requestLimits.stats();
  clock += 21_000;
  for (const s of sessions) for (const [path, body] of cycle(s)) expect((await measured(path, s.token, body)).status).toBe(200);
  const after = requestLimits.stats();
  // /wait -> v2-wait, /project-control -> v2-control, /worker-session -> v2-tools (v2/routes.ts), idle or busy.
  // A process that sees C sessions therefore holds 3·C keys, not 2·C + busy: 20,000 keys admit ~6,666 sessions.
  expect(after.keys - before.keys).toBe(3 * sessions.length);
  expect(after.namespaces - before.namespaces).toBe(3);
  expect(after.largestNamespaceKeys).toBe(sessions.length);
  expect(after.refusedNewKeys).toBe(before.refusedNewKeys);
});

// Counted at the integration baseline. Lower is fine; a rise means more work per connected session.
const BUDGET = { '/wait': 27, '/worker-session': 25, '/project-control': 26 } as const;
test('steady-state reads and writes per runner request, cold and with shared project caches warm', async () => {
  const [first, second] = await connected(2);
  const table: Record<string, { coldReads: number; warmReads: number; writes: number }> = {};
  // Means over six rounds (126 s): /wait writes the contact record only when 60 s have passed since the last one
  // (contactWriteSeconds), so one /wait in three pays for it, at the connector's 20 s cadence.
  const sums: Record<string, { cold: number; warm: number; writes: number }> = {};
  const ROUNDS = 6;
  for (let round = 0; round < ROUNDS; round++) {
    // Past every 5 s project cache and the 10 s wait window: the first session sees cold caches, as in a small project.
    clock += 21_000;
    for (let step = 0; step < 3; step++) {
      const [path, coldBody] = cycle(first)[step], warmBody = cycle(second)[step][1];
      const cold = await measured(path, first.token, coldBody);
      const warm = await measured(path, second.token, warmBody);
      expect([cold.status, warm.status]).toEqual([200, 200]);
      expect(cold.reads).toBeLessThanOrEqual(BUDGET[path]);
      expect(warm.reads).toBeLessThanOrEqual(cold.reads);
      const sum = sums[path] ??= { cold: 0, warm: 0, writes: 0 };
      sum.cold += cold.reads; sum.warm += warm.reads; sum.writes += warm.writes;
    }
  }
  for (const [path, sum] of Object.entries(sums)) table[path] = { coldReads: +(sum.cold / ROUNDS).toFixed(2), warmReads: +(sum.warm / ROUNDS).toFixed(2), writes: +(sum.writes / ROUNDS).toFixed(2) };
  // Every request authenticates (agentByToken: token query + a read-only transaction over agent, computer and
  // operator documents), so no steady-state request is cheap. Per connected session per second, today's cadence:
  // wait and session every 20 s, a project-control renewal every 25 s (after C4-1).
  const perSession = (kind: 'coldReads' | 'warmReads') => table['/wait'][kind] / 20 + table['/worker-session'][kind] / 20 + table['/project-control'][kind] / 25;
  console.info(JSON.stringify({ table, readsPerSessionSecond: { cold: +perSession('coldReads').toFixed(2), warm: +perSession('warmReads').toFixed(2) },
    writesPerSessionSecond: +(table['/wait'].writes / 20 + table['/worker-session'].writes / 20).toFixed(2) }));
  // The forecast workbook assumes 8 reads per combined 20 s heartbeat and 12 per binding renewal every 25 s
  // (Drivers rows 55-56): at most 0.88 reads/s per session. Counted work today is several times that.
  expect(perSession('warmReads')).toBeGreaterThan(8 / 20 + 12 / 25);
});

test('where the reads go: authentication and the run check each request repeats', async () => {
  const [s] = await connected(1);
  const { agentByToken } = await import('../src/store/profiles.js');
  const { assertCurrentRun } = await import('../src/v2/runs.js');
  counted.reads = 0;
  const agent = await inProject(TEST_PROJECT, () => agentByToken(s.token));
  const auth = counted.reads;
  counted.reads = 0;
  await inProject(TEST_PROJECT, () => assertCurrentRun(agent!.id, s.runId, now));
  const runCheck = counted.reads;
  console.info(JSON.stringify({ authReads: auth, runCheckReads: runCheck }));
  // Fixture operator is the project owner; a member operator adds its membership and fence reads.
  expect(auth).toBeGreaterThanOrEqual(4);
  expect(runCheck).toBeGreaterThanOrEqual(1);
});

// The workbook assumes 20 reads per viewer read every 10 s (Drivers rows 53, 60). A visible tab polls several routes
// and the directory pages and the map's status sweep cost reads per listed agent.
test('viewer reads per polled request, and per agent row on the directory and status routes', async () => {
  const { viewRoutes } = await import('../src/view/routes.js');
  const { idTokenFor } = await import('./helpers.js');
  const app = express(); app.use(scoped(viewRoutes(now)));
  const viewer = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => viewer.once('listening', resolve));
  const root = `http://127.0.0.1:${(viewer.address() as { port: number }).port}`;
  try {
    // Connected agents with canonical run and worker observations, as a live map shows them.
    const viewed = await connected(20);
    for (const v of viewed) expect((await fetch(`${base}/worker-session`, { method: 'POST', body: JSON.stringify(v.session),
      headers: { authorization: `Bearer ${v.token}`, 'content-type': 'application/json' } })).status).toBe(200);
    const token = await idTokenFor('unit-work@example.test');
    const ids = (n: number) => viewed.slice(0, n).map(a => a.agentId).join(',');
    const reads = async (path: () => string) => {
      // Past every view cache (overview and usage 10 s, live frame 5 s, traffic 10 s) and the 60/min viewer window.
      clock += 61_000;
      await settle(); counted.reads = 0;
      const response = await fetch(root + path(), { headers: { authorization: `Bearer ${token}` } });
      await response.json(); await settle();
      expect(response.status, path()).toBe(200);
      return counted.reads;
    };
    const table = {
      overview: await reads(() => '/overview'), usage: await reads(() => '/usage'), members: await reads(() => '/members'),
      frame: await reads(() => '/communication?range=recent'), traffic: await reads(() => `/communication/traffic?at=${clock}`),
      roster: await reads(() => '/communication/roster'), agentsPage20: await reads(() => '/agents'),
      agentIds10: await reads(() => `/agents?ids=${ids(10)}`), agentIds20: await reads(() => `/agents?ids=${ids(20)}`),
      status10: await reads(() => `/communication/agents?ids=${ids(10)}`), status20: await reads(() => `/communication/agents?ids=${ids(20)}`),
    };
    // A second request inside the shared windows (V1 frame 5 s, traffic and overview/usage 10 s): what sharing saves.
    const warm = async (path: () => string) => {
      clock += 61_000;
      await fetch(root + path(), { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
      clock += 1_000;
      await settle(); counted.reads = 0;
      const response = await fetch(root + path(), { headers: { authorization: `Bearer ${token}` } });
      await response.json(); await settle();
      expect(response.status, path()).toBe(200);
      return counted.reads;
    };
    const repeat = { overview: await warm(() => '/overview'), usage: await warm(() => '/usage'), frame: await warm(() => '/communication?range=recent'),
      status20: await warm(() => `/communication/agents?ids=${ids(20)}`), agentsPage20: await warm(() => '/agents') };
    console.info(JSON.stringify({ viewerReadsWarmRepeat: repeat }));
    // Shared reads cost no more than cold ones; the per-agent routes are not shared.
    for (const key of ['overview', 'usage', 'frame'] as const) expect(repeat[key]).toBeLessThanOrEqual(table[key]);
    const perRow = { agents: (table.agentIds20 - table.agentIds10) / 10, status: (table.status20 - table.status10) / 10 };
    console.info(JSON.stringify({ viewerReads: table, readsPerAgentRow: perRow }));
    // Directory identity checks still scale per agent. Selected-id status reads use canonical heads
    // and current owner authority, without legacy run/pointer/session assembly.
    expect(perRow.agents).toBeGreaterThan(3);
    expect(perRow.status).toBeGreaterThanOrEqual(2);
    expect(perRow.status).toBeLessThanOrEqual(2.5);
    expect(table.agentsPage20).toBeGreaterThan(20 * 3);
  } finally { viewer.closeAllConnections(); await new Promise<void>(resolve => viewer.close(() => resolve())); }
}, 60_000);

// Busy-session work the workbook prices separately (Drivers rows 58-59, 61, 64): reads per tool call (12), per usage
// report (8) and per inbox delivery (6), and delivery writes per recipient (4).
async function mcp(token: string, runId: string, name: string, args: object) {
  await settle(); counted.reads = 0; counted.writes = 0;
  const response = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-pilot-run': runId } });
  const text = await response.text();
  const data = text.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? text;
  const result = JSON.parse(data).result;
  await settle();
  expect(response.status, name).toBe(200);
  expect(result?.isError ?? false, `${name}: ${result?.content?.[0]?.text}`).toBe(false);
  return { reads: counted.reads, writes: counted.writes, value: JSON.parse(result.content[0].text) };
}

test('busy-session work: tool calls, direct sends per recipient, inbox reads and turn reports', async () => {
  const sessions = await connected(4);
  const [sender, ...peers] = sessions;
  const ids = await Promise.all(peers.map(async p => (await fetch(`${base}/wait`, { method: 'POST',
    headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ run_id: p.runId }) })).status));
  expect(ids).toEqual([200, 200, 200]);
  const { agentByToken } = await import('../src/store/profiles.js');
  const peerIds = await Promise.all(peers.map(async p => (await inProject(TEST_PROJECT, () => agentByToken(p.token)))!.id));
  clock += 21_000;
  const emptyInbox = await mcp(sender.token, sender.runId, 'read_agent_inbox', {});
  const toOne = await mcp(sender.token, sender.runId, 'send_message', { to: [peerIds[0]], body: 'unit one', client_message_id: 'unit-1' });
  clock += 6_000; // the 5 s minimum gap between one agent's sends
  const toThree = await mcp(sender.token, sender.runId, 'send_message', { to: peerIds, body: 'unit three', client_message_id: 'unit-3' });
  const inbox = await mcp(peers[0].token, peers[0].runId, 'read_agent_inbox', {});
  const ack = await mcp(peers[0].token, peers[0].runId, 'read_agent_inbox', { ack: inbox.value.position });
  // A usage report on the wait contact, as the connector's end-of-turn refresh sends it.
  clock += 21_000;
  const report = await measured('/wait', sender.token, { run_id: sender.runId, report: { phase: 'idle', accepting_work: true,
    last_turn: { kind: 'synthetic', outcome: 'succeeded', ended_at: clock, usage: { sequence: 1, model: 'synthetic-no-model', seconds: 0, costUsd: null, tokens: null } } } });
  expect(report.status).toBe(200);
  const perRecipient = { reads: (toThree.reads - toOne.reads) / 2, writes: (toThree.writes - toOne.writes) / 2 };
  const table = { emptyInbox: [emptyInbox.reads, emptyInbox.writes], sendToOne: [toOne.reads, toOne.writes], sendToThree: [toThree.reads, toThree.writes],
    inboxTwoItems: [inbox.reads, inbox.writes], ack: [ack.reads, ack.writes], waitWithUsageReport: [report.reads, report.writes] };
  console.info(JSON.stringify({ busyWork: table, perExtraRecipient: perRecipient, inboxItems: inbox.value.items?.length }));
  expect(inbox.value.items?.length).toBe(2);
  expect(perRecipient.writes).toBeGreaterThan(0);
});

// One owner computer's 15 s poll (Drivers row 57 assumes 8 reads per owner sync): participation sync, participation
// controls, background sync and background controls, with empty pages as an idle computer sends them.
test('owner computer poll: reads per request through the owner routes', async () => {
  const { ownerRoutes } = await import('../src/owner/routes.js');
  const { idTokenFor } = await import('./helpers.js');
  const { hashToken, newToken } = await import('../src/auth.js');
  const app = express(); app.use(express.json()); app.use('/api/owner', ownerRoutes(now));
  const owner = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => owner.once('listening', resolve));
  const root = `http://127.0.0.1:${(owner.address() as { port: number }).port}/api/owner`;
  const call = async (path: string, token: string, body?: object) => {
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    return { status: response.status, json: await response.json() };
  };
  try {
    await seed({ profiles: [{ name: 'Computer owner', email: 'computer-owner@example.test' }] });
    const token = newToken(), id = randomUUID();
    expect((await call('/connect', '', { requestId: id, pollingSecret: newToken(), candidateTokenHash: hashToken(token), clientName: 'Unit' })).status).toBe(200);
    expect((await call(`/connect/${id}/approve`, await idTokenFor('computer-owner@example.test'), { approved: true })).status).toBe(200);
    const poll = [['/participations/sync', { participations: [] }], ['/participation-controls', undefined], ['/backgrounds/sync', { backgrounds: [] }], ['/background-controls', undefined]] as const;
    const table: Record<string, number[]> = {};
    for (let round = 0; round < 2; round++) {
      clock += 15_000;
      for (const [path, body] of poll) {
        await settle(); counted.reads = 0; counted.writes = 0;
        const result = await call(path, token, body);
        await settle();
        expect(result.status, `${path}: ${JSON.stringify(result.json)}`).toBe(200);
        table[path] = [counted.reads, counted.writes];
      }
    }
    const perPoll = Object.values(table).reduce((sum, [reads]) => sum + reads, 0);
    console.info(JSON.stringify({ ownerPoll: table, readsPerPoll: perPoll, readsPerComputerSecond: +(perPoll / 15).toFixed(2) }));
    expect(perPoll).toBeGreaterThan(0);
  } finally { owner.closeAllConnections(); await new Promise<void>(resolve => owner.close(() => resolve())); }
});

// An active computer's background sync page (c4's review: rows cost one transaction each). Counted for one row and for
// five, first publish and an unchanged republish (C4-3 skips unchanged confirmed pages for 40 s, so the republish is
// what a changed page costs, without the first-write path).
test('owner computer sync page: reads and writes per background row', async () => {
  const { syncBackgrounds } = await import('../src/projects/background-controls.js');
  const { collection } = await import('../src/firestore.js');
  const f = await seed({ profiles: [{ name: 'Row owner', email: 'row-owner@example.test' }],
    agents: Array.from({ length: 5 }, (_, i) => ({ person: 0, name: `Row worker ${i}` })) });
  const owner = f.personIds[0], computer = randomUUID();
  await collection('computerConnections').doc(computer).set({ profileId: owner, revokedAt: null, approvedAt: clock, connectionExpiresAt: clock + 86_400_000 });
  const rows = await Promise.all(f.agents.map(async agent => {
    const missionId = randomUUID();
    const run = await inProject(TEST_PROJECT, () => startRun(agent.agentId, { clientRunId: missionId, runnerVersion: 'synthetic-background', takeover: false }, now));
    return { target: { site: 'https://karma42.ai', ownerId: owner, projectId: TEST_PROJECT, agentId: agent.agentId }, missionId, generation: 17,
      deadlineAt: clock + 900_000, state: 'running' as const, pauseOperationId: null, updatedAt: clock, cloudRun: { runId: run.run_id, generation: run.generation } };
  }));
  const page = async (list: typeof rows) => {
    await settle(); counted.reads = 0; counted.writes = 0;
    await syncBackgrounds(owner, computer, { backgrounds: list }, now);
    await settle();
    return [counted.reads, counted.writes];
  };
  const one = await page(rows.slice(0, 1)), five = await page(rows);
  clock += 1_000;
  const again = await page(rows.map(r => ({ ...r, updatedAt: clock })));
  const perRow = (five[0] - one[0]) / 4;
  console.info(JSON.stringify({ backgroundSync: { oneRow: one, fiveRows: five, fiveRowsRepublished: again }, readsPerRow: perRow, readsPerRowRepublished: again[0] / 5 }));
  expect(perRow).toBeGreaterThan(1);
});

// A project-wide message runs its first delivery slice (≤400 recipients) inside the sending request (deliverProjectWide).
// Counted at two audience sizes for the per-recipient cost the workbook prices at 6 reads and 4 writes (Drivers 61, 64).
test('broadcast: reads and writes per recipient in the request-assisted slice', async () => {
  const sizes: Record<number, number[]> = {};
  for (const audience of [5, 25]) {
    await resetEmulator();
    const f = await seed({ profiles: [{ name: 'Announcer', email: `announcer-${audience}@example.test` }],
      agents: Array.from({ length: audience + 1 }, (_, i) => ({ person: 0, name: `Audience ${i}` })) });
    const sender = f.agents[0];
    const run = await inProject(TEST_PROJECT, () => startRun(sender.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
    clock += 61_000;
    const sent = await mcp(sender.token, run.run_id, 'send_message', { to: ['project'], body: `broadcast ${audience}`, client_message_id: `b-${audience}` });
    sizes[audience] = [sent.reads, sent.writes];
  }
  const perRecipient = { reads: (sizes[25][0] - sizes[5][0]) / 20, writes: (sizes[25][1] - sizes[5][1]) / 20 };
  console.info(JSON.stringify({ broadcast: sizes, perRecipient }));
  expect(perRecipient.writes).toBeGreaterThan(0);
  // Regression bound: the workbook's own per-recipient figures (6 reads, 4 writes; Drivers 61, 64).
  expect(perRecipient.reads).toBeLessThanOrEqual(6);
  expect(perRecipient.writes).toBeLessThanOrEqual(4);
}, 60_000);
