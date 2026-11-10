import { beforeEach, expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const T = 10_000_000;
const scoped = (work: () => Promise<void>) => () => inProject(TEST_PROJECT, work);
async function pair() {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test' }],
    agents: [{ person: 0, name: 'sender' }, { person: 0, name: 'recipient' }] });
  return { sender: await loadAgent(f.agents[0].agentId), recipient: f.agents[1].agentId };
}

test('message length counts characters, not UTF-16 code units', scoped(async () => {
  const { sender, recipient } = await pair();
  const emoji = '🙂'.repeat(2000);
  const sent = await sendMessageV2(sender, { to: [recipient], body: emoji, clientId: 'emoji-limit' }, () => T);
  expect(sent.message.body).toBe(emoji);
  await expect(sendMessageV2(sender, { to: [recipient], body: emoji + '🙂', clientId: 'emoji-over' }, () => T + 10_000))
    .rejects.toMatchObject({ code: 'too_long', message: expect.stringContaining('This one has 2001.') });
  await expect(sendMessageV2(sender, { to: [recipient], body: 'a'.repeat(2001), clientId: 'ascii-over' }, () => T + 20_000))
    .rejects.toMatchObject({ code: 'too_long' });
}));
