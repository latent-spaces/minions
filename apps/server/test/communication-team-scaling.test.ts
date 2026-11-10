import { beforeEach, expect, test } from 'vitest';
import { agents, db, inProject } from '../src/firestore.js';
import { communicationUsageDoc } from '../src/projects/communication.js';
import { sendMessageV2 } from '../src/v2/messages.js';
import { messagesV2 } from '../src/v2/records.js';
import { addAgent, loadAgent, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const T = 10_000_000, HOUR = 3_600_000;
const scoped = (work: () => Promise<void>) => () => inProject(TEST_PROJECT, work);
async function fixture(count = 3) {
  const f = await seed({ profiles: [
    { name: 'Admin', email: 'admin@example.test' },
    { name: 'Peer', email: 'peer@example.test' },
  ], agents: Array.from({ length: count }, (_, i) => ({ person: i === 0 ? 0 : 1, name: `agent-${i}` })) });
  return { ...f, rows: await Promise.all(f.agents.map(a => loadAgent(a.agentId))) };
}
async function history(count: number, at: number) {
  const batch = db.batch();
  for (let i = 0; i < count; i++) {
    const id = `history-${i}`;
    batch.set(messagesV2().doc(id), { id, agentId: 'former-sender', agentName: 'Recorded sender',
      threadId: id, body: 'Earlier broadcast', to: ['project'], audience: 'project', createdAt: at + i, protocol: 2 });
  }
  await batch.commit();
}
const send = (agent: Awaited<ReturnType<typeof loadAgent>>, clientId: string, at = T) =>
  sendMessageV2(agent, { to: ['project'], body: 'Current broadcast', clientId }, () => at);

test('roster shrink and later growth preserve shared usage until its actual expiry', scoped(async () => {
  const f = await fixture(3);
  const times = Array.from({ length: 13 }, (_, i) => T - HOUR + 10_000 + i);
  await communicationUsageDoc().set({ recentBroadcasts: times });
  await agents().doc(f.rows[2].id).update({ revokedAt: T });
  await expect(send(f.rows[0], 'shrunk')).rejects.toMatchObject({ code: 'rate_limited' });
  expect((await communicationUsageDoc().get()).data()?.recentBroadcasts).toEqual(times);
  await addAgent(f.personIds[1], 'Replacement', () => T);
  expect((await send(f.rows[0], 'grown')).duplicate).toBe(false);
  expect((await communicationUsageDoc().get()).data()?.recentBroadcasts).toHaveLength(14);
  await send(f.rows[0], 'after-expiry', T + HOUR);
  expect((await communicationUsageDoc().get()).data()?.recentBroadcasts).toEqual([T + HOUR]);
}));

test('concurrent first broadcasts share the same durable admission counter', scoped(async () => {
  const f = await fixture(2);
  await history(11, T - 60_000);
  const outcomes = await Promise.allSettled([send(f.rows[0], 'race-a'), send(f.rows[1], 'race-b')]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const refused = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(['rate_limited', 'project_busy']).toContain(refused.reason.code);
  expect((await communicationUsageDoc().get()).data()?.recentBroadcasts).toHaveLength(12);
}));
