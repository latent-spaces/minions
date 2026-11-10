import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const T = 10_000_000;
const scoped = (work: () => Promise<void>) => () => inProject(TEST_PROJECT, work);

test('reusing a client_message_id for a different message is refused, an identical retry is not', scoped(async () => {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test' }],
    agents: [{ person: 0, name: 'sender' }, { person: 0, name: 'first' }, { person: 0, name: 'second' }] });
  const sender = await loadAgent(f.agents[0].agentId);
  const [a, b] = [f.agents[1].agentId, f.agents[2].agentId];
  let at = T;
  const send = (input: { to: string[], body: string, summary?: string, threadId?: string, clientId: string }) =>
    sendMessageV2(sender, input, () => (at += 10_000));

  const root = await send({ to: [a, b], body: 'Status', summary: 'Short status', clientId: 'status' });
  expect(root.duplicate).toBe(false);
  // Recipient order and summary whitespace are not differences.
  expect(await send({ to: [b, a], body: 'Status', summary: ' Short status ', clientId: 'status' })).toEqual({ ...root, duplicate: true });
  for (const changed of [{ body: 'Status 2' }, { to: [a] }, { summary: 'Other' }]) {
    await expect(send({ to: [a, b], body: 'Status', summary: 'Short status', clientId: 'status', ...changed }))
      .rejects.toMatchObject({ code: 'intent_conflict' });
  }

  const reply = await send({ to: [a], body: 'Reply', threadId: root.message.id, clientId: 'reply' });
  const nested = await send({ to: [a], body: 'Nested', threadId: reply.message.id, clientId: 'nested' });
  // Any message of the same thread identifies it on a retry.
  expect((await send({ to: [a], body: 'Nested', threadId: root.message.id, clientId: 'nested' })).duplicate).toBe(true);
  await expect(send({ to: [a], body: 'Nested', clientId: 'nested' })).rejects.toMatchObject({ code: 'intent_conflict' });
  expect(nested.message.threadId).toBe(root.message.id);
}));
