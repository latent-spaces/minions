import { beforeEach, expect, test } from 'vitest';
import { db, inProject } from '../src/firestore.js';
import { readThreadPage } from '../src/v2/messages.js';
import { encodeCursor } from '../src/cursor.js';
import { conversationEntries } from '../src/projects/steering.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const scoped = (work: () => Promise<void>) => () => inProject(TEST_PROJECT, work);
async function thread(root: string, count: number) {
  const batch = db.batch();
  for (let i = 0; i < count; i++) {
    const id = i === 0 ? root : `${root}-${i}`;
    batch.set(conversationEntries().doc(id), { kind:'agent_message', id, agentId: 'sender', agentName: 'Sender', threadId: root,
      body: `Message ${i}`, to: ['project'], audience: 'project', createdAt: 1_000 + i, protocol: 2 });
  }
  await batch.commit();
}

test('read_thread cursors page one thread and refuse malformed or foreign cursors', scoped(async () => {
  await seed();
  await thread('alpha', 55);
  await thread('beta', 2);
  const first = await readThreadPage('alpha');
  expect(first.messages).toHaveLength(50);
  expect(first.next).not.toBeNull();
  const second = await readThreadPage('alpha', first.next!);
  expect(second.messages.map(m => m.id)).toEqual(['alpha-50', 'alpha-51', 'alpha-52', 'alpha-53', 'alpha-54']);
  expect(second.next).toBeNull();
  await expect(readThreadPage('beta', first.next!)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(readThreadPage('alpha', encodeCursor(['alpha', 1_049, 'alpha-49', 'extra']))).rejects.toMatchObject({ code: 'bad_input' });
  await expect(readThreadPage('alpha', encodeCursor([1_049, 'alpha-49']))).rejects.toMatchObject({ code: 'bad_input' });
  await expect(readThreadPage('alpha', encodeCursor(['alpha', 1_049, 'other/doc']))).rejects.toMatchObject({ code: 'bad_input' });
  await expect(readThreadPage('alpha', encodeCursor(['alpha', 1.5, 'alpha-49']))).rejects.toMatchObject({ code: 'bad_input' });
}));
