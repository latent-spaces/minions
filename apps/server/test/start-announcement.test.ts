import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { collection, profiles } from '../src/firestore.js';
import { createPrivateProject } from '../src/projects/private.js';
import { membershipDoc } from '../src/projects/access.js';
import { controlWorkspace, readWorkspace } from '../src/projects/store.js';
import { readStartAnnouncement } from '../src/projects/start-announcement.js';
import { resetEmulator, seed, setTestMembership } from './helpers.js';

beforeEach(resetEmulator);
const now = () => 2_000_000_000_000;
async function fixture() {
  const people = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }, { name: 'Second', email: 'second@example.test' }, { name: 'Member', email: 'member@example.test' }, { name: 'Outside', email: 'outside@example.test' }] });
  const [owner, second, member, outside] = await Promise.all(people.personIds.map(async id => ({ id, ...(await profiles.doc(id).get()).data()! })));
  const { id } = await createPrivateProject(owner, { client_request_id: randomUUID(), title: 'Start announcement', goal: 'Shared kickoff', githubUrl: 'https://github.com/example/start' }, now) as { id: string };
  for (const person of [second, member]) await setTestMembership(id, person.id);
  const start = { action: 'start' as const, expected_revision: (await readWorkspace(owner, id)).revision, client_request_id: randomUUID() };
  return { id, owner, second, member, outside, start };
}

test('the owner\'s start commits one announcement, permanent history and durable agent event, without creating work', async () => {
  const f = await fixture();
  await expect(controlWorkspace(f.member, f.id, f.start, now)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await readStartAnnouncement(f.member.id, f.id)).toBeNull();
  await controlWorkspace(f.owner, f.id, f.start, now);
  await controlWorkspace(f.owner, f.id, f.start, now);
  for (const person of [f.owner, f.second, f.member]) expect(await readStartAnnouncement(person.id, f.id)).toEqual({ revision: f.start.expected_revision + 1, startedAt: now(), actorName: 'Owner', scheduled: false });
  const history = await collection(`projects/${f.id}/projectHistory`).get();
  expect(history.docs.filter(row => row.data().control?.action === 'start')).toHaveLength(1);
  const events = await collection(`projects/${f.id}/fanouts`).get();
  expect(events.docs.filter(row => row.data().kind === 'project_started')).toHaveLength(1);
  for (const path of ['agents', 'runs', 'sessions', 'workerSessions']) expect((await collection(`projects/${f.id}/${path}`).get()).size).toBe(0);
});

test('outsiders and removed members cannot read the start', async () => {
  const f = await fixture(); await controlWorkspace(f.owner, f.id, f.start, now);
  await membershipDoc(f.id, f.member.id).update({ status: 'removed' });
  await profiles.doc(f.second.id).update({ removedAt: now() });
  for (const person of [f.member, f.second, f.outside]) await expect(readStartAnnouncement(person.id, f.id)).rejects.toMatchObject({ code: 'unauthorized' });
});
