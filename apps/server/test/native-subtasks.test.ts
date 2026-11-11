import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { getNativeTask, listNativeTaskSummaries, mutateNativeTask } from '../src/projects/native-tasks.js';
import { startRun } from '../src/v2/runs.js';
import { readUpdates } from '../src/v2/inbox.js';
import { resetEmulator, seed, loadAgent, TEST_PROJECT } from './helpers.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';

beforeEach(resetEmulator);
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const now = () => 1000;
const create = (title: string, parentId?: string) => ({ operation: 'create', clientRequestId: randomUUID(), title, ...(parentId ? { parentId } : {}) });
const op = (operation: string, task: { id: string; revision: number }, extra: object = {}) => ({ operation, clientRequestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, ...extra });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test', role: 'owner' }, { name: 'Member', email: 'member@example.test' }],
    agents: [{ person: 0, name: 'Otter' }, { person: 1, name: 'Fox' }] });
  const persons = await Promise.all(f.personIds.map(async id => ({ kind: 'person' as const, person: { id, ...(await profiles.doc(id).get()).data()! } })));
  const actors: ProgressActor[] = [];
  for (const a of f.agents) {
    const agent = await loadAgent(a.agentId), runId = randomUUID();
    await scope(() => startRun(agent.id, { clientRunId: runId, runnerVersion: 'native-subtask-test', takeover: false }, now));
    actors.push({ kind: 'agent', agent, runId });
  }
  return { ...f, persons, actors };
}

test('people nest subtasks at any depth; the task page reads its parents and subtasks', async () => scope(async () => {
  const f = await fixture(), owner = f.persons[0];
  const root = (await mutateNativeTask(owner, create('Root'), now)).task;
  const child = (await mutateNativeTask(owner, create('Child', root.id), now)).task;
  const grandchild = (await mutateNativeTask(owner, create('Grandchild', child.id), now)).task;
  expect(child).toMatchObject({ parentId: root.id }); expect(child.proposed).toBeUndefined();
  expect(grandchild).toMatchObject({ parentId: child.id });
  const detail = await getNativeTask(owner, grandchild.id, {}, now);
  expect(detail.ancestors).toEqual([{ id: root.id, title: 'Root' }, { id: child.id, title: 'Child' }]);
  expect((await getNativeTask(owner, root.id, {}, now)).subtasks).toEqual([expect.objectContaining({ id: child.id, parentId: root.id })]);
  expect((await listNativeTaskSummaries(owner, { parentId: child.id }, now)).tasks.map(t => t.id)).toEqual([grandchild.id]);
  await expect(mutateNativeTask(owner, create('Orphan', 'task_missing'), now)).rejects.toMatchObject({ code: 'not_found' });
}));

test('an agent subtask is a proposal until an owner accepts it, and agents nest two levels', async () => scope(async () => {
  const f = await fixture(), owner = f.persons[0], member = f.persons[1], agent = f.actors[0];
  const root = (await mutateNativeTask(owner, create('Root'), now)).task;
  const proposal = (await mutateNativeTask(agent, create('Split part', root.id), now)).task;
  expect(proposal).toMatchObject({ parentId: root.id, proposed: true, status: 'backlog' });
  await expect(mutateNativeTask(agent, op('claim', proposal), now)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(mutateNativeTask(owner, op('assign', proposal, { assignedAgentId: f.agents[0].agentId }), now)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(mutateNativeTask(agent, create('Under a proposal', proposal.id), now)).rejects.toMatchObject({ code: 'bad_input' });
  expect((await getNativeTask(owner, proposal.id, {}, now)).permissions).toMatchObject({ review: true, control: false, assign: 'none' });
  expect((await getNativeTask(member, proposal.id, {}, now)).permissions.review).toBe(false);
  await expect(mutateNativeTask(member, op('review_proposal', proposal, { accept: true }), now)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(mutateNativeTask(agent, op('review_proposal', proposal, { accept: true }), now)).rejects.toMatchObject({ code: 'forbidden' });
  const accepted = (await mutateNativeTask(owner, op('review_proposal', proposal, { accept: true }), now)).task;
  expect(accepted.proposed).toBeUndefined(); expect(accepted.status).toBe('backlog');
  expect((await mutateNativeTask(agent, op('claim', accepted), now)).task.status).toBe('in_progress');
  // An agent's subtask of a subtask is attached one level up, under the top-level task.
  const lifted = (await mutateNativeTask(agent, create('Too deep', accepted.id), now)).task;
  expect(lifted).toMatchObject({ parentId: root.id, proposed: true });
  // People nest deeper, and an agent request under that deeper task is lifted too.
  const peopleChild = (await mutateNativeTask(owner, create('Person level 3', accepted.id), now)).task;
  expect(peopleChild.parentId).toBe(accepted.id);
  expect((await mutateNativeTask(agent, create('Also too deep', peopleChild.id), now)).task.parentId).toBe(root.id);
  const declined = (await mutateNativeTask(owner, op('review_proposal', lifted, { accept: false }), now)).task;
  expect(declined).toMatchObject({ status: 'canceled' }); expect(declined.proposed).toBeUndefined();
}));

test('the parent agent hears once when its last open subtask closes; the parent status stays its own', async () => scope(async () => {
  const f = await fixture(), owner = f.persons[0], fox = f.actors[1];
  let root = (await mutateNativeTask(owner, create('Root'), now)).task;
  root = (await mutateNativeTask(owner, op('assign', root, { assignedAgentId: f.agents[0].agentId }), now)).task;
  let a = (await mutateNativeTask(owner, create('A', root.id), now)).task;
  let b = (await mutateNativeTask(owner, create('B', root.id), now)).task;
  await mutateNativeTask(fox, create('Pending proposal', root.id), now);
  a = (await mutateNativeTask(fox, op('claim', a), now)).task;
  b = (await mutateNativeTask(fox, op('claim', b), now)).task;
  const before = (await readUpdates(f.agents[0].agentId, undefined, now)).items.filter(item => item.kind === 'task_children_closed');
  expect(before).toHaveLength(0);
  await mutateNativeTask(fox, op('update', a, { status: 'done' }), now);
  expect((await readUpdates(f.agents[0].agentId, undefined, now)).items.filter(item => item.kind === 'task_children_closed')).toHaveLength(0);
  await mutateNativeTask(fox, op('update', b, { status: 'canceled' }), now);
  const items = (await readUpdates(f.agents[0].agentId, undefined, now)).items.filter(item => item.kind === 'task_children_closed');
  expect(items).toHaveLength(1);
  expect(items[0].payload).toMatchObject({ type: 'task_children_closed', taskId: root.id });
  expect(JSON.stringify(items[0].payload.title)).toContain('Root');
  expect((await getNativeTask(owner, root.id, {}, now)).task.status).toBe('backlog');
}));
