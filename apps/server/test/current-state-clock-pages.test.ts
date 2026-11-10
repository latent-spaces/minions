import { setCanonicalStatus } from './canonical-status-fixture.js';
// Failing-first acceptance for the CS2b current-state read (c10; c7's and c1's review of c3 e8a68b55): a clock boundary
// that passes WHILE a delta answer is being paged. Rows on an earlier page are derived at that page's time; if the last
// page only compares derive(E) with derive(now), a row whose state moved in between is never corrected.
// c7's case: the client's last complete answer is at E = T. Agent x makes a new contact at T+10 (Offline at T, because a
// contact after `now` is not counted). Page 1 at T+99 sends x Working (contact + 90 s = T+100). The answer completes at
// T+101: derive(T) = Offline = derive(T+101), so x is not re-sent, and the client shows x Working until x's next write.
// Contract v2.3: after a complete answer the client holds the state at its end; a client replaces a row on
// (rev, evaluatedAt) greater. Page size 1 through c3's configureCurrentState({ pageSize }) (fc63677b), so two changed
// documents make a two-page delta. Writes are real (emulator); the read clock is the route's injected `now`.
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { viewRoutes } from '../src/view/routes.js';
import { configureCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let at = 60_000_000, server: Server | undefined, base = '', restore = () => {};
const scope = <T>(work: () => Promise<T>) => inProject(TEST_PROJECT, work);
beforeEach(async () => {
  stopCurrentState();
  await resetEmulator(); at += 10_000_000;
  restore = configureCurrentState({ pageSize: 1 } as Parameters<typeof configureCurrentState>[0]);
  const app = express(); app.use(scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  restore();
  server?.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve()));
});
afterAll(() => stopCurrentState());

type Row = { id: string; rev: string; evaluatedAt?: number; state?: string };
type Answer = { rows: Row[]; cursor: string; more: boolean; notReady?: boolean };
async function current(token: string, cursor?: string) {
  const response = await fetch(`${base}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return await response.json() as Answer;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function writeStatus(agentId: string, owner: string, fields: Record<string, unknown> = {}) {
  await scope(() => setCanonicalStatus(agentId,{ runId: 'run-1', lastContactAt: at, phase: 'turn', phaseAt: at, acceptingWork: true,
    runEndedAt: null, runMode: 'background',
    agent: { name: agentId, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: null, personaText: '' }, ...fields } as never, { merge: true }));
}
// The client side of contract v2.3: hold one row per id, replace it when (rev, evaluatedAt) is greater.
function reduce(held: Map<string, Row>, answer: Answer) {
  for (const row of answer.rows) {
    const old = held.get(row.id);
    if (!old || row.rev > old.rev || (row.rev === old.rev && (row.evaluatedAt ?? 0) > (old.evaluatedAt ?? 0))) held.set(row.id, row);
  }
}
// One page at the current `at`; a notReady page (W < P) is asked again with the same cursor.
async function page(token: string, cursor?: string) {
  for (let i = 0; i < 100; i++) { const a = await current(token, cursor); if (!a.notReady) return a; await sleep(50); }
  throw new Error('No ready page in time.');
}

test('a boundary that passes between the pages of one delta answer is corrected by its end (c7: x stuck Working)', async () => {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'pages-alice@example.test' }], agents: [{ person: 0, name: 'alice-fox' }] });
  const owner = f.personIds[0]!, token = await idTokenFor('pages-alice@example.test');
  // Ids in page order: x first. x's last contact is long past (Offline); y is live with a far deadline.
  const x = 'a-x', y = 'b-y', T = at;
  await writeStatus(x, owner, { lastContactAt: T - 200_000, phaseAt: T - 200_000 });
  await writeStatus(y, owner);
  // The client's first read, paged to completion at T: its held state, E = T.
  const held = new Map<string, Row>();
  let answer = await page(token);
  for (let i = 0; i < 20 && (held.size < 2 || answer.more); i++) {
    reduce(held, answer);
    if (!answer.more && held.size >= 2) break;
    answer = answer.more ? await page(token, answer.cursor) : await page(token);
  }
  expect(held.get(x)?.state).toBe('offline');
  const complete = answer.cursor;
  // At T+10 x makes a new contact (its state moves without the client asking), and y changes too: two changed docs.
  at = T + 10_000;
  await writeStatus(x, owner, { lastContactAt: at, phaseAt: at });
  await writeStatus(y, owner, { agent: { name: y, ownerProfileId: owner, connectionEpoch: 0, revokedAt: null, focus: { text: 'y moved', updatedAt: at }, personaText: '' } });
  await sleep(300);  // let the listener deliver both writes
  // Page 1 at T+99: x is Working (contact + 90 s = T+100). The delta really pages (page size 1, two changes).
  at = T + 99_000;
  const first = await page(token, complete);
  expect(first.more).toBe(true);
  reduce(held, first);
  expect(first.rows.find(r => r.id === x)?.state).toBe('working');
  // The answer completes at T+101, after x's contact has expired.
  at = T + 101_000;
  let last = await page(token, first.cursor);
  reduce(held, last);
  for (let i = 0; i < 10 && last.more; i++) { last = await page(token, last.cursor); reduce(held, last); }
  expect(last.more).toBe(false);
  // Positive control: a fresh read at T+101 shows x Offline.
  const fresh = new Map<string, Row>();
  let snap = await page(token);
  reduce(fresh, snap);
  for (let i = 0; i < 10 && snap.more; i++) { snap = await page(token, snap.cursor); reduce(fresh, snap); }
  expect(fresh.get(x)?.state).toBe('offline');
  // After the complete answer, the client holds the state at its end: x Offline, not Working.
  expect(held.get(x)?.state).toBe('offline');
  // And it stays right: a quiet answer later does not leave it stuck either.
  at = T + 102_000;
  reduce(held, await page(token, last.cursor));
  expect(held.get(x)?.state).toBe('offline');
});
