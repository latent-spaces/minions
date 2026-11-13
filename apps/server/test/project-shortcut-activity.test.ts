import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { profiles, inProject } from '../src/firestore.js';
import { messagesV2 } from '../src/v2/records.js';
import { listProjectShortcuts } from '../src/projects/store.js';
import { setPersonalStar } from '../src/projects/personal-archive.js';
import { createPrivateProject } from '../src/projects/private.js';
import { seed, resetEmulator, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

// The menu lists the most recently active projects first; starred ones stay on top (owner, 13 November 2026).
test('shortcuts sort by newest message within starred and other projects, and carry the job end', async () => {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }], agents: [] });
  const alice = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! };
  const create = async (title: string) => {
    const project = await createPrivateProject(alice, { githubUrl: 'https://github.com/example/repo', client_request_id: randomUUID(), title, goal: 'Check menu order.' }, Date.now);
    if (!('id' in project)) throw new Error('Private project creation did not return its ID.');
    return project;
  };
  const quiet = await create('Quiet project'), busy = await create('Busy project');
  const say = (projectId: string, createdAt: number) => inProject(projectId, () => messagesV2().doc(randomUUID()).set({ createdAt } as never));
  await say(quiet.id, 1_000); await say(busy.id, 5_000);
  const order = async () => (await listProjectShortcuts(alice)).projects.map(project => project.id);
  const ordinary = (ids: string[]) => ids.filter(id => id !== TEST_PROJECT);
  expect(ordinary(await order()).slice(0, 2)).toEqual([busy.id, quiet.id]);
  await say(quiet.id, 9_000);
  expect(ordinary(await order()).slice(0, 2)).toEqual([quiet.id, busy.id]);
  // A starred project stays first even when it is the quieter one.
  await setPersonalStar(alice, busy.id, { starred: true }, Date.now);
  const starredFirst = await listProjectShortcuts(alice);
  expect(starredFirst.projects[0]).toMatchObject({ id: busy.id, starred: true, lastActivityAt: 5_000 });
  expect(starredFirst.projects.find(project => project.id === quiet.id)).toMatchObject({ lastActivityAt: 9_000, endsAt: null });
});
