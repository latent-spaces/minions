import { randomUUID } from 'node:crypto';
// Native tasks: independent reviewer acceptance tests (OPE-44). They exercise the real service and Firestore
// transactions in disposable emulators: agent-only atomic claims, idempotent retry, stale revisions, Backlog gating,
// cross-project/removed-member authority, private source links, PR-vs-Done and no execution side effects.
import { beforeEach, expect, test } from 'vitest';
import { agents, inProject, profiles } from '../src/firestore.js';
import { configureWorkspace, controlWorkspace } from '../src/projects/store.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { getNativeTask, listNativeTasks, mutateNativeTask, nativeTasks } from '../src/projects/native-tasks.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';
import { startRun } from '../src/v2/runs.js';
import { exportPerson } from '../src/store/person-export.js';
import { addAgent, loadAgent, resetEmulator, seed, seedApprovedProject, setTestMembership } from './helpers.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), now = () => 1000;
const governance = { openDirections: ['owner', 'moderator', 'member'] as const, approveOutcomes: ['owner', 'moderator'] as const, outcome: 'approval_required' as const };
const config = (id: string) => ({ client_request_id: id, expected_revision: 0, repoUrl: 'https://github.com/example/library', governance: { ...governance, openDirections: [...governance.openDirections], approveOutcomes: [...governance.approveOutcomes] } });
beforeEach(resetEmulator);

type Person = Awaited<ReturnType<typeof people>>[number];
async function people() {
  const s = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.com' }, { name: 'Member', email: 'member@example.com' }, { name: 'Other', email: 'other@example.com' }] });
  return Promise.all(s.personIds.map(async id => ({ id, ...(await profiles.doc(id).get()).data()! })));
}
async function agentWithRun(personId: string, name: string): Promise<ProgressActor & { kind: 'agent' }> {
  const added = await addAgent(personId, name, now);
  const run = await startRun(added.agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now);
  return { kind: 'agent', agent: await loadAgent(added.agentId), runId: run.run_id };
}
// Project A: owner + member, each with an agent. Project B: owner only, with its own agent.
async function fixture() {
  const [owner, member, other] = await people();
  for (const project of [A, B]) {
    await seedApprovedProject(project, { definition: { title: 'Library', goal: 'Work together', rules: 'One result', mergeApproval: 'humans' }, ownerProfileId: owner.id, reviewerProfileId: owner.id, submittedRevision: 2, approvedAt: 1, required: false });
    await configureWorkspace(owner, project, config('setup'), now);
    await controlWorkspace(owner, project, { client_request_id: 'start', expected_revision: 1, action: 'start' }, now);
  }
  await setTestMembership(A, member.id);
  const a = await inProject(A, async () => ({ ownerAgent: await agentWithRun(owner.id, 'owner-bot'), memberAgent: await agentWithRun(member.id, 'member-bot') }));
  const b = await inProject(B, async () => ({ ownerAgent: await agentWithRun(owner.id, 'b-bot') }));
  return { owner, member, other, a, b };
}
const person = (p: Person): ProgressActor => ({ kind: 'person', person: p as never });
const mutate = (project: string, actor: ProgressActor, input: Record<string, unknown>) =>
  inProject(project, () => mutateNativeTask(actor, { clientRequestId: randomUUID(), ...input }, now));
const activityOf = (project: string, actor: ProgressActor, taskId: string) => inProject(project, async () => (await getNativeTask(actor, taskId, {}, now)).activity);

test('a title-only task persists in Backlog with no assignee and is readable after a fresh read', async () => {
  const { member } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Write the announcement' });
  expect(task).toMatchObject({ status: 'backlog', assignedAgentId: null, revision: 1, description: '', contributors: [], references: [], createdBy: { kind: 'person', id: member.id } });
  const stored = await inProject(A, async () => (await nativeTasks().doc(task.id).get()).data());
  expect(stored).toEqual({ ...task, changedAt: expect.anything() });  // T2: plus the internal commit time
  expect((await inProject(A, () => listNativeTasks(person(member), {}, now))).tasks.map(t => t.id)).toEqual([task.id]);
});

test('two agents racing to claim the same task produce exactly one winner and one claim event', async () => {
  const { member, a } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Race' });
  const results = await Promise.allSettled([a.ownerAgent, a.memberAgent].map(agent =>
    mutate(A, agent, { operation: 'claim', taskId: task.id, expectedRevision: 1 })));
  const won = results.filter(r => r.status === 'fulfilled');
  expect(won).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'intent_conflict' } });
  const saved = await inProject(A, async () => (await nativeTasks().doc(task.id).get()).data()!);
  expect(saved.status).toBe('in_progress');
  expect([a.ownerAgent.agent.id, a.memberAgent.agent.id]).toContain(saved.assignedAgentId);
  expect((await activityOf(A, person(member), task.id)).map(e => e.action)).toEqual(['create', 'claim']);
});

test('a retried claim with the same request ID returns the same result and writes no second event; a changed payload is refused', async () => {
  const { member, a } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Retry' });
  const input = { clientRequestId: randomUUID(), operation: 'claim', taskId: task.id, expectedRevision: 1 };
  const first = await inProject(A, () => mutateNativeTask(a.memberAgent, input, now));
  const again = await inProject(A, () => mutateNativeTask(a.memberAgent, input, now));
  expect(again).toEqual({ ...first, replayed: true });
  expect((await activityOf(A, person(member), task.id))).toHaveLength(2);
  await expect(inProject(A, () => mutateNativeTask(a.memberAgent, { ...input, expectedRevision: 2 }, now))).rejects.toMatchObject({ code: 'intent_conflict' });
});

test('a stale revision is refused with a conflict and changes nothing', async () => {
  const { member, owner } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Stale', description: 'Done when the doc is shared.' });
  await mutate(A, person(owner), { operation: 'update', taskId: task.id, expectedRevision: 1, description: 'Owner edit' });
  await expect(mutate(A, person(member), { operation: 'update', taskId: task.id, expectedRevision: 1, description: 'Lost edit' }))
    .rejects.toMatchObject({ code: 'intent_conflict', message: expect.stringContaining('revision 2') });
  const saved = await inProject(A, async () => (await nativeTasks().doc(task.id).get()).data()!);
  expect(saved).toMatchObject({ description: 'Owner edit', revision: 2 });
});

test('a person cannot claim; an unassigned task cannot leave Backlog by status edit', async () => {
  const { owner, member } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Gate' });
  await expect(mutate(A, person(member), { operation: 'claim', taskId: task.id, expectedRevision: 1 })).rejects.toMatchObject({ code: 'forbidden' });
  for (const status of ['in_progress', 'done']) {
    await expect(mutate(A, person(owner), { operation: 'update', taskId: task.id, expectedRevision: 1, status })).rejects.toMatchObject({ code: 'bad_input' });
  }
  expect((await inProject(A, async () => (await nativeTasks().doc(task.id).get()).data()!)).status).toBe('backlog');
});

test('assignment accepts only a live agent of this project: person ids, other-project and revoked agents are refused', async () => {
  const { owner, member, b, a } = await fixture();
  const { task } = await mutate(A, person(owner), { operation: 'create', title: 'Assign' });
  const attempt = (assignedAgentId: string) => mutate(A, person(owner), { operation: 'assign', taskId: task.id, expectedRevision: 1, assignedAgentId });
  await expect(attempt(member.id)).rejects.toBeTruthy();
  await expect(attempt(b.ownerAgent.agent.id)).rejects.toBeTruthy();
  await inProject(A, () => revokeOwned(member.id, a.memberAgent.agent.id, now));
  await expect(attempt(a.memberAgent.agent.id)).rejects.toBeTruthy();
  await expect(mutate(A, person(owner), { operation: 'create', title: 'x', assignedAgentId: member.id })).rejects.toBeTruthy();
  expect((await inProject(A, async () => (await nativeTasks().doc(task.id).get()).data()!))).toMatchObject({ assignedAgentId: null, revision: 1 });
  const ok = await attempt(a.ownerAgent.agent.id);
  expect(ok.task).toMatchObject({ assignedAgentId: a.ownerAgent.agent.id, status: 'backlog' });
});

test('tasks are invisible and immutable across projects and to removed or non-members', async () => {
  const { owner, member, other, b } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Private to A' });
  // Same task id addressed inside project B: not found, and B's agent cannot claim it.
  await expect(inProject(B, () => getNativeTask(person(owner), task.id, {}, now))).rejects.toMatchObject({ code: 'not_found' });
  await expect(mutate(B, b.ownerAgent, { operation: 'claim', taskId: task.id, expectedRevision: 1 })).rejects.toMatchObject({ code: 'not_found' });
  await expect(inProject(A, () => listNativeTasks(person(other), {}, now))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(mutate(A, person(other), { operation: 'comment', taskId: task.id, expectedRevision: 1, body: 'hi' })).rejects.toMatchObject({ code: 'unauthorized' });
  await setTestMembership(A, member.id, 'removed');
  await expect(inProject(A, () => getNativeTask(person(member), task.id, {}, now))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(mutate(A, person(member), { operation: 'update', taskId: task.id, expectedRevision: 1, title: 'hijack' })).rejects.toMatchObject({ code: 'unauthorized' });
});

test('a linked merged PR never completes the task; the assignee finishes a non-code result without a PR', async () => {
  const { member, a } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Docs', description: 'Done when the guide is published.' });
  const claimed = await mutate(A, a.memberAgent, { operation: 'claim', taskId: task.id, expectedRevision: 1 });
  const linked = await mutate(A, a.memberAgent, { operation: 'add_reference', taskId: task.id, expectedRevision: claimed.task.revision,
    reference: { id: 'pr1', kind: 'pull_request', url: 'https://github.com/example/library/pull/7' } });
  expect(linked.task.status).toBe('in_progress');
  await expect(mutate(A, a.memberAgent, { operation: 'add_reference', taskId: task.id, expectedRevision: linked.task.revision,
    reference: { id: 'bad', kind: 'result', url: 'javascript:alert(1)' } })).rejects.toMatchObject({ code: 'bad_input' });
  const result = await mutate(A, a.memberAgent, { operation: 'add_reference', taskId: task.id, expectedRevision: linked.task.revision,
    reference: { id: 'doc', kind: 'result', url: 'https://example.com/guide' } });
  const done = await mutate(A, a.memberAgent, { operation: 'update', taskId: task.id, expectedRevision: result.task.revision, status: 'done' });
  expect(done.task).toMatchObject({ status: 'done', assignedAgentId: a.memberAgent.agent.id });
});

test('a plain member cannot release or complete someone else\'s claimed task; release returns it to Backlog unassigned', async () => {
  const { owner, member, a } = await fixture();
  const { task } = await mutate(A, person(owner), { operation: 'create', title: 'Owned' });
  const claimed = await mutate(A, a.ownerAgent, { operation: 'claim', taskId: task.id, expectedRevision: 1 });
  await expect(mutate(A, person(member), { operation: 'release', taskId: task.id, expectedRevision: 2 })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(mutate(A, a.memberAgent, { operation: 'update', taskId: task.id, expectedRevision: 2, status: 'done' })).rejects.toMatchObject({ code: 'forbidden' });
  const released = await mutate(A, a.ownerAgent, { operation: 'release', taskId: task.id, expectedRevision: claimed.task.revision });
  expect(released.task).toMatchObject({ status: 'backlog', assignedAgentId: null, revision: 3 });
});

test('task operations never create runs, steering or inbox items for any agent', async () => {
  const { owner, a } = await fixture();
  const snapshot = () => inProject(A, async () => {
    const rows = await agents().get();
    return rows.docs.map(d => [d.id, d.data()]).sort();
  });
  const before = await snapshot();
  const { task } = await mutate(A, person(owner), { operation: 'create', title: 'Quiet' });
  const assigned = await mutate(A, person(owner), { operation: 'assign', taskId: task.id, expectedRevision: task.revision, assignedAgentId: a.memberAgent.agent.id });
  const claimed = await mutate(A, person(owner), { operation: 'update', taskId: task.id, expectedRevision: assigned.task.revision, status: 'in_progress' });
  expect(claimed.task.status).toBe('in_progress');
  expect(await snapshot()).toEqual(before);
  // Subcollections that would carry execution (runs, inbox, steering) stay empty for the assigned agent.
  const sub = await inProject(A, async () => (await agents().doc(a.memberAgent.agent.id).listCollections()).map(c => c.id));
  const counts = await inProject(A, async () => Promise.all(sub.map(async id => [id, (await agents().doc(a.memberAgent.agent.id).collection(id).get()).size])));
  expect(counts.filter(([id]) => /inbox|steer/i.test(String(id)))).toEqual(counts.filter(([id]) => /inbox|steer/i.test(String(id))).map(([id]) => [id, 0]));
});

test('a conversation link to a source outside the shared project index is refused and never stored', async () => {
  const { member } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Link' });
  await expect(mutate(A, person(member), { operation: 'add_reference', taskId: task.id, expectedRevision: 1,
    reference: { id: 'c1', kind: 'conversation', sourceId: 'private-thread-in-b' } })).rejects.toMatchObject({ code: 'not_found' });
  expect((await inProject(A, async () => (await nativeTasks().doc(task.id).get()).data()!)).references).toEqual([]);
});

test('a revoked agent\'s claimed task stays assigned and visible until an explicit release', async () => {
  const { owner, member, a } = await fixture();
  const { task } = await mutate(A, person(owner), { operation: 'create', title: 'Stopped agent' });
  await mutate(A, a.memberAgent, { operation: 'claim', taskId: task.id, expectedRevision: 1 });
  await inProject(A, () => revokeOwned(member.id, a.memberAgent.agent.id, now));
  await expect(mutate(A, a.memberAgent, { operation: 'update', taskId: task.id, expectedRevision: 2, status: 'done' })).rejects.toMatchObject({ code: 'unauthorized' });
  const read = await inProject(A, () => getNativeTask(person(owner), task.id, {}, now));
  expect(read.task).toMatchObject({ assignedAgentId: a.memberAgent.agent.id, status: 'in_progress' });
  const released = await mutate(A, person(owner), { operation: 'release', taskId: task.id, expectedRevision: 2 });
  expect(released.task).toMatchObject({ assignedAgentId: null, status: 'backlog' });
});

test('a retried winning claim is refused after the claimant\'s membership was removed, without a second event', async () => {
  const { owner, member, a } = await fixture();
  const { task } = await mutate(A, person(owner), { operation: 'create', title: 'Replay authority' });
  const input = { clientRequestId: randomUUID(), operation: 'claim', taskId: task.id, expectedRevision: 1 };
  await inProject(A, () => mutateNativeTask(a.memberAgent, input, now));
  await setTestMembership(A, member.id, 'removed');
  await expect(inProject(A, () => mutateNativeTask(a.memberAgent, input, now))).rejects.toMatchObject({ code: 'unauthorized' });
  expect(await activityOf(A, person(owner), task.id)).toHaveLength(2);
});

test('a person export includes their and their agents\' native tasks, comments and activity, and withholds others\' text', async () => {
  const { owner, member, a } = await fixture();
  const mine = await mutate(A, person(member), { operation: 'create', title: 'Member task', description: 'Mine' });
  const theirs = await mutate(A, person(owner), { operation: 'create', title: 'Owner task' });
  const claimed = await mutate(A, a.memberAgent, { operation: 'claim', taskId: theirs.task.id, expectedRevision: 1 });
  const byAgent = await mutate(A, a.memberAgent, { operation: 'comment', taskId: theirs.task.id, expectedRevision: claimed.task.revision, body: 'Agent result' });
  await mutate(A, person(owner), { operation: 'comment', taskId: theirs.task.id, expectedRevision: byAgent.task.revision, body: 'OWNER-PRIVATE-NOTE' });
  const exported = await exportPerson(member.id, now);
  const paths = exported.records.map(r => r.path);
  expect(paths).toContain(`projects/${A}/nativeTasks/${mine.task.id}`);
  expect(paths).not.toContain(`projects/${A}/nativeTasks/${theirs.task.id}`);
  expect(paths).toContain(`projects/${A}/nativeTasks/${theirs.task.id}/comments/${byAgent.comment!.id}`);
  const activity = exported.records.filter(r => r.path.startsWith(`projects/${A}/nativeTasks/${theirs.task.id}/activity/`));
  expect(activity.map(r => (r.data as { action: string }).action).sort()).toEqual(['claim', 'comment']);
  expect(JSON.stringify(exported)).not.toContain('OWNER-PRIVATE-NOTE');
  expect(JSON.stringify(activity)).not.toContain('Owner task');
  // Receipts are attributed by actor and exported without repeating the task.
  const receipts = exported.records.filter(r => r.path.startsWith(`projects/${A}/nativeTaskReceipts/`));
  expect(receipts.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(receipts)).not.toContain('Owner task');
});

test('a person export keeps only the task fields and links the person wrote', async () => {
  const { owner, member } = await fixture();
  const ownerTask = await mutate(A, person(owner), { operation: 'create', title: 'OWNER-TITLE', description: 'OWNER-DESCRIPTION' });
  const edited = await mutate(A, person(member), { operation: 'update', taskId: ownerTask.task.id, expectedRevision: 1, description: 'MEMBER-DESCRIPTION' });
  await mutate(A, person(owner), { operation: 'add_reference', taskId: ownerTask.task.id, expectedRevision: edited.task.revision,
    reference: { id: 'ownerlink', kind: 'result', url: 'https://example.com/OWNER-LINK' } });
  const memberTask = await mutate(A, person(member), { operation: 'create', title: 'MEMBER-TITLE', description: 'MEMBER-ORIGINAL' });
  await mutate(A, person(owner), { operation: 'update', taskId: memberTask.task.id, expectedRevision: 1, description: 'OWNER-REWRITE' });
  const exported = await exportPerson(member.id, now);
  const task = (id: string) => exported.records.find(r => r.path === `projects/${A}/nativeTasks/${id}`)?.data as Record<string, unknown>;
  expect(task(ownerTask.task.id)).toMatchObject({ title: expect.stringContaining('withheld'), description: 'MEMBER-DESCRIPTION', references: [] });
  expect(task(memberTask.task.id)).toMatchObject({ title: 'MEMBER-TITLE', description: expect.stringContaining('withheld') });
  const text = JSON.stringify(exported);
  for (const other of ['OWNER-TITLE', 'OWNER-DESCRIPTION', 'OWNER-LINK', 'OWNER-REWRITE']) expect(text).not.toContain(other);
});

test('a paused project refuses agent task writes but keeps reads; a closed project refuses everyone\'s writes', async () => {
  const { owner, member, a } = await fixture();
  const { task } = await mutate(A, person(member), { operation: 'create', title: 'Paused' });
  await controlWorkspace(owner, A, { client_request_id: 'pause', expected_revision: 2, action: 'pause' }, now);
  await expect(mutate(A, a.memberAgent, { operation: 'claim', taskId: task.id, expectedRevision: 1 })).rejects.toBeTruthy();
  expect((await inProject(A, () => getNativeTask(person(member), task.id, {}, now))).task.status).toBe('backlog');
  await controlWorkspace(owner, A, { client_request_id: 'close', expected_revision: 3, action: 'close' }, now);
  await expect(mutate(A, person(owner), { operation: 'update', taskId: task.id, expectedRevision: 1, title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  expect((await inProject(A, async () => (await nativeTasks().doc(task.id).get()).data()!))).toMatchObject({ title: 'Paused', revision: 1, assignedAgentId: null });
});
