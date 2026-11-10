import { beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, inProject, profiles } from '../src/firestore.js';
import { projects } from '../src/projects/records.js';
import { controlWorkspace } from '../src/projects/store.js';
import { runs } from '../src/v2/records.js';
import { webAgentStarts } from '../src/owner/web-agent-starts.js';
import { saveWorkSettings } from '../src/onboarding/store.js';
import { saveAgentPersona, readAgentPersona } from '../src/projects/agent-participation.js';
import { listMyWorkers } from '../src/projects/worker-sessions.js';
import { startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);

// A closed project is read-only: agents can't be configured or started, and the website is told to hide their controls.
test('a closed project refuses agent work and settings, and says it is closed', async () => {
  const x = await seed({ profiles: [{ name: 'Dana', email: 'd@example.test' }], agents: [{ person: 0, name: 'Owl' }] });
  const [person] = x.personIds, agentId = x.agents[0].agentId;
  await scope(() => saveWorkSettings(person, agentId, { involvement: 'on_own' }));
  await seedRuntime(TEST_PROJECT, { completedAt: 1, paused: true });
  await expect(scope(() => saveWorkSettings(person, agentId, { involvement: 'with_me' }))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(scope(() => saveAgentPersona(person, agentId, { text: 'New', expectedRevision: 0 }, () => 1))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => 1))).rejects.toMatchObject({ code: 'forbidden' });
  expect((await scope(() => readAgentPersona(person, agentId))).canEditPersona).toBe(false);
  expect((await scope(() => listMyWorkers(person, () => 1))).projectClosed).toBe(true);
});

test('closing ends chat sessions and cancels queued runs', async () => {
  const x = await seed({ profiles: [{ name: 'Owner', email: 'o@example.test' }], agents: [{ person: 0, name: 'Fox' }] });
  const [owner] = x.personIds, agentId = x.agents[0].agentId;
  await projects.doc(TEST_PROJECT).update({ ownerProfileId: owner });
  await scope(() => runs().doc(agentId).set({ runId: 'chat', generation: 1, runnerVersion: 't', startedAt: 1, endedAt: null, endReason: null, protocol: 2, mode: 'current_chat', approvedAt: 1, deadlineAt: 9e12 } as never));
  await webAgentStarts.doc('queued').set({ projectId: TEST_PROJECT, state: 'pending' } as never);
  const person = { id: owner, ...(await profiles.doc(owner).get()).data()! };
  const revision = (await projects.doc(TEST_PROJECT).get()).data()!.revision;
  await controlWorkspace(person as never, TEST_PROJECT, { client_request_id: 'close-1', expected_revision: revision, action: 'close' }, () => 5000);
  expect((await scope(() => runs().doc(agentId).get())).data()).toMatchObject({ endedAt: 5000, endReason: 'project_closed' });
  expect((await webAgentStarts.doc('queued').get()).data()).toMatchObject({ state: 'expired', code: 'cancelled' });
});

async function closeFixture() {
  const { personIds: [owner] } = await seed({ profiles: [{ name: 'Owner', email: 'close-owner@example.test' }] });
  await projects.doc(TEST_PROJECT).update({ ownerProfileId: owner });
  const person = { id: owner, ...(await profiles.doc(owner).get()).data()! };
  const revision = (await projects.doc(TEST_PROJECT).get()).data()!.revision;
  return { person, close: { client_request_id: 'recover-close', expected_revision: revision, action: 'close' as const } };
}
const chatRun = () => ({ runId: 'chat', generation: 1, runnerVersion: 'synthetic', startedAt: 1,
  endedAt: null, endReason: null, protocol: 2, mode: 'current_chat', approvedAt: 1, deadlineAt: 9e12 });

test('close drains every page without background runs starving chat cleanup or crossing project boundaries', async () => {
  const { person, close } = await closeFixture();
  const { mode: _, ...backgroundRun } = chatRun();
  // Background IDs sort before chats, filling the old live-run query's entire first page.
  const writes = [
    ...Array.from({ length: 500 }, (_, i) => ({ ref: scope(() => runs().doc(`a-background-${i}`)), body: backgroundRun })),
    ...Array.from({ length: 201 }, (_, i) => ({ ref: scope(() => runs().doc(`z-chat-${i}`)), body: chatRun() })),
    ...Array.from({ length: 201 }, (_, i) => ({ ref: webAgentStarts.doc(`queued-${i}`), body: { projectId: TEST_PROJECT, state: 'pending' } })),
    { ref: webAgentStarts.doc('other-project'), body: { projectId: 'f'.repeat(64), state: 'pending' } },
  ];
  for (let offset = 0; offset < writes.length; offset += 200) {
    const batch = db.batch();
    for (const { ref, body } of writes.slice(offset, offset + 200)) batch.set(db.doc(ref.path), body);
    await batch.commit();
  }
  await controlWorkspace(person, TEST_PROJECT, close, () => 5000);
  const allRuns = await scope(() => runs().get());
  expect(allRuns.docs.filter(doc => doc.data().mode === 'current_chat').every(doc => doc.data().endedAt === 5000)).toBe(true);
  expect(allRuns.docs.filter(doc => doc.id.startsWith('a-background')).every(doc => doc.data().endedAt === null)).toBe(true);
  expect((await webAgentStarts.where('projectId', '==', TEST_PROJECT).where('state', '==', 'pending').get()).empty).toBe(true);
  expect((await webAgentStarts.doc('other-project').get()).data()).toMatchObject({ state: 'pending' });
}, 30_000);

test('replaying Close repairs unfinished cleanup but never ends work after Reopen or a later Close', async () => {
  const { person, close } = await closeFixture();
  const result = await controlWorkspace(person, TEST_PROJECT, close, () => 5000);
  const chat = scope(() => runs().doc('late-chat')), queued = webAgentStarts.doc('late-queued');
  // Stand in for records left behind when the post-commit cleanup failed.
  await chat.set(chatRun() as never);
  await queued.set({ projectId: TEST_PROJECT, state: 'pending' } as never);
  expect(await controlWorkspace(person, TEST_PROJECT, close, () => 6000)).toMatchObject({ replayed: true, revision: result.revision });
  expect((await chat.get()).data()).toMatchObject({ endedAt: 6000, endReason: 'project_closed' });
  expect((await queued.get()).data()).toMatchObject({ state: 'expired', code: 'cancelled' });

  const reopened = await controlWorkspace(person, TEST_PROJECT,
    { action: 'reopen', client_request_id: 'reopen-after-close', expected_revision: result.revision }, () => 7000);
  await chat.set({ ...chatRun(), runId: 'new-chat', generation: 2 } as never);
  await queued.set({ projectId: TEST_PROJECT, state: 'pending' } as never);
  await controlWorkspace(person, TEST_PROJECT, close, () => 8000);
  expect((await chat.get()).data()).toMatchObject({ runId: 'new-chat', endedAt: null });
  expect((await queued.get()).data()).toMatchObject({ state: 'pending' });

  await controlWorkspace(person, TEST_PROJECT,
    { action: 'close', client_request_id: 'close-again', expected_revision: reopened.revision }, () => 9000);
  await queued.set({ projectId: TEST_PROJECT, state: 'pending' } as never);
  await controlWorkspace(person, TEST_PROJECT, close, () => 10000);
  expect((await queued.get()).data()).toMatchObject({ state: 'pending' });
});
