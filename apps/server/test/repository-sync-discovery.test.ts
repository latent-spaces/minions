import { beforeEach, expect, test } from 'vitest';
import { db, profiles } from '../src/firestore.js';
import { repositoryAccess } from '../src/projects/github-username.js';
import { projects } from '../src/projects/records.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

test('closed owned projects do not hide an open repository beyond the discovery limit', async () => {
  await seed();
  await profiles.doc('seed-owner').set({ name: 'Owner', email: 'owner@example.test', removedAt: null });
  const source = (await projects.doc(TEST_PROJECT).get()).data()!, batch = db.batch();
  // These IDs sort before TEST_PROJECT and would consume the whole unfiltered page.
  for (let index = 1; index <= 50; index++) batch.set(projects.doc(index.toString(16).padStart(64, '0')),
    { ...source, execution: { ...source.execution, paused: true, completedAt: 1_000_000 } });
  await batch.commit();
  const access = await repositoryAccess('seed-owner');
  expect(access.owned).toEqual([{ repo: 'https://github.com/example/game', usernames: [] }]);
  expect(access.observations).toEqual([{ projectId: TEST_PROJECT, repository: 'https://github.com/example/game', scope: 'project', membershipEpoch: 0 }]);
});
