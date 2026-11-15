import { randomUUID } from 'node:crypto';
// Optional native tasks (owner decision, default ON): independent reviewer regressions. Settings authority,
// stale/retry, OFF keeps reads and refuses every task write (including receipt replay) without writes,
// re-enable keeps assignment/history, unlinked checkpoints continue, and toggling never touches agents.
import { beforeEach, expect, test } from 'vitest';
import { nativeTasksEnabled } from '@minions/contracts';
import { agents, inProject, profiles } from '../src/firestore.js';
import { configureWorkspace, controlWorkspace } from '../src/projects/store.js';
import { getNativeTask, listNativeTasks, mutateNativeTask, nativeTasks } from '../src/projects/native-tasks.js';
import { readNativeTaskSettings, saveNativeTaskSettings } from '../src/projects/native-task-settings.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';
import { startRun } from '../src/v2/runs.js';
import { addAgent, loadAgent, resetEmulator, seed, seedApprovedProject, setTestMembership } from './helpers.js';

const A = 'a'.repeat(64), now = () => 1000;
const governance = { openDirections: ['owner', 'moderator', 'member'] as const, approveOutcomes: ['owner', 'moderator'] as const, outcome: 'approval_required' as const };
beforeEach(resetEmulator);

async function fixture() {
  const s = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }, { name: 'Member', email: 'member@example.com' }] });
  const [owner, member] = await Promise.all(s.personIds.map(async id => ({ id, ...(await profiles.doc(id).get()).data()! })));
  await seedApprovedProject(A, { definition: { title: 'Library', goal: 'Work together', beneficiaries: 'Neighbors', output: 'A useful project', scope: 'One result', acceptanceCriteria: 'Reviewed', sources: null, resources: null, mergeApproval: 'humans' }, ownerProfileId: owner.id, reviewerProfileId: owner.id, submittedRevision: 2, approvedAt: 1, required: false });
  const setup = { client_request_id: 'setup', expected_revision: 0, repoUrl: 'https://github.com/example/library', governance: { ...governance, openDirections: [...governance.openDirections], approveOutcomes: [...governance.approveOutcomes] } };
  await configureWorkspace(owner, A, setup, now);
  await controlWorkspace(owner, A, { client_request_id: 'start', expected_revision: 1, action: 'start' }, now);
  await setTestMembership(A, member.id);
  const agent = await inProject(A, async () => {
    const added = await addAgent(member.id, 'member-bot', now);
    const run = await startRun(added.agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now);
    return { kind: 'agent', agent: await loadAgent(added.agentId), runId: run.run_id } as ProgressActor;
  });
  return { owner, member, agent };
}
const person = (p: { id: string }): ProgressActor => ({ kind: 'person', person: p as never });
const mutate = (actor: ProgressActor, input: Record<string, unknown>) => inProject(A, () => mutateNativeTask(actor, { clientRequestId: randomUUID(), ...input }, now));
const settings = (profileId: string) => inProject(A, () => readNativeTaskSettings(profileId));
const save = (profileId: string, input: Record<string, unknown>) => inProject(A, () => saveNativeTaskSettings(profileId, { clientRequestId: randomUUID(), ...input }, now));
const stored = (id: string) => inProject(A, async () => (await nativeTasks().doc(id).get()).data()!);

test('the shared helper and a project without a stored setting both mean enabled', async () => {
  expect([nativeTasksEnabled(undefined), nativeTasksEnabled(null), nativeTasksEnabled({}), nativeTasksEnabled({ enabled: true }), nativeTasksEnabled({ enabled: false })])
    .toEqual([true, true, true, true, false]);
  const { member } = await fixture();
  expect(await settings(member.id)).toMatchObject({ enabled: true, revision: 0 });
});

test('only the owner can switch tasks; stale revisions conflict and a same-ID retry is stable', async () => {
  const { owner, member } = await fixture();
  await expect(save(member.id, { expectedRevision: 0, enabled: false })).rejects.toMatchObject({ code: 'forbidden' });
  const input = { clientRequestId: randomUUID(), expectedRevision: 0, enabled: false };
  const first = await inProject(A, () => saveNativeTaskSettings(owner.id, input, now));
  expect(first).toMatchObject({ enabled: false, revision: 1 });
  expect(await inProject(A, () => saveNativeTaskSettings(owner.id, input, now))).toMatchObject({ enabled: false, revision: 1 });
  await expect(save(owner.id, { expectedRevision: 0, enabled: true })).rejects.toMatchObject({ code: expect.stringMatching(/conflict/) });
  expect(await settings(member.id)).toMatchObject({ enabled: false, revision: 1 });
});

test('with tasks OFF, reads continue and every write, including an earlier receipt replay, is refused without writes', async () => {
  const { owner, member, agent } = await fixture();
  const createInput = { clientRequestId: randomUUID(), operation: 'create', title: 'Kept' };
  const { task } = await inProject(A, () => mutateNativeTask(person(member), createInput, now));
  await save(owner.id, { expectedRevision: 0, enabled: false });
  expect((await inProject(A, () => listNativeTasks(person(member), {}, now))).tasks.map(t => t.id)).toEqual([task.id]);
  expect((await inProject(A, () => getNativeTask(person(member), task.id, {}, now))).task.title).toBe('Kept');
  const refused = { code: 'tasks_disabled' };
  await expect(inProject(A, () => mutateNativeTask(person(member), createInput, now))).rejects.toMatchObject(refused);
  await expect(mutate(person(member), { operation: 'create', title: 'New' })).rejects.toMatchObject(refused);
  await expect(mutate(agent, { operation: 'claim', taskId: task.id, expectedRevision: 1 })).rejects.toMatchObject(refused);
  await expect(mutate(person(owner), { operation: 'comment', taskId: task.id, expectedRevision: 1, body: 'x' })).rejects.toMatchObject(refused);
  expect(await stored(task.id)).toMatchObject({ revision: 1, assignedAgentId: null, status: 'backlog' });
  expect((await inProject(A, () => nativeTasks().get())).size).toBe(1);
});

test('re-enabling keeps assignment and history, and toggling never changes any agent record', async () => {
  const { owner, member, agent } = await fixture();
  const { task } = await mutate(person(member), { operation: 'create', title: 'Survives' });
  await mutate(agent, { operation: 'claim', taskId: task.id, expectedRevision: 1 });
  const agentsBefore = await inProject(A, async () => (await agents().get()).docs.map(d => [d.id, d.data()]));
  await save(owner.id, { expectedRevision: 0, enabled: false });
  await save(owner.id, { expectedRevision: 1, enabled: true });
  expect(await inProject(A, async () => (await agents().get()).docs.map(d => [d.id, d.data()]))).toEqual(agentsBefore);
  const detail = await inProject(A, () => getNativeTask(person(member), task.id, {}, now));
  expect(detail.task).toMatchObject({ status: 'in_progress', revision: 2 });
  expect(detail.activity.map(e => e.action)).toEqual(['create', 'claim']);
  expect((await mutate(agent, { operation: 'update', taskId: task.id, expectedRevision: 2, status: 'done' })).task.status).toBe('done');
});
