import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { agents, inProject, profiles } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { readMergingAccess } from '../src/projects/merging.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { addAgent, idTokenFor, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
async function fixture() {
  const result = await seed({ profiles: [
    { name: 'First', email: 'first@example.test' },
    { name: 'Member', email: 'member@example.test' },
    { name: 'Third', email: 'third@example.test' },
  ], agents: [{ person: 1, name: 'Scout' }] });
  await profiles.doc('seed-owner').set({ name: 'Owner', email: 'owner@example.test', removedAt: null, githubUsername: 'owner-login' });
  await profiles.doc(result.personIds[1]).update({ githubUsername: 'member-login' });
  return result;
}
test('owner projection contains recorded identities without credentials or invented access', async () => {
  await fixture();
  {
    const result = await readMergingAccess('seed-owner', TEST_PROJECT, {}, () => 12345);
    expect(result.repository).toBe('https://github.com/example/game');
    expect(result.generatedAt).toBe(12345);
    expect(result.people.find(p => p.id === 'seed-owner')).toMatchObject({ role: 'owner', githubUsername: 'owner-login' });
    expect(result.agents[0]).toMatchObject({ name: 'Scout', connection: 'current', owner: { githubUsername: 'member-login', role: 'member' } });
    expect(JSON.stringify(result)).not.toMatch(/tokenHash|email|workingFolder|permission.*push/);
  }
});
test('members, outsiders and a removed account cannot read', async () => {
  const f = await fixture();
  for (const actor of [...f.personIds, 'outsider']) await expect(readMergingAccess(actor, TEST_PROJECT, {}, Date.now)).rejects.toThrow();
  await profiles.doc('seed-owner').update({ removedAt: 1 });
  await expect(readMergingAccess('seed-owner', TEST_PROJECT, {}, Date.now)).rejects.toThrow();
});
test('bounded pagination includes the owner once and preserves agent ownership across people pages', async () => {
  const f = await fixture();
  for (let i = 0; i < 24; i++) await inProject(TEST_PROJECT, () => addAgent(f.personIds[1], `Agent ${i}`, () => 1000));
  let cursor: string | undefined, ids: string[] = [];
  do {
    const page = await readMergingAccess('seed-owner', TEST_PROJECT, { agentsCursor: cursor }, Date.now);
    expect(page.agents.length).toBeLessThanOrEqual(20);
    expect(page.agents.every(a => a.owner.id === f.personIds[1])).toBe(true);
    ids.push(...page.agents.map(a => a.id)); cursor = page.agentsNext ?? undefined;
  } while (cursor);
  expect(new Set(ids).size).toBe(25);
  await inProject(TEST_PROJECT, () => agents().doc(f.agents[0].agentId).update({ connectionEpoch: 99 }));
  let page = await readMergingAccess('seed-owner', TEST_PROJECT, {}, Date.now);
  if (!page.agents.some(a => a.id === f.agents[0].agentId)) page = await readMergingAccess('seed-owner', TEST_PROJECT, { agentsCursor: page.agentsNext! }, Date.now);
  expect(page.agents.find(a => a.id === f.agents[0].agentId)?.connection).toBe('outdated');
  await membershipDoc(TEST_PROJECT, f.personIds[1]).update({ status: 'removed' });
  expect((await readMergingAccess('seed-owner', TEST_PROJECT, {}, Date.now)).agents).toEqual([]);
});

test('people pagination is bounded, includes the owner once and excludes removed profiles', async () => {
  const f = await fixture();
  const baseline = (await membershipDoc(TEST_PROJECT, f.personIds[1]).get()).data()!;
  await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    const id = `page-person-${String(index).padStart(2, '0')}`;
    await profiles.doc(id).set({ name: id, email: `${id}@example.test`, removedAt: index === 0 ? 1 : null });
    await membershipDoc(TEST_PROJECT, id).set({ ...baseline, profileId: id });
  }));
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await readMergingAccess('seed-owner', TEST_PROJECT, { peopleCursor: cursor }, Date.now);
    expect(page.people.length).toBeLessThanOrEqual(cursor ? 20 : 21);
    ids.push(...page.people.map(p => p.id)); cursor = page.peopleNext ?? undefined;
  } while (cursor);
  expect(ids).toHaveLength(27); expect(new Set(ids).size).toBe(27);
  expect(ids.filter(id => id === 'seed-owner')).toHaveLength(1);
  expect(ids).not.toContain('page-person-00');
});

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/projects', projectManagementRoutes(Date.now));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/projects/${TEST_PROJECT}/merging`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
test('HTTP boundary authenticates, enforces roles on every request and validates cursors', async () => {
  await fixture();
  expect((await fetch(base)).status).toBe(401);
  const token = await idTokenFor('owner@example.test'), headers = { authorization: `Bearer ${token}` };
  const ok = await fetch(base, { headers }); expect(ok.status).toBe(200); expect(ok.headers.get('cache-control')).toBe('no-store');
  expect((await fetch(`${base}?peopleCursor=../secret`, { headers })).status).toBe(400);
  const member = await idTokenFor('member@example.test');
  expect((await fetch(base, { headers: { authorization: `Bearer ${member}` } })).status).toBe(403);
});
