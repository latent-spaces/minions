import { prepareCurrentStateProgress } from '../src/view/current-state-progress.js';
// c12, card 20 slice D: every status consumer reads one implementation. The member directory (/agents), the deployed
// clients' /communication/agents?ids=, the map's /communication/agents/current and the public Explore list report the same
// state for the same agents at the same moment: never ran, working, revoked, the viewer's own Needs you, and a queued web
// start. Real product writers (run start, phase report, revocation, a private request, a web start) on the emulator.
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { agents, collection, db, inProject, profiles, projectDoc, type Agent } from '../src/firestore.js';
import { writeCreatedAgentStatus } from '../src/v2/agent-group.js';
import { presence } from '../src/v2/records.js';
import { humanRequests } from '../src/projects/human-requests.js';
import { publishCatalog } from '../src/projects/catalog.js';
import { publicProjectRoutes } from '../src/projects/public.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { createWebAgentStart, publishRuntimeReadiness } from '../src/owner/web-agent-starts.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { viewRoutes } from '../src/view/routes.js';
import { stopCurrentState } from '../src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

const at = 2_000_000_000_000;
let server: Server, base: string;
beforeEach(async () => {
  stopCurrentState(); await resetEmulator();
  const app = express();
  app.use('/view', scoped(viewRoutes(() => at)));
  app.use('/public/:id', publicProjectRoutes(() => at));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
afterAll(() => stopCurrentState());

type Row = { id: string; state: string };
const byId = (rows: Row[]) => Object.fromEntries(rows.map(r => [r.id, r.state]));

test('directory, ?ids=, /current and the public list report the same state per agent: never ran, working, revoked, Needs you, queued', async () => {
  const f = await seed({ profiles: [{ name: 'Viewer', email: 'c12-consumers@example.test' }],
    agents: [{ person: 0, name: 'never-ran' }, { person: 0, name: 'working' }, { person: 0, name: 'revoked' }, { person: 0, name: 'needs-you' }] });
  const owner = f.personIds[0];
  const [neverRan, working, revoked, needsYou] = f.agents.map(a => a.agentId);
  await inProject(TEST_PROJECT, async () => {
    // What product creation (registration.ts, owner/agents.ts) writes with the agent: its complete status document, so a
    // never-run agent is a real current-state row. (The shared seed helper writes the agent document only.)
    for (const id of f.agents.map(a => a.agentId)) await db.runTransaction(async tx => {
      const agent = (await tx.get(agents().doc(id))).data() as Agent;
      const progress = await prepareCurrentStateProgress(tx, [presence().doc(id)]);
      writeCreatedAgentStatus(tx, presence().doc(id), agent, progress);
    });
    await projectDoc().update({ ownerProfileId: owner });
    for (const id of [working, needsYou]) {
      const run = await startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-test-no-model', takeover: false }, () => at);
      await reportPhase(id, run.run_id, { phase: 'turn' }, () => at);
    }
    await revokeOwned(owner, revoked, () => at);
  });
  await humanRequests.doc(randomUUID()).set({ projectId: TEST_PROJECT, agentId: needsYou, assigneeProfileId: owner,
    visibility: 'private', status: 'open', createdAt: at } as never);
  // A queued never-run agent: an approved web start on an approved computer that has not created the agent yet.
  const computer = randomUUID(), startId = randomUUID();
  await collection('computerConnections').doc(computer).set({ profileId: owner, revokedAt: null, approvedAt: at, connectionExpiresAt: at + 30 * 86_400_000 });
  await publishRuntimeReadiness(owner, computer, { protocol: 1, version: '0.1.0', incarnation: randomUUID(), platform: 'darwin',
    providers: [{ id: 'codex', available: true, reason: 'ready' }] }, () => at);
  await createWebAgentStart(owner, { id: startId, connectionId: computer, projectId: TEST_PROJECT, name: 'queued', scope: 'Synthetic queued start',
    execution: { provider: 'codex', model: null }, approved: true }, () => at);
  const person = { id: owner, ...(await profiles.doc(owner).get()).data()! };
  await publishCatalog(person as never, TEST_PROJECT, { client_request_id: 'publish', expected_revision: 0, listed: true, summary: 'c12 fixture', category: 'games', tags: [] }, () => at);

  const token = await idTokenFor('c12-consumers@example.test');
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status, path).toBe(200);
    return await response.json() as { agents?: Row[]; rows?: Row[]; needsYou?: string[] };
  };
  const ids = [neverRan, working, revoked, needsYou];
  // The queued row's id is `queued-` plus the start's stored key; the directory's first page lists it.
  const firstPage = byId((await get('/view/agents')).agents!);
  const queuedId = Object.keys(firstPage).find(id => id.startsWith('queued-'));
  expect(queuedId, 'the queued start is listed').toBeDefined();
  const batch = byId((await get(`/view/communication/agents?ids=${[...ids, queuedId!].join(',')}`)).agents!);
  const directory = byId((await get(`/view/agents?ids=${ids.join(',')}`)).agents!);
  const current = await get('/view/communication/agents/current');
  const currentStates = byId(current.rows!.filter(r => ids.includes(r.id)).map(r =>
    ({ id: r.id, state: current.needsYou?.includes(r.id) && r.state !== 'revoked' ? 'needs_you' : r.state })));
  const publicList = byId((await get(`/public/${TEST_PROJECT}/agents`)).agents!);

  // Exact states, pinned from 41c24c02 (before the migration): the contract is byte-equal.
  expect(batch).toEqual({ [neverRan]: NEVER_RAN, [working]: 'working', [revoked]: 'revoked', [needsYou]: 'needs_you', [queuedId!]: 'waiting' });
  // Every member-facing surface lists every agent and agrees on it.
  expect(directory).toEqual({ [neverRan]: NEVER_RAN, [working]: 'working', [revoked]: 'revoked', [needsYou]: 'needs_you' });
  expect(Object.keys(currentStates).sort()).toEqual([...ids].sort());
  expect(currentStates).toEqual(directory);
  expect(firstPage[queuedId!]).toBe('waiting');
  for (const id of [neverRan, working, needsYou]) expect(firstPage[id]).toBe(directory[id]);
  // The public list (no viewer): active agents only, the same state without anyone's private Needs you.
  expect(publicList).toEqual({ [neverRan]: NEVER_RAN, [working]: 'working', [needsYou]: 'working' });
});

// The state of an agent that was created and never ran, as 41c24c02 reports it (pinned by running this test there).
const NEVER_RAN = 'unknown';
