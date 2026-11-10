import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles } from '../src/firestore.js';
import { getNativeTask, listNativeTasks, mutateNativeTask } from '../src/projects/native-tasks.js';
import { saveNativeTaskSettings } from '../src/projects/native-task-settings.js';
import { conversationEntries } from '../src/projects/steering.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

test('a labelled deleted source stays hidden in history and replay across OFF/ON without another mutation', async () => inProject(TEST_PROJECT, async () => {
  const { personIds } = await seed({ profiles: [{ name: 'Admin', email: 'label-review@example.test', role: 'owner' }] });
  const id = personIds[0], actor = { kind: 'person' as const, person: { id, ...(await profiles.doc(id).get()).data()! } };
  const now = () => 1000;
  const { task } = await mutateNativeTask(actor, { operation: 'create', title: 'Source visibility', clientRequestId: randomUUID() }, now);
  const sourceId = 'labelled-shared-source';
  await conversationEntries().doc(sourceId).set({ kind: 'agent_message', id: sourceId, threadId: sourceId,
    body: 'Shared source', agentId: 'test-agent', agentName: 'Test', to: [], audience: 'project', createdAt: 1000, protocol: 2 });
  const input = { operation: 'add_reference', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(),
    reference: { id: 'source-link', kind: 'conversation', sourceId, label: 'Sensitive relationship label' } };
  const linked = await mutateNativeTask(actor, input, now);
  expect(await mutateNativeTask(actor, input, now)).toEqual({ ...linked, replayed: true });
  const original = await getNativeTask(actor, task.id, {}, now);
  const event = original.activity.find(row => row.action === 'add_reference')!;

  await conversationEntries().doc(sourceId).delete();
  await saveNativeTaskSettings(id, { enabled: false, expectedRevision: 0, clientRequestId: randomUUID() }, now);
  await expect(mutateNativeTask(actor, input, now)).rejects.toMatchObject({ code: 'tasks_disabled' });
  for (const result of [await getNativeTask(actor, task.id, {}, now),
    await getNativeTask(actor, task.id, { activityId: event.id }, now), await listNativeTasks(actor, {}, now)]) {
    expect(JSON.stringify(result)).not.toContain(input.reference.label);
    expect(JSON.stringify(result)).not.toContain(sourceId);
  }
  await saveNativeTaskSettings(id, { enabled: true, expectedRevision: 1, clientRequestId: randomUUID() }, now);
  const replay = await mutateNativeTask(actor, input, now);
  expect(replay.replayed).toBe(true);
  expect(replay.task).toMatchObject({ revision: 2, references: [], referenceAuthors: {}, status: 'backlog' });
  expect(JSON.stringify(replay)).not.toContain(input.reference.label);
  const final = await getNativeTask(actor, task.id, {}, now);
  expect(final.activity).toHaveLength(2);
  expect(final.task.assignedAgentId).toBeNull();
}));
