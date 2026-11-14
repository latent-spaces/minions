import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { getNativeTask, listNativeTasks, mutateNativeTask } from '../src/projects/native-tasks.js';
import { startRun } from '../src/v2/runs.js';
import { inboxes } from '../src/v2/records.js';
import { readUpdates } from '../src/v2/inbox.js';
import { V2_LIMITS } from '../src/config.js';
import { resetEmulator, seed, loadAgent, TEST_PROJECT } from './helpers.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';

// Owner decision, 14 November 2026: a person's new task carries their message to their own agents.
beforeEach(resetEmulator);
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const now = () => 1000;
const create = (title: string, message?: string) => ({ operation: 'create', clientRequestId: randomUUID(), title, ...(message === undefined ? {} : { message }) });
async function fixture() {
  // The owner has Otter and Badger; the member has Fox.
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test', role: 'owner' }, { name: 'Member', email: 'member@example.test' }],
    agents: [{ person: 0, name: 'Otter' }, { person: 1, name: 'Fox' }, { person: 0, name: 'Badger' }] });
  const persons = await Promise.all(f.personIds.map(async id => ({ kind: 'person' as const, person: { id, ...(await profiles.doc(id).get()).data()! } })));
  const agent = await loadAgent(f.agents[1].agentId), runId = randomUUID();
  await scope(() => startRun(agent.id, { clientRunId: runId, runnerVersion: 'native-task-message-test', takeover: false }, now));
  const fox: ProgressActor = { kind: 'agent', agent, runId };
  const [otter, foxId, badger] = f.agents.map(a => a.agentId);
  return { ...f, persons, fox, otter, foxId, badger };
}
const items = async (agentId: string, kind: string) => (await readUpdates(agentId, undefined, now)).items.filter(item => item.kind === kind);

test('an unassigned task from a person messages each of their own agents once, and keeps the message as a comment', async () => scope(async () => {
  const f = await fixture(), input = create('Fix the map', 'Start with the legend.');
  const { task, comment } = await mutateNativeTask(f.persons[0], input, now);
  await mutateNativeTask(f.persons[0], input, now); // A replay delivers nothing new.
  for (const id of [f.otter, f.badger]) expect(await items(id, 'task_created')).toEqual([expect.objectContaining({ payload: {
    type: 'task_created', taskId: task.id, revision: 1, createdBy: { kind: 'person', id: f.personIds[0] }, titleAuthor: { kind: 'person', id: f.personIds[0] },
    title: { trust: 'untrusted', source: { type: 'person', personId: f.personIds[0] }, content: 'Fix the map' },
    message: { trust: 'untrusted', source: { type: 'person', personId: f.personIds[0] }, content: 'Start with the legend.' } } })]);
  expect(await items(f.foxId, 'task_created')).toEqual([]); // Another person's agent is never messaged.
  expect(comment).toMatchObject({ body: 'Start with the legend.', author: { kind: 'person', id: f.personIds[0] } });
  expect((await getNativeTask(f.persons[1], task.id, {}, now)).comments.map(c => c.body)).toEqual(['Start with the legend.']);
  expect((await inboxes().doc(f.otter).get()).data()?.lastDirect).toBe(1); // A direct item: a running agent takes a turn.
  // A member's message reaches only the member's agent.
  await mutateNativeTask(f.persons[1], create('Member work', 'Over to you.'), now);
  expect(await items(f.foxId, 'task_created')).toHaveLength(1);
  expect(await items(f.otter, 'task_created')).toHaveLength(1);
}));

test('without a message, and for tasks agents create, nobody is messaged; agents cannot attach one', async () => scope(async () => {
  const f = await fixture();
  await mutateNativeTask(f.persons[0], create('Quiet task'), now);
  await mutateNativeTask(f.fox, create('Agent task'), now);
  for (const id of [f.otter, f.foxId, f.badger]) expect(await items(id, 'task_created')).toEqual([]);
  await expect(mutateNativeTask(f.fox, create('Agent task', 'hello'), now)).rejects.toMatchObject({ code: 'forbidden' });
}));

test('assigning a new task to your own agent carries the message; another person’s agent gets only the notice', async () => scope(async () => {
  const f = await fixture();
  const own = (await mutateNativeTask(f.persons[0], create('Own work'), now)).task;
  const assigned = await mutateNativeTask(f.persons[0], { operation: 'assign', taskId: own.id, expectedRevision: 1, clientRequestId: randomUUID(), assignedAgentId: f.otter, message: 'This one is yours.' }, now);
  expect(assigned.comment?.body).toBe('This one is yours.');
  expect(await items(f.otter, 'task_assigned')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ taskId: own.id,
    message: { trust: 'untrusted', source: { type: 'person', personId: f.personIds[0] }, content: 'This one is yours.' } }) })]);
  expect(await items(f.badger, 'task_created')).toEqual([]);
  const other = (await mutateNativeTask(f.persons[0], create('Member’s agent work'), now)).task;
  const toFox = { operation: 'assign', taskId: other.id, expectedRevision: 1, clientRequestId: randomUUID(), assignedAgentId: f.foxId };
  await expect(mutateNativeTask(f.persons[0], { ...toFox, message: 'Please do this.' }, now)).rejects.toMatchObject({ code: 'forbidden' });
  await mutateNativeTask(f.persons[0], { ...toFox, clientRequestId: randomUUID() }, now);
  const [notice] = await items(f.foxId, 'task_assigned');
  expect(notice.payload).not.toHaveProperty('message');
}));

test('a full inbox refuses the task with its message, and nothing is saved', async () => scope(async () => {
  const f = await fixture();
  await inboxes().doc(f.badger).set({ last: V2_LIMITS.backlogMax, acked: 0, updatedAt: 0 });
  await expect(mutateNativeTask(f.persons[0], create('Too busy', 'hello'), now)).rejects.toMatchObject({ code: 'recipient_backlog' });
  expect(await items(f.otter, 'task_created')).toEqual([]);
  expect((await listNativeTasks(f.persons[0], {}, now)).tasks).toEqual([]);
  await expect(mutateNativeTask(f.persons[0], create('Too busy'), now)).resolves.toMatchObject({ replayed: false });
}));
