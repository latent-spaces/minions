import express from 'express';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, expect, test, vi } from 'vitest';
import type { Server } from 'node:http';
import { hashToken, newToken } from '../src/auth.js';
import { ownerRoutes } from '../src/owner/routes.js';
import { profiles } from '../src/firestore.js';
import { membershipDoc, membershipsOf } from '../src/projects/access.js';
import { createPrivateProject } from '../src/projects/private.js';
import { seed, resetEmulator, idTokenFor } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });
let server: Server, base: string;
const now = () => 1000;
beforeAll(async () => { const app = express(); app.use('/api/owner', ownerRoutes(now)); server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/owner`; });
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });
beforeEach(resetEmulator);
async function http(path: string, token: string, body?: object, profileId?: string) {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(profileId ? { 'X-Minions-Profile-Id': profileId } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
async function computer(email: string) {
  const token = newToken(), id = randomUUID();
  await http('/connect', '', { requestId: id, pollingSecret: newToken(), candidateTokenHash: hashToken(token), clientName: 'Test' });
  expect((await http(`/connect/${id}/approve`, await idTokenFor(email), { approved: true })).status).toBe(200);
  return token;
}
async function fixture() {
  const { personIds: [host, member] } = await seed({ profiles: [{ name: 'Host', email: 'host@example.test' }, { name: 'Member', email: 'member@example.test' }, { name: 'Outsider', email: 'outsider@example.test' }] });
  const owner = { id: host, ...(await profiles.doc(host).get()).data()! };
  const { id } = await createPrivateProject(owner, { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title: 'Private team', goal: 'Build' }, now) as { id: string };
  const row = { profileId: member, projectId: id, role: 'member' as const, status: 'active' as const, statusChangedAt: 0, restrictions: { chatMutedUntil: null }, revision: 1, updatedAt: 0, connectionEpoch: 0 };
  await membershipDoc(id, member).set(row); await membershipsOf(member).doc(id).set(row);
  const [hostToken, memberToken, outsiderToken] = await Promise.all(['host', 'member', 'outsider'].map(n => computer(`${n}@example.test`)));
  return { id, host, member, hostToken, memberToken, outsiderToken };
}
const reads = (id: string) => ['overview', 'agents', 'conversations', 'chat', 'updates', 'tasks'].map(path => `/projects/${id}/${path}`);

test('a plain member reads what the website shows them; an outsider is refused', async () => {
  const f = await fixture();
  for (const path of reads(f.id)) {
    expect((await http(path, f.memberToken)).status, path).toBe(200);
    expect((await http(path, f.outsiderToken)).status, path).toBe(404);
  }
  const overview = (await http(`/projects/${f.id}/overview`, f.memberToken)).body;
  expect(overview).toMatchObject({ role: 'member', status: { projectId: f.id, startsAgents: false } });
  for (const key of ['updateSettings', 'inviteLink', 'setupPlan']) expect(overview).not.toHaveProperty(key);
  const owned = (await http(`/projects/${f.id}/overview`, f.hostToken)).body;
  expect(owned).toMatchObject({ role: 'owner' });
  expect(owned).toHaveProperty('updateSettings');
  expect(owned).not.toHaveProperty('inviteLink');
});
