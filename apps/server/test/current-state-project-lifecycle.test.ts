// AI-generated acceptance by scale-codex-3. Actual HTTP adapter + disposable SDK watches and real focus/run writers.
// Synthetic projects; no model, cloud capacity, Windows, app-render or MCP transport claim. C7/C8 and timers unchanged.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { reportAgentFocus } from '../src/projects/agent-focus.js';
import { humanRequests } from '../src/projects/human-requests.js';
import { startRun } from '../src/v2/runs.js';
import { viewRoutes } from '../src/view/routes.js';
import { configureCurrentState, CURRENT_STATE_LINGER_MS, CURRENT_STATE_MAX_PROJECTS,
  currentStateStats, stopCurrentState, type CurrentStateAnswer } from '../src/view/current-state.js';
import { addAgent, idTokenFor, resetEmulator, seed, seedApprovedProject, seedRuntime, testProject } from './helpers.js';

const projectId = (n: number) => n.toString(16).padStart(64, '0');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let server: Server, base: string, now = 100_000_000, processClock = 0, restore = () => {};
let owners: string[], tokens: string[];

beforeEach(async () => {
  stopCurrentState(); await resetEmulator(); now += 1_000_000; processClock = 0;
  restore = configureCurrentState({ clock: () => processClock });
  const f = await seed({ profiles: [
    { name: 'Lifecycle Alice', email: 'lifecycle-alice@example.test' },
    { name: 'Lifecycle Bob', email: 'lifecycle-bob@example.test' },
  ] });
  owners = f.personIds;
  tokens = await Promise.all(['lifecycle-alice@example.test', 'lifecycle-bob@example.test'].map(email => idTokenFor(email)));
  const app = express(), router = viewRoutes(() => now);
  app.use('/p/:projectId', (req, res, next) => inProject(req.params.projectId, () => router(req, res, next)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  restore(); stopCurrentState();  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
});

async function makeProject(n: number, owner = owners[0]!) {
  const id = projectId(n);
  await seedApprovedProject(id, { ownerProfileId: owner, required: false,
    definition: { title: `Lifecycle ${n}`, goal: 'Test current-state isolation', rules: 'Isolated', mergeApproval: 'humans' },
    runtime: { ...testProject, revision: 0, configuredAt: 0, configuredBy: owner, setupFinalizedAt: 0 },
  });
  return id;
}
async function writer(id: string, owner = owners[0]!, text = id) {
  return inProject(id, async () => {
    const agent = await addAgent(owner, 'lifecycle-agent', () => now);
    const run = await startRun(agent.agentId, { clientRunId: randomUUID(), runnerVersion: 'model-free-lifecycle', takeover: false }, () => now);
    await reportAgentFocus(agent.agentId, run.run_id, { status: text, client_request_id: 'initial-focus' }, () => now);
    return { agentId: agent.agentId, runId: run.run_id };
  });
}
async function read(id: string, cursor?: string, token = tokens[0]!) {
  const response = await fetch(`${base}/p/${id}/communication/agents/current${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, answer: await response.json() as CurrentStateAnswer };
}
async function answer(id: string, cursor?: string, token = tokens[0]!) {
  const result = await read(id, cursor, token);
  expect(result.status).toBe(200);
  return result.answer;
}
async function until(id: string, predicate: (a: CurrentStateAnswer) => boolean, cursor?: string, token = tokens[0]!) {
  for (let i = 0; i < 60; i++) {
    const a = await answer(id, cursor, token);
    if (predicate(a)) return a;
    await sleep(25);
  }
  throw new Error(`Project ${id} did not converge within 60 reads; all attempted reads counted by the route limiter.`);
}
const focus = (a: CurrentStateAnswer, agentId: string) => a.rows.find(
  (row): row is Extract<CurrentStateAnswer['rows'][number], { evaluatedAt: number }> => row.id === agentId && 'evaluatedAt' in row);

test('concurrent projects keep writer deltas, owner access, private Needs you and HTTP authority separate', async () => {
  const [a, b] = await Promise.all([makeProject(1), makeProject(2, owners[1])]);
  const [wa, wb] = await Promise.all([writer(a, owners[0], 'Alice original'), writer(b, owners[1], 'Bob original')]);
  await seedRuntime(b, { revision: 1, paused: true, pauseRequest: { revision: 1, requestedAt: now } });
  await Promise.all([a, b].map((id, i) => humanRequests.doc(`lifecycle-private-${i}`).set({
    projectId: id, agentId: i === 0 ? wa.agentId : wb.agentId, assigneeProfileId: owners[i],
    visibility: 'private', status: 'open', createdAt: now,
  } as never)));
  const [firstA, firstB] = await Promise.all([answer(a), answer(b, undefined, tokens[1])]);
  expect(firstA.rows.map(row => row.id)).toEqual([wa.agentId]);
  expect(firstB.rows.map(row => row.id)).toEqual([wb.agentId]);
  expect(firstA.needsYou).toEqual([wa.agentId]); expect(firstB.needsYou).toEqual([wb.agentId]);
  expect(firstA.pause).toBeNull(); expect(firstB.pause).toEqual({ revision: 1, requestedAt: now });
  expect(focus(firstA, wa.agentId)).toMatchObject({ mine: true, focus: { text: 'Alice original' } });
  expect(focus(firstB, wb.agentId)).toMatchObject({ mine: true, focus: { text: 'Bob original' } });
  // The route checks membership before reading a warm shared projection, even with a foreign held cursor.
  const forbidden = await read(b, firstA.cursor);
  expect(forbidden.status).toBe(404); expect(forbidden.answer.rows).toBeUndefined();
  now += 1000;
  await inProject(a, () => reportAgentFocus(wa.agentId, wa.runId, { status: 'Alice updated', client_request_id: 'update' }, () => now));
  const changed = await until(a, next => focus(next, wa.agentId)?.focus?.text === 'Alice updated', firstA.cursor);
  const quietB = await answer(b, firstB.cursor, tokens[1]);
  expect(changed.rows.map(row => row.id)).toEqual([wa.agentId]);
  expect(quietB.rows).toEqual([]); expect(quietB.needsYou).toEqual([wb.agentId]);
  expect(currentStateStats().cachedProjects).toBe(2);
});

// C5 project binding (c2 60953550, c3 owns the wrapper): both requests pass HTTP membership, so this exercises
// cursor validation rather than the non-member control above. One reader per (viewer, project) remains the client rule.
test('an authorized viewer cannot complete project B using project A cursor; fresh and same-project reads still work', async () => {
  const [a, b] = await Promise.all([makeProject(11), makeProject(12)]);
  const [wa, wb] = await Promise.all([writer(a, owners[0], 'Project A focus'), writer(b, owners[0], 'Project B focus')]);
  // Both writes precede A's cut. B's later initial snapshot has W >= that cut. The unbound old wrapper can therefore
  // falsely complete an empty delta at B instead of bootstrapping B's real row. Owners/pause are identical too.
  const firstA = await answer(a);
  const firstB = await answer(b);
  expect(firstA).toMatchObject({ complete: true, notReady: false });
  expect(firstB).toMatchObject({ complete: true, notReady: false });
  expect(firstA.rows.map(row => row.id)).toEqual([wa.agentId]);
  expect(firstB.rows.map(row => row.id)).toEqual([wb.agentId]);
  expect(firstB.watermark! >= firstA.watermark!).toBe(true);
  const foreign = await read(b, firstA.cursor);
  console.log(JSON.stringify({ authorizedProjectCursor: { status: foreign.status, complete: foreign.answer.complete,
    rows: foreign.answer.rows?.length, notReady: foreign.answer.notReady } }));
  expect(foreign.status).toBe(400);
  expect(foreign.answer.rows).toBeUndefined();
  const [sameA, sameB, freshB] = await Promise.all([answer(a, firstA.cursor), answer(b, firstB.cursor), answer(b)]);
  expect(sameA).toMatchObject({ complete: true, rows: [], notReady: false });
  expect(sameB).toMatchObject({ complete: true, rows: [], notReady: false });
  expect(freshB).toMatchObject({ complete: true, notReady: false });
  expect(freshB.rows.map(row => row.id)).toEqual([wb.agentId]);
  expect(focus(freshB, wb.agentId)?.focus?.text).toBe('Project B focus');
});

test('ordinary linger detaches; a held cursor recovers actual writer changes committed while detached', async () => {
  const id = await makeProject(3), w = await writer(id, owners[0], 'Before detach');
  const first = await answer(id);
  expect(focus(first, w.agentId)?.focus?.text).toBe('Before detach');
  await sleep(CURRENT_STATE_LINGER_MS + 100);
  expect(currentStateStats().cachedProjects).toBe(0);
  now += 1000;
  await inProject(id, () => reportAgentFocus(w.agentId, w.runId, { status: 'While detached', client_request_id: 'detached' }, () => now));
  const next = await until(id, a => focus(a, w.agentId)?.focus?.text === 'While detached', first.cursor);
  expect(next).toMatchObject({ complete: true, notReady: false });
  expect(next.rows.map(row => row.id)).toEqual([w.agentId]);
  expect(focus(next, w.agentId)!.rev > focus(first, w.agentId)!.rev).toBe(true);
  expect(currentStateStats().attaches).toBe(2);
}, 60_000);

test('over the listener cap a project is answered from a one-shot read (no old path); 100 abandoned replacements expire and the 101st then attaches', async () => {
  configureCurrentState({ currentBytes: 0 }); // exercise memory-refused recovery, independently of the CURRENT pool
  const ids: string[] = [];
  // Bounded fixture concurrency, real project records and real SDK listeners. This is correctness, not a throughput run.
  for (let n = 0; n < CURRENT_STATE_MAX_PROJECTS; n += 10) {
    ids.push(...await Promise.all(Array.from({ length: 10 }, (_, i) => makeProject(100 + n + i))));
  }
  const extra = await makeProject(1000), w = await writer(extra, owners[0], 'After cap recovery');
  const first = await Promise.all(ids.map(id => answer(id)));
  expect(first.every(a => a.complete && !('fallback' in a))).toBe(true);
  expect(currentStateStats().cachedProjects).toBe(CURRENT_STATE_MAX_PROJECTS);
  // Over the cap: the same answer from a one-shot read of the project's status documents, no listener slot taken (card v19).
  const blocked = await answer(extra);
  expect(blocked).toMatchObject({ complete: true, notReady: false });
  expect(focus(blocked, w.agentId)?.focus?.text).toBe('After cap recovery');

  expect(currentStateStats()).toMatchObject({ oneShots: 1, cachedProjects: CURRENT_STATE_MAX_PROJECTS });
  // A delta on that one-shot cursor, still over the cap, is again a one-shot read: nothing changed, nothing lost.
  expect(await answer(extra, blocked.cursor)).toMatchObject({ complete: true, rows: [] });
  // Quiet projects at the actual poll spacing prove currentness without an attach or status seed.
  processClock += 15_000;
  const quiet = await Promise.all(ids.map((id, i) => answer(id, first[i]!.cursor)));
  expect(quiet.every(a => a.complete && a.rows.length === 0)).toBe(true);
  expect(currentStateStats().reattaches).toBe(0);
  await sleep(CURRENT_STATE_LINGER_MS + 100);
  expect(currentStateStats().cachedProjects).toBe(0);
  const recovered = await answer(extra);
  expect(recovered).toMatchObject({ complete: true, notReady: false });
  expect(focus(recovered, w.agentId)?.focus?.text).toBe('After cap recovery');
  expect(currentStateStats().cachedProjects).toBe(1);

}, 90_000);
