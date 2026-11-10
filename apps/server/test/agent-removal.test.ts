import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { agents, db, inProject, profiles, projectDoc } from '../src/firestore.js';
import { onboardingRoutes } from '../src/onboarding/routes.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { publicProjectRoutes } from '../src/projects/public.js';
import { publishCatalog } from '../src/projects/catalog.js';
import { viewRoutes } from '../src/view/routes.js';
import { communicationRoster } from '../src/view/communication-roster.js';
import { agentByToken } from '../src/store/profiles.js';
import { findAgents } from '../src/v2/agents.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { messagesV2, runs } from '../src/v2/records.js';
import { startRun, reportPhase } from '../src/v2/runs.js';
import { listMyWorkers } from '../src/projects/worker-sessions.js';
import { addAgent, idTokenFor, loadAgent, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let server: Server, base: string;
let at = 10_000_000;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
beforeAll(async () => {
  const app = express();
  app.use('/join', scoped(onboardingRoutes(() => at)));
  app.use('/public/:id', publicProjectRoutes(() => at));
  app.use('/view', scoped(viewRoutes(() => at)));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { await resetEmulator(); at += 100_000; });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }, { name: 'Peer', email: 'peer@example.test' }],
    agents: [{ person: 0, name: 'Bad-config' }, { person: 1, name: 'Healthy' }] });
  return { ...f, token: await idTokenFor('owner@example.test') };
}
async function http(path: string, token: string, body?: object) {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}

test('Remove fences a live run and communication, keeps history, frees the name and is retry-safe', async () => {
  const f = await fixture(), old = f.agents[0], peer = await loadAgent(f.agents[1].agentId), sender = await loadAgent(old.agentId);
  const run = await scope(() => startRun(old.agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => at));
  await scope(() => reportPhase(old.agentId, run.run_id, { phase: 'turn' }, () => at));
  await scope(() => sendMessageV2(sender, { to: [peer.id], body: 'Keep this contribution.', clientId: 'history' }, () => at));
  const remove = () => http(`/join/agents/${old.agentId}/revoke`, f.token, {});
  expect((await remove()).status).toBe(200);
  const retiredAt = at; at += 1000;
  expect((await remove()).status).toBe(200);
  await scope(async () => {
    expect((await agents().doc(old.agentId).get()).data()?.revokedAt).toBe(retiredAt);
    expect((await runs().doc(old.agentId).get()).data()).toMatchObject({ endedAt: retiredAt, endReason: 'operator_revoked' });
    expect(await agentByToken(old.token)).toBeNull();
    expect((await agentByToken(f.agents[1].token))?.id).toBe(peer.id);
    await expect(sendMessageV2(sender, { to: [peer.id], body: 'Late send', clientId: 'late' }, () => at)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(sendMessageV2(peer, { to: [old.agentId], body: 'New work', clientId: 'new' }, () => at)).rejects.toMatchObject({ code: 'not_found' });
    expect((await messagesV2().get()).docs.map(d => d.data().body)).toEqual(['Keep this contribution.']);
    expect((await listMyWorkers(f.personIds[0], () => at)).agents).toEqual([]);
    expect((await findAgents({}, () => at, f.personIds[1])).agents.map(a => a.agentId)).toEqual([peer.id]);
    expect((await communicationRoster({}, at)).agents.map(a => a.id)).toEqual([peer.id]);
  });
  const directory = await http('/view/agents', f.token);
  expect(directory.data.agents.map((a: { id: string }) => a.id)).toEqual([peer.id]);
  expect((await http(`/view/agents/${old.agentId}`, f.token)).data.agent.revokedAt).toBe(retiredAt);
  const overview = (await http('/view/overview', f.token)).data;
  expect(overview.agentCount).toBe(1);
  expect(overview.messageCount).toBeNull(); // not counted: no screen shows it, and it grows with retained history
  const replacement = await scope(() => addAgent(f.personIds[0], 'Bad-config', () => at));
  expect(replacement.agentId).not.toBe(old.agentId);
});

test('project admin cannot remove another participant’s agent, or a foreign project identity', async () => {
  const f = await fixture();
  expect((await http(`/join/agents/${f.agents[1].agentId}/revoke`, f.token, {})).status).toBe(404);
  await expect(inProject('abcd'.repeat(16), () => revokeOwned(f.personIds[0], f.agents[0].agentId, () => at))).rejects.toBeDefined();
  expect((await scope(() => agents().doc(f.agents[1].agentId).get())).data()?.revokedAt).toBeNull();
});

test('retired rows cannot crowd active directory pages, searches or the map roster', async () => {
  const f = await fixture();
  await scope(async () => {
    const batch = db.batch(), template = (await agents().doc(f.agents[0].agentId).get()).data()!;
    for (let i = 0; i < 205; i++) batch.set(agents().doc(`aaa-${i}`), { ...template, name: `AAA-${i}`, revokedAt: at });
    await batch.commit();
    expect((await communicationRoster({}, at)).agents).toHaveLength(2);
  });
  const all = await http('/view/agents', f.token);
  expect(all.data.agents).toHaveLength(2); expect(all.data.next).toBeNull();
  const search = await http('/view/agents?q=AAA', f.token);
  expect(search.data.agents).toEqual([]); expect(search.data.next).toBeNull();
});


test('published directory excludes retired agents while their historical detail link survives', async () => {
  const f = await fixture(), ownerId = f.personIds[0];
  await scope(() => projectDoc().update({ ownerProfileId: ownerId }));
  const person = { id: ownerId, ...(await profiles.doc(ownerId).get()).data()! };
  await publishCatalog(person, TEST_PROJECT, { client_request_id: 'publish', expected_revision: 0, listed: true, summary: 'Removal fixture', category: 'games', tags: [] }, () => at);
  await scope(() => revokeOwned(ownerId, f.agents[0].agentId, () => at));
  const listed = await http(`/public/${TEST_PROJECT}/agents`, f.token);
  expect(listed.status).toBe(200);
  expect(listed.data.agents.map((a: { id: string }) => a.id)).toEqual([f.agents[1].agentId]);
  expect((await http(`/public/${TEST_PROJECT}/agents/${f.agents[0].agentId}`, f.token)).data.agent.revokedAt).toBe(at);
});
