import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { profiles, inProject, agents } from '../src/firestore.js';
import { projects } from '../src/projects/records.js';
import { membershipDoc, membershipsOf } from '../src/projects/access.js';
import { listMyProjects, listProjects, listProjectShortcuts, readWorkspace } from '../src/projects/store.js';
import { setPersonalArchive, projectArchives, setPersonalStar, projectStars } from '../src/projects/personal-archive.js';
import { createPrivateProject } from '../src/projects/private.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { seed, resetEmulator, idTokenFor, TEST_PROJECT } from './helpers.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/api/projects', projectManagementRoutes(Date.now));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);
const input = (archived = true, expected_revision = 0) => ({ archived, expected_revision, client_request_id: randomUUID() });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }, { name: 'Bob', email: 'bob@example.test' }], agents: [{ person: 0, name: 'Synthetic worker' }] });
  const [alice, bob] = await Promise.all(f.personIds.map(async id => ({ id, ...(await profiles.doc(id).get()).data()! })));
  return { ...f, alice, bob };
}

test('personal archive changes only the viewer directory/shortcuts; access, workers and other participants remain intact', async () => {
  const { alice, bob } = await fixture();
  const before = (await projects.doc(TEST_PROJECT).get()).data();
  const workers = await inProject(TEST_PROJECT, () => agents().get());
  const membership = (await membershipDoc(TEST_PROJECT, alice.id).get()).data();
  expect(await setPersonalArchive(alice, TEST_PROJECT, input(), () => 1000)).toMatchObject({ archived: true, archiveRevision: 1 });
  expect((await listMyProjects(alice, undefined, 'current')).projects).toEqual([]);
  expect((await listProjects(alice, undefined, 'current')).projects).toEqual([]);
  expect((await listMyProjects(alice, undefined, 'archived')).projects).toMatchObject([{ id: TEST_PROJECT, archived: true }]);
  expect((await listMyProjects(bob, undefined, 'current')).projects).toMatchObject([{ id: TEST_PROJECT, archived: false }]);
  expect((await listProjects(alice)).projects).toMatchObject([{ id: TEST_PROJECT }]); // My agents/setup keep access.
  expect(await readWorkspace(alice, TEST_PROJECT)).toMatchObject({ archived: true, state: { status: 'active' } });
  expect((await projects.doc(TEST_PROJECT).get()).data()).toEqual(before);
  expect((await membershipDoc(TEST_PROJECT, alice.id).get()).data()).toEqual(membership);
  expect((await inProject(TEST_PROJECT, () => agents().get())).docs.map(doc => doc.data())).toEqual(workers.docs.map(doc => doc.data()));
});

test('HTTP archive requires the original signed-in profile and refuses foreign, removed and caller-selected identities', async () => {
  const { alice, bob } = await fixture(), token = await idTokenFor('alice@example.test');
  const call = (body: object, selected?: string, path = TEST_PROJECT) => fetch(`${base}/${path}/personal-archive`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(selected ? { 'X-Minions-Profile-Id': selected } : {}),
  }, body: JSON.stringify(body) });
  expect((await call(input())).status).toBe(401);
  expect((await call(input(), bob.id)).status).toBe(401);
  expect((await call({ ...input(), profileId: bob.id }, alice.id)).status).toBe(400);
  expect((await call(input(), alice.id, 'e'.repeat(64))).status).toBe(404);
  expect((await call(input(), alice.id)).status).toBe(200);
  await membershipDoc(TEST_PROJECT, alice.id).update({ status: 'removed', statusChangedAt: 1000 });
  await membershipsOf(alice.id).doc(TEST_PROJECT).update({ status: 'removed', statusChangedAt: 1000 });
  expect((await call(input(false, 1), alice.id)).status).toBe(404);
  expect((await listMyProjects(alice, undefined, 'archived')).projects).toEqual([]);
  expect((await projectArchives(bob.id).get()).empty).toBe(true);
});

test('private starred shortcuts are visible only to their owner or active members', async () => {
  const { alice, bob } = await fixture();
  const privateProject = await createPrivateProject(alice, { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title: 'Private star fixture', goal: 'Check private shortcut access.' }, Date.now);
  if (!('id' in privateProject)) throw new Error('Private project creation did not return its ID.');
  await setPersonalStar(alice, privateProject.id, { starred: true }, Date.now);
  expect((await listProjectShortcuts(alice)).projects[0]).toMatchObject({ id: privateProject.id, private: true, starred: true });
  await expect(setPersonalStar(bob, privateProject.id, { starred: true }, Date.now)).rejects.toMatchObject({ code: 'not_found' });
  // A stale preference is not an access grant when membership no longer exists.
  await projectStars(bob.id).doc(privateProject.id).set({ starred: true, updatedAt: 1000 });
  expect((await listProjectShortcuts(bob)).projects.some(project => project.id === privateProject.id)).toBe(false);
});
