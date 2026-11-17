import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import type { NativeTask } from '@minions/contracts';
import { inProject, profiles } from '../src/firestore.js';
import { getNativeTask, mutateNativeTask, nativeTasks } from '../src/projects/native-tasks.js';
import { inboxItems } from '../src/v2/records.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

async function fixture() {
  const { personIds, agents } = await seed({
    profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }],
    agents: [{ person: 0, name: 'parent-owner' }],
  });
  const actor = { kind: 'person' as const, person: { id: personIds[0], ...(await profiles.doc(personIds[0]).get()).data()! } };
  const parent: NativeTask = {
    id: 'parent', projectId: TEST_PROJECT, title: 'Parent', description: '', status: 'in_progress',
    assignedAgentId: agents[0].agentId, contributors: [], priority: 'normal', references: [],
    createdBy: { kind: 'person', id: personIds[0] }, titleAuthor: { kind: 'person', id: personIds[0] },
    createdAt: 0, updatedAt: 0, revision: 1,
  };
  await nativeTasks().doc(parent.id).set(parent);
  for (let i = 0; i < 101; i++) {
    const id = `child-${String(i).padStart(3, '0')}`;
    await nativeTasks().doc(id).set({ ...parent, id, parentId: parent.id, title: id,
      status: i === 0 || i === 100 ? 'in_progress' : 'done', createdAt: 101 - i });
  }
  return { actor, parent, agentId: agents[0].agentId };
}

test('the 100 detail subtasks are selected oldest first before limiting', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { actor, parent } = await fixture();
    const detail = await getNativeTask(actor, parent.id);
    expect(detail.subtasks?.map(task => task.id)).toEqual(
      Array.from({ length: 100 }, (_, i) => `child-${String(100 - i).padStart(3, '0')}`),
    );
    expect(detail.task.subtaskProgress).toEqual({ done: 99, total: 101 });
  });
});

test('closing a child checks every accepted sibling before notifying the parent agent', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { actor, parent, agentId } = await fixture();
    // A pending proposal does not count as an open accepted child.
    await nativeTasks().doc('proposal').set({ ...parent, id: 'proposal', parentId: parent.id,
      status: 'backlog', assignedAgentId: null, proposed: true });
    const close = (taskId: string) => mutateNativeTask(actor, {
      operation: 'update', clientRequestId: randomUUID(), taskId, expectedRevision: 1, status: 'done',
    });
    await close('child-000');
    expect((await inboxItems(agentId).where('kind', '==', 'task_children_closed').get()).size).toBe(0);
    await close('child-100');
    const notices = await inboxItems(agentId).where('kind', '==', 'task_children_closed').get();
    expect(notices.size).toBe(1);
    expect(notices.docs[0].data().payload).toMatchObject({ taskId: parent.id });
  });
});
