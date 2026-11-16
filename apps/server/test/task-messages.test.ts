import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { inProject, profiles, type Profile, type WithId } from '../src/firestore.js';
import { mutateNativeTask } from '../src/projects/native-tasks.js';
import { readConversations, readThread } from '../src/view/conversations.js';
import { communicationTraffic } from '../src/view/communication.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

const now = () => 5000;
beforeEach(resetEmulator);
const person = async (id: string): Promise<WithId<Profile>> => ({ id, ...(await profiles.doc(id).get()).data()! });

test('a person’s message with a new or assigned task is listed in Conversations with its task', async () => {
  const { personIds, agents } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }, { name: 'Other', email: 'other@example.test' }],
    agents: [{ person: 0, name: 'first' }, { person: 0, name: 'second' }, { person: 1, name: 'theirs' }] });
  const owner = await person(personIds[0]), own = [agents[0].agentId, agents[1].agentId];
  await inProject(TEST_PROJECT, async () => {
    const created = await mutateNativeTask({ kind: 'person', person: owner }, { clientRequestId: randomUUID(), operation: 'create', title: 'Shoot stuff', message: 'Please take a look.' }, now);
    const quiet = await mutateNativeTask({ kind: 'person', person: owner }, { clientRequestId: randomUUID(), operation: 'create', title: 'No message' }, now);
    await mutateNativeTask({ kind: 'person', person: owner }, { clientRequestId: randomUUID(), operation: 'assign', taskId: quiet.task.id, expectedRevision: quiet.task.revision, assignedAgentId: own[1], message: 'This one is yours.' }, () => 6000);

    const { conversations } = await readConversations(undefined, now);
    expect(conversations.map(c => [c.first?.body, c.first?.task, c.count])).toEqual([
      ['This one is yours.', { id: quiet.task.id, title: 'No message' }, 1],
      ['Please take a look.', { id: created.task.id, title: 'Shoot stuff' }, 1],
    ]);
    const first = conversations[1].first!;
    expect(first.sender).toMatchObject({ id: owner.id, name: 'Owner', kind: 'person' });
    expect(first.audience.kind === 'direct' && first.audience.to.map(agent => agent.id).sort()).toEqual([...own].sort());
    expect(conversations[0].first!.audience).toMatchObject({ kind: 'direct', to: [{ id: own[1] }] });
    expect((await readThread(first.threadId, {}, now)).messages.map(m => m.task?.id)).toEqual([created.task.id]);

    // "Me + my agents" keeps the entry for its author and hides it from another member.
    expect((await readConversations(undefined, now, owner.id)).conversations).toHaveLength(2);
    expect((await readConversations(undefined, now, personIds[1])).conversations).toHaveLength(0);
    expect((await communicationTraffic({}, 7000)).traffic.map(row => row.agentId)).toEqual([`person:${owner.id}`, `person:${owner.id}`]);
  });
});
