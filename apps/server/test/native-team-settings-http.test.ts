import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { beforeEach, expect, test } from 'vitest';
import { membershipDoc } from '../src/projects/access.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { idTokenFor, resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
test('hosted team settings allow only the owner while preserving write and account boundaries', async () => {
  const people = [
    { name: 'Owner', email: 'owner@example.test', role: 'owner' as const },
    { name: 'Other', email: 'admin@example.test', role: 'member' as const },
    { name: 'Member', email: 'member@example.test', role: 'member' as const },
    { name: 'Third', email: 'moderator@example.test', role: 'member' as const },
    { name: 'Removed', email: 'removed@example.test', role: 'member' as const },
  ];
  const fixture = await seed({ profiles: people });
  await membershipDoc(TEST_PROJECT, fixture.personIds[4]).update({ status: 'removed' });
  const tokens = await Promise.all(people.map(person => idTokenFor(person.email)));
  // Keep all data in disposable emulators, but select the hosted ingress path.
  const previousHost = process.env.HOST;
  process.env.HOST = '0.0.0.0';
  const app = express(); app.use('/api/projects', projectManagementRoutes(() => 1000));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects/${TEST_PROJECT}`;
    const headers = (person: number, profile = person) => ({ authorization: `Bearer ${tokens[person]}`, 'content-type': 'application/json', 'x-minions-profile-id': fixture.personIds[profile] });
    const save = (person: number, body: object, profile = person) => fetch(`${root}/native-team-settings`, { method: 'POST', headers: headers(person, profile), body: JSON.stringify(body) });
    const initial = await fetch(`${root}/native-team-settings`, { headers: headers(0) });
    expect(await initial.json()).toEqual({ enabled: false, revision: 0 });
    const off = { enabled: false, expectedRevision: 0, clientRequestId: randomUUID() };
    for (const [person, status] of [[1, 403], [2, 403], [3, 403], [4, 401]]) expect((await save(person, off)).status).toBe(status);
    expect((await save(0, off, 1)).status).toBe(401);
    const first = await save(0, off); expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ enabled: false, revision: 1 });
    const on = await save(0, { enabled: true, expectedRevision: 1, clientRequestId: randomUUID() });
    expect(on.status).toBe(200); expect(await on.json()).toEqual({ enabled: true, revision: 2 });
    const retry = await save(0, off); expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ enabled: false, revision: 1 });
    const current = await fetch(`${root}/native-team-settings`, { headers: headers(0) });
    expect(await current.json()).toEqual({ enabled: true, revision: 2 });
    expect((await save(0, { ...off, clientRequestId: randomUUID() })).status).toBe(409);
    await seedRuntime(TEST_PROJECT, { completedAt: 1000, paused: true });
    expect((await save(0, { enabled: false, expectedRevision: 2, clientRequestId: randomUUID() })).status).toBe(403);
  } finally {
    if (previousHost === undefined) delete process.env.HOST; else process.env.HOST = previousHost;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
