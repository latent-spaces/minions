import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { agents, inProject } from '../src/firestore.js';
import { defaultCommunication, readCommunication, saveCommunication } from '../src/projects/communication.js';
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
const override = (f: Awaited<ReturnType<typeof fixture>>, fields: object, revision = 0) => scope(() => saveCommunication(f.personIds[0], {
  expectedRevision: revision, fields,
}, () => T, f.rows[0].id));

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
  expect((await request('/communication', admin, { ...input, ownerProfileId: f.personIds[1] })).status).toBe(400);
  expect((await request('/communication', admin, input)).status).toBe(200);
  expect((await request('/communication', admin, input)).status).toBe(409);
  const path = `/agents/${f.rows[0].id}/communication`;
  expect((await request(path)).status).toBe(401);
  const memberRead = await request(path, member);
  expect(memberRead.status).toBe(200);
  expect(await memberRead.json()).toMatchObject({ canEditAgent: false, canEditDefaults: false });
  expect((await request(path, member, { expectedRevision: 0, fields: {} })).status).toBe(403);
  expect((await request(path, admin, { expectedRevision: 0, fields: { broadcastAllowed: false } })).status).toBe(200);
  expect((await request(path + '?unexpected=true', admin)).status).toBe(400);
});

test('project members inspect effective limits without private configuration or audit metadata', async () => {
  const f = await fixture(), a = f.rows[0];
  await override(f, { sendsPerHour: 12, broadcastAllowed: false });
  const view = await scope(() => readCommunication(f.personIds[1], a.id));
  expect(view).toMatchObject({ agentId: a.id, effective: { sendsPerHour: 12, broadcastAllowed: false },
    canEditAgent: false, canEditDefaults: false, overriddenFields: ['broadcastAllowed', 'sendsPerHour'] });
  expect(view.configuration).toBeUndefined();
  expect(JSON.stringify(view)).not.toMatch(/updatedByProfileId|tokenHash|persona|workSettings/);
  const manager = await scope(() => readCommunication(f.personIds[0], a.id));
  expect(manager.canEditAgent).toBe(true);
  expect(manager.configuration?.overrideFields.sendsPerHour).toBe(12);
  await scope(() => agents().doc(a.id).update({ revokedAt: T }));
  expect((await scope(() => readCommunication(f.personIds[0], a.id))).canEditAgent).toBe(false);
  await membershipDoc(TEST_PROJECT, f.personIds[1]).update({ status: 'removed' });
  await expect(scope(() => readCommunication(f.personIds[1], a.id))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(scope(() => readCommunication('guest', a.id))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(inProject('a'.repeat(64), () => readCommunication(f.personIds[0], a.id))).rejects.toMatchObject({ code: 'unauthorized' });
});
