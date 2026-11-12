import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { agents, inProject } from '../src/firestore.js';
import { defaultCommunication, readCommunication, saveCommunication } from '../src/projects/communication.js';
import { readParticipationContext } from '../src/projects/agent-participation.js';
import { membershipDoc } from '../src/projects/access.js';
import { idTokenFor, loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const T = 1_000_000;
let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/api/projects', projectManagementRoutes(() => T));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects/${TEST_PROJECT}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
async function fixture(count = 3) {
  const f = await seed({ profiles: [{ name: 'Owner', email: 'admin@example.test', role: 'owner' },
    { name: 'Member', email: 'member@example.test' }],
    agents: Array.from({ length: count }, (_, i) => ({ person: 1, name: `agent-${i}` })) });
  return { ...f, rows: await Promise.all(f.agents.map(a => scope(() => loadAgent(a.agentId)))) };
}

test('HTTP settings require the project owner, reject extra fields and keep reads private', async () => {
  const f = await fixture(), admin = await idTokenFor('admin@example.test'), member = await idTokenFor('member@example.test');
  const request = (path: string, token?: string, body?: object) => fetch(base + path, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect((await request('/communication')).status).toBe(401);
  expect((await request('/communication', member)).status).toBe(403);
  const read = await request('/communication', admin);
  expect(read.status).toBe(200); expect(read.headers.get('cache-control')).toBe('no-store');
  expect(await read.json()).toMatchObject({ effective: { broadcastsPerHour: 6, sharedBroadcastsPerHour: 6 } });
  const input = { expectedRevision: 0, defaults: defaultCommunication(), sharedBroadcastsPerHour: 6 };
  expect((await request('/communication', member, input)).status).toBe(403);
  expect((await request('/communication', admin, { ...input, ownerProfileId: f.personIds[1] })).status).toBe(400);
  expect((await request('/communication', admin, input)).status).toBe(200);
  expect((await request('/communication', admin, input)).status).toBe(409);
  expect((await request('/communication?unexpected=true', admin)).status).toBe(400);
  // Per-agent limits were removed (owner, 12 November 2026): the old agent route no longer exists.
  const path = `/agents/${f.rows[0].id}/communication`;
  expect((await request(path, admin)).status).toBe(404);
  expect((await request(path, admin, { expectedRevision: 0, fields: { broadcastAllowed: false } })).status).toBe(404);
});

test('project defaults apply to every agent and ignore a saved per-agent override', async () => {
  const f = await fixture(), [a, b] = f.rows;
  const defaults = { broadcastAllowed: false, sendsPerHour: 12, minimumGapSeconds: 30, broadcastsPerHour: 2 };
  await scope(() => saveCommunication(f.personIds[0], { expectedRevision: 0, defaults, sharedBroadcastsPerHour: 3 }, () => T));
  // A record saved before the removal stays in the data but is no longer read.
  await scope(() => agents().doc(a.id).update({ communicationOverride: { fields: { sendsPerHour: 50, broadcastAllowed: true },
    revision: 1, updatedAt: T, updatedByProfileId: f.personIds[0] } }));
  for (const agent of [a, b]) {
    const { messaging } = await scope(() => readParticipationContext(agent.id, undefined, () => T));
    expect(messaging).toMatchObject({ sendsPerHour: 12, minimumGapSeconds: 30, broadcastAllowed: false,
      broadcastsPerAgentPerHour: 2, projectRevision: 1 });
    expect(messaging).not.toHaveProperty('overrideRevision');
  }
  const view = await scope(() => readCommunication(f.personIds[0]));
  expect(view).toEqual({ effective: { ...defaults, sharedBroadcastsPerHour: 3, projectRevision: 1 }, canEditDefaults: true,
    configuration: { defaults, sharedBroadcastsPerHour: 3, projectRevision: 1 } });
  await expect(scope(() => readCommunication(f.personIds[1]))).rejects.toMatchObject({ code: 'forbidden' });
  await membershipDoc(TEST_PROJECT, f.personIds[1]).update({ status: 'removed' });
  await expect(scope(() => readCommunication(f.personIds[1]))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(scope(() => readCommunication('guest'))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(inProject('a'.repeat(64), () => readCommunication(f.personIds[0]))).rejects.toMatchObject({ code: 'unauthorized' });
});
