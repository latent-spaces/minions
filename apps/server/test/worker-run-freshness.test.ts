import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { db, inProject } from '../src/firestore.js';
import { latestAgentRun, webAgentStarts, webStartKey, type WebAgentStart } from '../src/owner/web-agent-starts.js';
import { resetEmulator, TEST_PROJECT } from './helpers.js';

// list_working_agents (GET /my-workers) reads the agent's latest website start beside its current worker mission and
// stored run. The start's own lifecycle stops at 'working', so without these rules a start replaced by a newer mission,
// or one whose run already ended, kept reading 'working' while worker.session and lastRun said otherwise.
beforeEach(resetEmulator);
const profileId = 'owner-profile', agentId = 'agent-1';
async function seedStart(id: string, createdAt: number, state: WebAgentStart['state'] = 'working') {
  const row = { id, connectionId: randomUUID(), projectId: TEST_PROJECT, name: 'agent-1', scope: 'Work.',     execution: { provider: 'claude', model: null }, profileId, fingerprint: 'f', incarnation: randomUUID(), state,
    createdAt, activeUntil: createdAt + 3_600_000, pickupByAt: createdAt + 60_000, acceptedAt: createdAt, launchByAt: createdAt + 180_000,
    deadlineAt: createdAt + 3_600_000, agentId } as WebAgentStart;
  await webAgentStarts.doc(webStartKey(profileId, id)).set(row);
}
const read = (mission: { missionId: string; startedAt: number } | null, run: { runId: string; endedAt: number | null } | null) =>
  inProject(TEST_PROJECT, () => db.runTransaction(tx => latestAgentRun(tx, profileId, TEST_PROJECT, agentId, 10_000, mission, run)));

test('a working website start replaced by a newer mission reads superseded, not working', async () => {
  const start = randomUUID(), later = randomUUID();
  await seedStart(start, 1_000);
  expect((await read({ missionId: later, startedAt: 2_000 }, { runId: later, endedAt: null }))?.state).toBe('superseded');
  // An older mission than the start does not replace it.
  expect((await read({ missionId: later, startedAt: 500 }, null))?.state).toBe('working');
});

test('a working website start whose own run ended reads ended; a live one stays working', async () => {
  const start = randomUUID();
  await seedStart(start, 1_000);
  expect((await read({ missionId: start, startedAt: 1_000 }, { runId: start, endedAt: 5_000 }))?.state).toBe('ended');
  expect((await read({ missionId: start, startedAt: 1_000 }, { runId: start, endedAt: null }))?.state).toBe('working');
  // Another run's end says nothing about this start.
  expect((await read({ missionId: start, startedAt: 1_000 }, { runId: randomUUID(), endedAt: 5_000 }))?.state).toBe('working');
});

test('failed and pending starts keep their existing rules', async () => {
  const failed = randomUUID(), later = randomUUID();
  await seedStart(failed, 1_000, 'failed');
  expect((await read({ missionId: later, startedAt: 2_000 }, null))?.state).toBe('superseded');
  expect((await read(null, null))?.state).toBe('failed');
});
