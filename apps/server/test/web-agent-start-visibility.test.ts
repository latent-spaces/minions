import { beforeEach, expect, test } from 'vitest';
import { db, inProject } from '../src/firestore.js';
import { latestAgentRun, projectQueuedStarts, queuedStarts, webAgentStarts, type WebAgentStart } from '../src/owner/web-agent-starts.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

const at = 2_000_000_000_000;
let owner: string;
beforeEach(async () => {
  await resetEmulator();
  owner = (await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }] })).personIds[0];
});
function pending(id: string, changes: Partial<WebAgentStart> = {}): WebAgentStart {
  return { id, profileId: owner, projectId: TEST_PROJECT, connectionId: 'computer', name: id,
    scope: 'Synthetic visibility test', execution: { provider: 'codex', model: null },
    fingerprint: 'synthetic', incarnation: null, state: 'pending', createdAt: at - 100,
    activeUntil: at + 1000, pickupByAt: at + 1000, acceptedAt: null, launchByAt: null,
    agentId: null, ...changes };
}
const ownQueue = () => inProject(TEST_PROJECT, () => db.runTransaction(tx => queuedStarts(tx, owner, TEST_PROJECT, at)));

test('expired pending requests cannot hide a live request from either queued-agent list', async () => {
  const batch = db.batch();
  for (let i = 0; i < 20; i++) batch.set(webAgentStarts.doc(`a-${i}`), pending(`expired-${i}`, { pickupByAt: at, activeUntil: at }));
  batch.set(webAgentStarts.doc('z-live'), pending('live'));
  await batch.commit();
  expect((await ownQueue()).map(row => row.id)).toEqual(['live']);
  expect((await projectQueuedStarts(TEST_PROJECT, at)).map(row => row.name)).toEqual(['live']);
});

test('missed launch windows cannot hide a live starting request', async () => {
  const batch = db.batch();
  for (let i = 0; i < 20; i++) batch.set(webAgentStarts.doc(`a-${i}`), pending(`stale-${i}`, {
    state: 'accepted', acceptedAt: at - 200, launchByAt: at,
  }));
  batch.set(webAgentStarts.doc('z-live'), pending('live', { state: 'starting', launchByAt: at + 1000 }));
  await batch.commit();
  expect((await ownQueue()).map(row => row.id)).toEqual(['live']);
});

test('the latest agent run is selected by creation time across the full project history', async () => {
  const batch = db.batch();
  for (let i = 0; i < 20; i++) batch.set(webAgentStarts.doc(`a-${i}`), pending(`old-${i}`, {
    agentId: 'worker', state: 'failed', createdAt: at - 100 + i,
  }));
  batch.set(webAgentStarts.doc('z-latest'), pending('latest', { agentId: 'worker', state: 'working', createdAt: at }));
  batch.set(webAgentStarts.doc('other-project'), pending('other-project', { projectId: 'b'.repeat(64), agentId: 'worker', createdAt: at + 1 }));
  await batch.commit();
  const result = await inProject(TEST_PROJECT, () => db.runTransaction(tx => latestAgentRun(tx, owner, TEST_PROJECT, 'worker', at)));
  expect(result).toMatchObject({ id: 'latest', state: 'working' });
});

test('combining pending and starting windows keeps queue results bounded and scoped', async () => {
  const batch = db.batch();
  for (let i = 0; i < 25; i++) {
    batch.set(webAgentStarts.doc(`pending-${i}`), pending(`pending-${i}`));
    batch.set(webAgentStarts.doc(`starting-${i}`), pending(`starting-${i}`, { state: 'starting', launchByAt: at + 1000 }));
  }
  batch.set(webAgentStarts.doc('a-other'), pending('other', { profileId: 'other' }));
  batch.set(webAgentStarts.doc('a-project'), pending('other-project', { projectId: 'b'.repeat(64) }));
  await batch.commit();
  const queue = await ownQueue();
  expect(queue).toHaveLength(20);
  expect(queue.every(row => row.id.startsWith('pending-') || row.id.startsWith('starting-'))).toBe(true);
  expect(await projectQueuedStarts(TEST_PROJECT, at)).toHaveLength(20);
});
