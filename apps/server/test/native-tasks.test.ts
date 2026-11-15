import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { agents, db, inProject, profiles, projectCollection } from '../src/firestore.js';
import { listNativeTasks, getNativeTask, mutateNativeTask, nativeTasks, NATIVE_TASK_MUTATION } from '../src/projects/native-tasks.js';
import { startRun } from '../src/v2/runs.js';
import { runs } from '../src/v2/records.js';
import { readUpdates } from '../src/v2/inbox.js';
import { membershipDoc } from '../src/projects/access.js';
import { conversationEntries } from '../src/projects/steering.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { resetEmulator, seed, loadAgent, seedRuntime, idTokenFor, TEST_PROJECT } from './helpers.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';

beforeEach(resetEmulator);
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
const now = () => 1000;
const createInput = (title = 'A native task') => ({ operation: 'create', clientRequestId: randomUUID(), title });
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Admin', email: 'admin@example.test', role: 'owner' }, { name: 'Member', email: 'member@example.test' }],
    agents: [{ person: 0, name: 'Otter' }, { person: 1, name: 'Fox' }] });
  const persons = await Promise.all(f.personIds.map(async id => ({ kind: 'person' as const, person: { id, ...(await profiles.doc(id).get()).data()! } })));
  const actors: ProgressActor[] = [];
  for (const a of f.agents) {
    const agent = await loadAgent(a.agentId), runId = randomUUID();
    await scope(() => startRun(agent.id, { clientRunId: runId, runnerVersion: 'native-task-test', takeover: false }, now));
    actors.push({ kind: 'agent', agent, runId });
  }
  return { ...f, persons, actors };
}

test('native create persists title-only Backlog and stable retries with exactly one audit event', async () => scope(async () => {
  const f = await fixture(), input = createInput();
  const one = await mutateNativeTask(f.persons[0], input, now);
  expect(one.task).toMatchObject({ title: 'A native task', description: '', status: 'backlog', assignedAgentId: null, revision: 1, projectId: TEST_PROJECT });
  expect(one.replayed).toBe(false);
  expect(one.task.id).toMatch(/^task_[a-f0-9]{64}$/);
  expect(await mutateNativeTask(f.persons[0], input, now)).toEqual({ ...one, replayed: true });
  expect((await getNativeTask(f.persons[1], one.task.id, {}, now)).activity).toHaveLength(1);
  const receipts = await db.collection(`projects/${TEST_PROJECT}/nativeTaskReceipts`).get();
  expect(receipts.size).toBe(1); expect(receipts.docs[0].data().actor).toEqual(one.task.createdBy);
  expect((await listNativeTasks(f.persons[0], {}, now)).tasks).toEqual([{ ...one.task, subtaskProgress: { done: 0, total: 0 } }]);
  await expect(mutateNativeTask(f.persons[0], { ...input, title: 'changed retry' }, now)).rejects.toMatchObject({ code: 'intent_conflict' });
}));

test('people always create unassigned tasks, including admins and members with their own agents', async () => scope(async () => {
  const f = await fixture();
  for (const person of f.persons) {
    for (const agent of f.agents) {
      await expect(mutateNativeTask(person, { ...createInput(), assignedAgentId: agent.agentId }, now))
        .rejects.toMatchObject({ code: 'bad_input' });
    }
    const input = { ...createInput(), assignedAgentId: null };
    const result = await mutateNativeTask(person, input, now);
    expect(result.task).toMatchObject({ assignedAgentId: null, status: 'backlog', revision: 1 });
    expect(await mutateNativeTask(person, input, now)).toEqual({ ...result, replayed: true });
  }
  expect((await listNativeTasks(f.persons[0], {}, now)).tasks).toHaveLength(2);
  expect((await db.collection(`projects/${TEST_PROJECT}/nativeTaskReceipts`).get()).size).toBe(2);
}));

test('concurrent real Firestore claims produce one winner; retries and stale edits do not write', async () => scope(async () => {
  const f = await fixture(), { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  const inputs = f.actors.map(() => ({ operation: 'claim', clientRequestId: randomUUID(), taskId: task.id, expectedRevision: 1 }));
  const outcomes = await Promise.allSettled(f.actors.map((actor, i) => mutateNativeTask(actor, inputs[i], now)));
  expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  const winner = outcomes.findIndex(x => x.status === 'fulfilled');
  expect((outcomes[1 - winner] as PromiseRejectedResult).reason.code).toBe('intent_conflict');
  const win = (outcomes[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof mutateNativeTask>>>).value;
  expect(win.task).toMatchObject({ assignedAgentId: f.agents[winner].agentId, status: 'in_progress', revision: 2 });
  expect(await mutateNativeTask(f.actors[winner], inputs[winner], now)).toEqual({ ...win, replayed: true });
  await expect(mutateNativeTask(f.persons[0], { operation: 'update', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(), title: 'lost edit' }, now)).rejects.toMatchObject({ code: 'intent_conflict' });
  const detail = await getNativeTask(f.persons[0], task.id, {}, now);
  expect(detail.activity).toHaveLength(2); expect(detail.task.title).toBe(task.title);
  expect((await getNativeTask(f.persons[0],task.id,{activityId:detail.activity[1].id},now)).activity[0].task?.assignedAgentId).toBe(f.agents[winner].agentId);
}));

test('responsibility and status require authorized actors; release is explicit and assignment never starts a run', async () => scope(async () => {
  const f = await fixture(), { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  await expect(mutateNativeTask(f.persons[0], { operation: 'claim', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID() }, now)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(mutateNativeTask(f.persons[0], { operation: 'update', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(), status: 'done' }, now)).rejects.toMatchObject({ code: 'bad_input' });
  const before = (await runs().get()).docs.map(d => d.data());
  const assigned = await mutateNativeTask(f.persons[0], { operation: 'assign', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(), assignedAgentId: f.agents[0].agentId }, now);
  expect(assigned.task.status).toBe('backlog');
  expect((await runs().get()).docs.map(d => d.data())).toEqual(before);
  await expect(mutateNativeTask(f.actors[1], { operation: 'release', taskId: task.id, expectedRevision: 2, clientRequestId: randomUUID() }, now)).rejects.toMatchObject({ code: 'forbidden' });
  const done = await mutateNativeTask(f.actors[0], { operation: 'update', taskId: task.id, expectedRevision: 2, clientRequestId: randomUUID(), status: 'done' }, now);
  expect(done.task.status).toBe('done'); // Non-code result needs no PR.
  // Another agent can't reopen it by rewriting the description, and is told why rather than to claim it.
  await expect(mutateNativeTask(f.actors[1], { operation: 'update', taskId: task.id, expectedRevision: 3, clientRequestId: randomUUID(), description: 'Rewritten scope' }, now))
    .rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('reopens it') });
  const released = await mutateNativeTask(f.actors[0], { operation: 'release', taskId: task.id, expectedRevision: 3, clientRequestId: randomUUID() }, now);
  expect(released.task).toMatchObject({ status: 'backlog', assignedAgentId: null, revision: 4 });
}));

test('agent assignment rejects people, unknown, revoked and removed-member connections', async () => scope(async () => {
  const f = await fixture(), { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  const assign = (assignedAgentId: string) => mutateNativeTask(f.persons[0], { operation: 'assign', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(), assignedAgentId }, now);
  for (const bad of [f.personIds[0], 'other-project-agent']) await expect(assign(bad)).rejects.toMatchObject({ code: 'bad_input' });
  await agents().doc(f.agents[1].agentId).update({ revokedAt: 1000 });
  await expect(assign(f.agents[1].agentId)).rejects.toMatchObject({ code: 'bad_input' });
  await membershipDoc(TEST_PROJECT, f.personIds[1]).update({ status: 'removed' });
  await expect(mutateNativeTask(f.persons[1], createInput(), now)).rejects.toMatchObject({ code: 'unauthorized' });
}));

test('comments, contributors, typed references and audit persist, edits keep original authors', async () => scope(async () => {
  const f = await fixture(); let { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  const write = async (fields: object, actor: ProgressActor = f.persons[0]) => {
    const result = await mutateNativeTask(actor, { taskId: task.id, expectedRevision: task.revision, clientRequestId: randomUUID(), ...fields }, now); task = result.task; return result;
  };
  const first = await write({ operation: 'comment', body: 'Original result' });
  await expect(write({ operation: 'edit_comment', commentId: first.comment!.id, body: 'spoof' }, f.persons[1])).rejects.toMatchObject({ code: 'forbidden' });
  await write({ operation: 'edit_comment', commentId: first.comment!.id, body: 'Edited result' });
  await write({ operation: 'update', contributors: [{ kind: 'agent', id: f.agents[0].agentId }, { kind: 'agent', id: f.agents[1].agentId }], description: 'The result is a written analysis.' });
  await write({ operation: 'add_reference', reference: { id: 'pr1', kind: 'pull_request', url: 'https://github.com/example/game/pull/123' } });
  expect(task.status).toBe('backlog');
  await expect(write({ operation: 'add_reference', reference: { id: 'evil', kind: 'result', url: 'javascript:alert(1)' } })).rejects.toMatchObject({ code: 'bad_input' });
  await expect(write({ operation: 'add_reference', reference: { id: 'private', kind: 'message', sourceId: 'unknown-or-private' } })).rejects.toMatchObject({ code: 'not_found' });
  const detail = await getNativeTask(f.persons[1], task.id, {}, now);
  expect(detail.comments).toHaveLength(1); expect(detail.comments[0]).toMatchObject({ body: 'Edited result', author: { kind: 'person', id: f.personIds[0] } });
  expect((await getNativeTask(f.persons[1],task.id,{activityId:detail.activity.find(a=>a.action==='comment')!.id},now)).activity[0].comment?.body).toBe('Original result');
  expect(detail.task.contributors).toHaveLength(2);
  await write({ operation: 'update', title: 'Member-authored title' }, f.persons[1]);
  expect(task.createdBy).toEqual({ kind: 'person', id: f.personIds[0] });
  expect(task.titleAuthor).toEqual({ kind: 'person', id: f.personIds[1] });
  expect(task.descriptionAuthor).toEqual({ kind: 'person', id: f.personIds[0] });
  expect(task.referenceAuthors?.pr1).toEqual({ kind: 'person', id: f.personIds[0] });

}));

test('contributors accept only distinct connected project agents; mixed saved records remain readable', async () => scope(async () => {
  const f = await fixture();
  const input = createInput();
  const created = await mutateNativeTask(f.persons[0], input, now);
  const task = created.task;
  const update = (contributors: unknown[]) => mutateNativeTask(f.persons[0], {
    operation: 'update', taskId: task.id, expectedRevision: task.revision, clientRequestId: randomUUID(), contributors,
  }, now);
  for (const contributors of [
    [{ kind: 'person', id: f.personIds[0] }],
    [{ kind: 'agent', id: f.personIds[0] }],
    [{ kind: 'agent', id: 'other-project-agent' }],
    [{ kind: 'agent', id: f.agents[0].agentId }, { kind: 'agent', id: f.agents[0].agentId }],
  ]) await expect(update(contributors)).rejects.toMatchObject({ code: 'bad_input' });
  await agents().doc(f.agents[1].agentId).update({ revokedAt: 1000 });
  await expect(update([{ kind: 'agent', id: f.agents[1].agentId }])).rejects.toMatchObject({ code: 'bad_input' });
  const contributor = { kind: 'agent' as const, id: f.agents[0].agentId };
  const mixed = [{ kind: 'person', id: f.personIds[0] }, contributor];
  // Existing data is read without granting people contributor support or rewriting history.
  await nativeTasks().doc(task.id).update({ contributors: mixed });
  expect((await listNativeTasks(f.persons[0], {}, now)).tasks[0].contributors).toEqual([contributor]);
  expect((await getNativeTask(f.persons[0], task.id, {}, now)).task.contributors).toEqual([contributor]);
  expect((await nativeTasks().doc(task.id).get()).data()!.contributors).toEqual(mixed);
  const events = projectCollection<{ task: { contributors: unknown[] } }>(`nativeTasks/${task.id}/activity`);
  const event = (await events.get()).docs[0];
  await event.ref.update({ 'task.contributors': mixed });
  const version = await getNativeTask(f.persons[0], task.id, { activityId: event.id }, now);
  expect(version.activity[0].task!.contributors).toEqual([contributor]);
  expect((await event.ref.get()).data()!.task.contributors).toEqual(mixed);
  const receipt = (await projectCollection('nativeTaskReceipts').get()).docs[0];
  await receipt.ref.update({ 'result.task.contributors': mixed });
  expect((await mutateNativeTask(f.persons[0], input, now)).task.contributors).toEqual([contributor]);
  expect((await receipt.ref.get()).data()!.result.task.contributors).toEqual(mixed);
  const result = await update([contributor]);
  expect(result.task.contributors).toEqual([contributor]);
  expect((await nativeTasks().doc(task.id).get()).data()!.contributors).toEqual([contributor]);
}));

test('all reference kinds accept optional trimmed labels and reject invalid labels', () => {
  const base = { operation: 'add_reference', taskId: 'task', expectedRevision: 1, clientRequestId: randomUUID() };
  const references = [
    { id: 'pr', kind: 'pull_request', url: 'https://github.com/example/game/pull/123' },
    { id: 'result', kind: 'result', url: 'https://example.com/result' },
    { id: 'conversation', kind: 'conversation', sourceId: 'shared' },
    { id: 'message', kind: 'message', sourceId: 'shared' },
  ];
  for (const reference of references) {
    expect(NATIVE_TASK_MUTATION.safeParse({ ...base, reference }).success).toBe(true);
    const parsed = NATIVE_TASK_MUTATION.parse({ ...base, reference: { ...reference, label: '  Reference only  ' } });
    expect(parsed.operation === 'add_reference' && parsed.reference.label).toBe('Reference only');
    expect(NATIVE_TASK_MUTATION.safeParse({ ...base, reference: { ...reference, label: 'a'.repeat(120) } }).success).toBe(true);
    for (const label of ['', '   ', 'a'.repeat(121), null, 42, {}]) {
      expect(NATIVE_TASK_MUTATION.safeParse({ ...base, reference: { ...reference, label } }).success).toBe(false);
    }
  }
});

test('reference labels retain attribution, history and replay identity without completing a task', async () => scope(async () => {
  const f = await fixture();
  const { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  const input = { operation: 'add_reference', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(),
    reference: { id: 'implementation-pr', kind: 'pull_request', url: 'https://github.com/example/game/pull/123', label: '  Reference only  ' } };
  const linked = await mutateNativeTask(f.persons[1], input, now);
  expect(linked.task).toMatchObject({ status: 'backlog', assignedAgentId: null, revision: 2,
    references: [{ ...input.reference, label: 'Reference only' }],
    referenceAuthors: { 'implementation-pr': { kind: 'person', id: f.personIds[1] } } });
  expect(await mutateNativeTask(f.persons[1], input, now)).toEqual({ ...linked, replayed: true });
  await expect(mutateNativeTask(f.persons[1], { ...input, reference: { ...input.reference, label: 'Delivery evidence' } }, now))
    .rejects.toMatchObject({ code: 'intent_conflict' });
  const detail = await getNativeTask(f.persons[0], task.id, {}, now);
  expect(detail.task.references[0].label).toBe('Reference only');
  expect(detail.activity).toHaveLength(2);
  const event = detail.activity.find(row => row.action === 'add_reference')!;
  const history = await getNativeTask(f.persons[0], task.id, { activityId: event.id }, now);
  expect(history.activity[0]).toMatchObject({ actor: { kind: 'person', id: f.personIds[1] },
    task: { references: [{ ...input.reference, label: 'Reference only' }] } });
}));

test('native sources are rechecked at every read and retry; cross-project records cannot be read', async () => scope(async () => {
  const f = await fixture(); const { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  const id = 'shared-message';
  await conversationEntries().doc(id).set({ kind: 'agent_message', id, threadId: id, body: 'Shared', agentId: f.agents[0].agentId, agentName: 'Otter', to: [], audience: 'project', createdAt: 1000, protocol: 2 });
  const input = { operation: 'add_reference', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(), reference: { id: 'source', kind: 'conversation', sourceId: id } };
  expect((await mutateNativeTask(f.persons[0], input, now)).task.references).toHaveLength(1);
  await conversationEntries().doc(id).delete();
  expect((await getNativeTask(f.persons[0], task.id, {}, now)).task.references).toHaveLength(0);
  expect((await getNativeTask(f.persons[0], task.id, {}, now)).task.referenceAuthors).toEqual({});
  const foreignId = 'foreign-message';
  await inProject('b'.repeat(64), () => conversationEntries().doc(foreignId).set({ kind: 'agent_message', id: foreignId, threadId: foreignId, body: 'Secret other project title', agentId: 'foreign', agentName: 'Private agent', to: [], audience: 'project', createdAt: 1000, protocol: 2 }));
  for (const sourceId of [foreignId]) {
    await expect(mutateNativeTask(f.persons[0], { operation: 'add_reference', taskId: task.id, expectedRevision: 2, clientRequestId: randomUUID(), reference: { id: 'forbidden-source', kind: 'message', sourceId } }, now)).rejects.toMatchObject({ code: 'not_found', message: 'This source is unavailable in this project.' });
  }

  expect((await mutateNativeTask(f.persons[0], input, now)).task.references).toHaveLength(0);
  await expect(inProject('a'.repeat(64), () => getNativeTask(f.persons[0], task.id, {}, now))).rejects.toMatchObject({ code: 'unauthorized' });
}));

test('removed profile, revoked agent, expired run, paused and closed project cannot mutate or replay', async () => scope(async () => {
  const f = await fixture(), input = createInput();
  const { task } = await mutateNativeTask(f.actors[0], input, now);
  await agents().doc(f.agents[0].agentId).update({ revokedAt: 1000 });
  await expect(mutateNativeTask(f.actors[0], input, now)).rejects.toMatchObject({ code: 'unauthorized' });
  await profiles.doc(f.personIds[1]).update({ removedAt: 1000 });
  await expect(getNativeTask(f.persons[1], task.id, {}, now)).rejects.toMatchObject({ code: 'unauthorized' });
  await profiles.doc(f.personIds[1]).update({ removedAt: null });
  await seedRuntime(TEST_PROJECT, { paused: true });
  expect((await getNativeTask(f.actors[1], task.id, {}, now)).permissions.edit).toBe(false);
  expect((await getNativeTask(f.persons[0], task.id, {}, now)).permissions.edit).toBe(true);
  await expect(mutateNativeTask(f.actors[1], createInput(), now)).rejects.toMatchObject({ code: 'paused' });
  await seedRuntime(TEST_PROJECT, { completedAt: 1000 });
  await expect(mutateNativeTask(f.persons[0], createInput(), now)).rejects.toMatchObject({ code: 'forbidden' });
  await runs().doc(f.agents[1].agentId).update({ mode: 'current_chat', deadlineAt: 999 });
  await expect(mutateNativeTask(f.actors[1], createInput(), now)).rejects.toMatchObject({ code: 'run_superseded' });
  expect((await db.collection(`projects/${TEST_PROJECT}/nativeTasks`).get()).size).toBe(1);
}));

test('assignment and mutation receipts preserve agent identity across a restarted current run', async () => scope(async () => {
  const f = await fixture(), { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  const input = { operation: 'claim', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID() };
  const first = await mutateNativeTask(f.actors[0], input, now);
  const run = await startRun(f.agents[0].agentId, { clientRunId: randomUUID(), runnerVersion: 'replacement', takeover: true }, now);
  const replacement: ProgressActor = { kind: 'agent', agent: await loadAgent(f.agents[0].agentId), runId: run.run_id };
  await expect(mutateNativeTask(f.actors[0], input, now)).rejects.toMatchObject({ code: 'run_superseded' });
  expect(await mutateNativeTask(replacement, input, now)).toEqual({ ...first, replayed: true });
  const result = await mutateNativeTask(replacement, { operation: 'comment', taskId: task.id, expectedRevision: 2, clientRequestId: randomUUID(), body: 'Continuing after restart' }, now);
  expect(result.task.assignedAgentId).toBe(f.agents[0].agentId);
  expect((await getNativeTask(f.persons[0], task.id, {}, now)).activity).toHaveLength(3);
}));

test('bounded lists, comments and activity support stable pagination', async () => scope(async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await mutateNativeTask(f.persons[0], createInput(`Task ${i}`), now);
  const first = await listNativeTasks(f.persons[0], { limit: 2 }, now);
  expect(first.tasks).toHaveLength(2); expect(first.nextCursor).not.toBeNull();
  const second = await listNativeTasks(f.persons[0], { limit: 2, cursor: first.nextCursor }, now);
  expect(second.tasks).toHaveLength(1); expect(second.nextCursor).toBeNull();
  expect(new Set([...first.tasks, ...second.tasks].map(t => t.id)).size).toBe(3);
  const task = first.tasks[0];
  await mutateNativeTask(f.persons[0], { operation: 'comment', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(), body: 'a' }, now);
  const detail = await getNativeTask(f.persons[0], task.id, { limit: 1 }, now);
  expect(detail.activity).toHaveLength(1); expect(detail.nextActivityCursor).not.toBeNull();
  await mutateNativeTask(f.persons[0], { operation: 'comment', taskId: task.id, expectedRevision: 2, clientRequestId: randomUUID(), body: 'b' }, now);
  const commentsFirst = await getNativeTask(f.persons[0], task.id, { limit: 1 }, now);
  expect(commentsFirst.comments[0].body).toBe('b');
  const commentsNext = await getNativeTask(f.persons[0], task.id, { limit: 1, commentCursor: commentsFirst.nextCommentCursor }, now);
  expect(commentsNext.comments[0].body).toBe('a');
  const newest = await getNativeTask(f.persons[0], task.id, { limit: 1, activityOrder: 'desc' }, now);
  expect(newest.activity[0].revision).toBe(3);
  const prior = await getNativeTask(f.persons[0], task.id, { limit: 1, activityOrder: 'desc', activityCursor: newest.nextActivityCursor }, now);
  expect(prior.activity[0].revision).toBe(2);

}));

test('real authenticated HTTP create/read binds current profile and reports useful 409 conflicts', async () => {
  const f = await scope(fixture), token = await idTokenFor('admin@example.test');
  const app = express(); app.use('/api/projects', projectManagementRoutes(now));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/projects/${TEST_PROJECT}/tasks`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-minions-profile-id': f.personIds[0] };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(createInput()) });
    expect(response.status).toBe(200); const { task } = await response.json();
    expect((await fetch(`${url}/${task.id}`, { headers })).status).toBe(200);
    const stale = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ operation: 'update', taskId: task.id, clientRequestId: randomUUID(), expectedRevision: 99, title: 'stale' }) });
    expect(stale.status).toBe(409); expect((await stale.json()).error).toBe('intent_conflict');
    const wrong = await fetch(url, { method: 'POST', headers: { ...headers, 'x-minions-profile-id': f.personIds[1] }, body: JSON.stringify(createInput()) });
    expect(wrong.status).toBe(401);
    const previousHost = process.env.HOST;
    try {
      process.env.HOST = '0.0.0.0';
      const hosted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(createInput('Hosted write allowed')) });
      expect(hosted.status).toBe(200);
      expect((await fetch(`${url}/${task.id}`, { headers })).status).toBe(200);
    } finally { process.env.HOST = previousHost; }

  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('a description edit is visible to the assigned agent and rejects completion against its stale revision', async () => scope(async () => {
 const f=await fixture();let {task}=await mutateNativeTask(f.persons[0],createInput(),now);
 task=(await mutateNativeTask(f.actors[0],{operation:'claim',taskId:task.id,expectedRevision:task.revision,clientRequestId:randomUUID()},now)).task;
 const oldRevision=task.revision,runBefore=(await runs().get()).docs.map(d=>d.data());
 task=(await mutateNativeTask(f.persons[1],{operation:'update',taskId:task.id,expectedRevision:task.revision,clientRequestId:randomUUID(),description:'Clarified expectations, within the approved mission'},now)).task;
 expect((await runs().get()).docs.map(d=>d.data())).toEqual(runBefore);
 await expect(mutateNativeTask(f.actors[0],{operation:'update',taskId:task.id,expectedRevision:oldRevision,clientRequestId:randomUUID(),status:'done'},now)).rejects.toMatchObject({code:'intent_conflict'});
 const fresh=await getNativeTask(f.actors[0],task.id,{},now);expect(fresh.task.description).toBe(task.description);
 expect(fresh.activity.at(-1)?.actor).toEqual({kind:'person',id:f.personIds[1]});
 expect((await mutateNativeTask(f.actors[0],{operation:'update',taskId:task.id,expectedRevision:fresh.task.revision,clientRequestId:randomUUID(),status:'done'},now)).task.status).toBe('done');
}));


test('agents cannot assign through any operation or borrow their persons admin authority', async()=>scope(async()=>{
 const f=await fixture();let {task}=await mutateNativeTask(f.persons[0],createInput(),now);
 for(const actor of f.actors){
  await expect(mutateNativeTask(actor,{operation:'assign',taskId:task.id,expectedRevision:1,assignedAgentId:f.agents[1].agentId,clientRequestId:randomUUID()},now)).rejects.toMatchObject({code:'forbidden'});
  await expect(mutateNativeTask(actor,{...createInput(),assignedAgentId:f.agents[1].agentId},now)).rejects.toMatchObject({code:'bad_input'});
 }
 task=(await mutateNativeTask(f.actors[1],{operation:'claim',taskId:task.id,expectedRevision:1,clientRequestId:randomUUID()},now)).task;
 await expect(mutateNativeTask(f.actors[0],{operation:'release',taskId:task.id,expectedRevision:2,clientRequestId:randomUUID()},now)).rejects.toMatchObject({code:'forbidden'});
 expect((await getNativeTask(f.actors[0],task.id,{},now)).permissions).toMatchObject({control:false,assign:'none'});
 expect((await mutateNativeTask(f.actors[1],{operation:'release',taskId:task.id,expectedRevision:2,clientRequestId:randomUUID()},now)).task).toMatchObject({status:'backlog',assignedAgentId:null});
}));

test('description changes reopen Done, while comments and title fixes retain completion; reassignment returns to Backlog',async()=>scope(async()=>{
 const f=await fixture();let {task}=await mutateNativeTask(f.persons[0],createInput(),now);
 const write=async(fields:object,actor=f.persons[0])=>{task=(await mutateNativeTask(actor,{taskId:task.id,expectedRevision:task.revision,clientRequestId:randomUUID(),...fields},now)).task;return task;};
 await write({operation:'assign',assignedAgentId:f.agents[0].agentId});
 await write({operation:'update',status:'done'});await write({operation:'comment',body:'Review complete'});await write({operation:'update',title:'Typo fixed'});expect(task.status).toBe('done');
 expect((await getNativeTask(f.persons[1],task.id,{},now)).permissions).toMatchObject({edit:true,editDescription:false,control:false});
 await expect(write({operation:'update',description:'New requirements'},f.persons[1])).rejects.toMatchObject({code:'forbidden'});
 await write({operation:'update',description:'New requirements',status:'done'});expect(task.status).toBe('backlog');
 await write({operation:'update',status:'in_progress'});await write({operation:'assign',assignedAgentId:f.agents[1].agentId});expect(task.status).toBe('backlog');
}));

test('large task pages, comments and compact history stay below the owner response cap without losing pagination',async()=>scope(async()=>{
 const f=await fixture();const description='x'.repeat(9990);let {task}=await mutateNativeTask(f.persons[0],{...createInput(),description},now);
 for(let i=0;i<27;i++)task=(await mutateNativeTask(f.persons[0],{operation:'update',taskId:task.id,expectedRevision:task.revision,clientRequestId:randomUUID(),description:description+i},now)).task;
 for(let i=0;i<12;i++)task=(await mutateNativeTask(f.persons[0],{operation:'comment',taskId:task.id,expectedRevision:task.revision,clientRequestId:randomUUID(),body:'😀'.repeat(3000)},now)).task;
 const detail=await getNativeTask(f.persons[0],task.id,{},now);expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(160*1024);expect(detail.activity.every(a=>!a.task && !a.comment)).toBe(true);
 const comments=[...detail.comments];let cursor=detail.nextCommentCursor;while(cursor){const page=await getNativeTask(f.persons[0],task.id,{commentCursor:cursor},now);comments.push(...page.comments);cursor=page.nextCommentCursor;}expect(new Set(comments.map(c=>c.id)).size).toBe(12);
 const batch=db.batch();for(let i=0;i<50;i++)batch.set(db.doc(`projects/${TEST_PROJECT}/nativeTasks/page_${i.toString().padStart(3,'0')}`),{...task,id:`page_${i.toString().padStart(3,'0')}`});await batch.commit();
 const all=new Set<string>();let next:string|null=null;do{const page=await listNativeTasks(f.persons[0],{...(next?{cursor:next}:{})},now);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(161*1024);page.tasks.forEach(t=>all.add(t.id));next=page.nextCursor;}while(next);expect(all.size).toBe(51);
}));


test('historical replay is explicit after newer edits and old persisted receipts need no migration', async () => scope(async () => {
  const f=await fixture(), input=createInput('Original');
  const first=await mutateNativeTask(f.persons[0],input,now);
  await mutateNativeTask(f.persons[1],{operation:'update',taskId:first.task.id,expectedRevision:1,clientRequestId:randomUUID(),title:'New current title'},now);
  const receipt=(await db.collection(`projects/${TEST_PROJECT}/nativeTaskReceipts`).get()).docs.find(doc=>doc.data().result.task.revision===1)!;
  const saved=receipt.data(); delete saved.result.replayed; await receipt.ref.set(saved);
  const retry=await mutateNativeTask(f.persons[0],input,now);
  expect(retry).toMatchObject({replayed:true,task:{revision:1,title:'Original'}});
  const current=await getNativeTask(f.persons[0],first.task.id,{},now);
  expect(current.task).toMatchObject({revision:2,title:'New current title'});
  expect(current.activity).toHaveLength(2);
}));


test('hosted task lifecycle uses signed-in membership and task authority, never starts work', async () => {
  const f=await scope(fixture), tokens=await Promise.all(['admin@example.test','member@example.test'].map(email => idTokenFor(email)));
  const app=express();app.use('/api/projects',projectManagementRoutes(now));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const previousHost=process.env.HOST;process.env.HOST='0.0.0.0';
  try {
    const root=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/projects/${TEST_PROJECT}`;
    const headers=(i:number,profile=i)=>({'content-type':'application/json',authorization:`Bearer ${tokens[i]}`,'x-minions-profile-id':f.personIds[profile],origin:'https://karma42.ai'});
    const post=(path:string,body:object,i=0,profile=i)=>fetch(root+path,{method:'POST',headers:headers(i,profile),body:JSON.stringify(body)});
    const runBefore=await scope(async()=> (await runs().get()).docs.map(d=>d.data()));
    expect((await fetch(root+'/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(createInput())})).status).toBe(401);
    expect((await post('/tasks',createInput(),0,1)).status).toBe(401);
    const original={...createInput('Hosted task'),description:'Write a note'};
    const response=await post('/tasks',original,1);expect(response.status).toBe(200);
    let task=(await response.json()).task;
    const write=async(fields:object,i=1)=>post('/tasks',{taskId:task.id,expectedRevision:task.revision,clientRequestId:randomUUID(),...fields},i);
    expect((await write({operation:'assign',assignedAgentId:f.agents[0].agentId})).status).toBe(403);
    const assigned=await write({operation:'assign',assignedAgentId:f.agents[1].agentId});expect(assigned.status).toBe(200);task=(await assigned.json()).task;
    const comment=await write({operation:'comment',body:'Human result'});expect(comment.status).toBe(200);const commented=await comment.json();task=commented.task;
    expect((await write({operation:'edit_comment',commentId:commented.comment.id,body:'Spoofed author'},0)).status).toBe(403);
    const complete=await write({operation:'update',status:'done'});expect(complete.status).toBe(200);task=(await complete.json()).task;
    const reopen=await write({operation:'update',description:'Write the revised note'});expect(reopen.status).toBe(200);task=(await reopen.json()).task;
    expect(task).toMatchObject({status:'backlog',assignedAgentId:f.agents[1].agentId});
    const retry=await post('/tasks',original,1);expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({replayed:true,task:{revision:1}});
    const detail=await fetch(root+'/tasks/'+task.id,{headers:headers(1)});expect((await detail.json()).task.revision).toBe(task.revision);
    const off=await post('/native-task-settings',{enabled:false,expectedRevision:0,clientRequestId:randomUUID()});expect(off.status).toBe(200);
    expect((await write({operation:'comment',body:'Stale OFF write'})).status).toBe(409);
    expect((await fetch(root+'/tasks/'+task.id,{headers:headers(1)})).status).toBe(200);
    expect((await post('/native-task-settings',{enabled:true,expectedRevision:1,clientRequestId:randomUUID()})).status).toBe(200);
    expect((await write({operation:'update',expectedRevision:1,title:'stale'})).status).toBe(409);
    await membershipDoc(TEST_PROJECT,f.personIds[1]).update({status:'removed'});
    expect((await write({operation:'comment',body:'Removed member'})).status).toBe(401);
    await seedRuntime(TEST_PROJECT,{completedAt:1000,paused:true});
    expect((await write({operation:'comment',body:'Closed project'},0)).status).toBe(403);
    expect(await scope(async()=> (await runs().get()).docs.map(d=>d.data()))).toEqual(runBefore);
  } finally {if(previousHost===undefined)delete process.env.HOST;else process.env.HOST=previousHost;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('task state filters apply before pagination and reject unknown states', async () => scope(async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    let { task } = await mutateNativeTask(f.persons[0], createInput(`Filter ${i}`), now);
    if (i < 3) {
      task = (await mutateNativeTask(f.actors[0], { operation: 'claim', taskId: task.id, expectedRevision: task.revision, clientRequestId: randomUUID() }, now)).task;
      if (i === 0) await mutateNativeTask(f.actors[0], { operation: 'update', taskId: task.id, expectedRevision: task.revision, status: 'done', clientRequestId: randomUUID() }, now);
    }
  }
  expect((await listNativeTasks(f.persons[0], {}, now)).tasks).toHaveLength(5);
  for (const [status, count] of [['backlog', 2], ['in_progress', 2], ['done', 1]] as const) {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await listNativeTasks(f.persons[0], { status, limit: 1, ...(cursor ? { cursor } : {}) }, now);
      expect(page.tasks).toHaveLength(1);
      expect(page.tasks[0].status).toBe(status);
      expect(ids.has(page.tasks[0].id)).toBe(false);
      ids.add(page.tasks[0].id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.size).toBe(count);
  }
  const unassigned = await listNativeTasks(f.persons[0], { unassigned: 'true' }, now);
  expect(unassigned.tasks).toHaveLength(2);
  expect(unassigned.tasks.every(task => task.assignedAgentId === null)).toBe(true);
  expect((await listNativeTasks(f.persons[0], { unassigned: 'true', status: 'done' }, now)).tasks).toHaveLength(0);
  const assigned = await listNativeTasks(f.persons[0], { assignedAgentId: f.agents[0].agentId }, now);
  expect(assigned.tasks).toHaveLength(3);
  const first = await listNativeTasks(f.persons[0], { status: 'in_progress', assignedAgentId: f.agents[0].agentId, limit: 1 }, now);
  expect(first.tasks).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
  const second = await listNativeTasks(f.persons[0], { status: 'in_progress', assignedAgentId: f.agents[0].agentId, limit: 1, cursor: first.nextCursor }, now);
  expect(second.tasks).toHaveLength(1); expect(second.nextCursor).toBeNull();
  expect(second.tasks[0].id).not.toBe(first.tasks[0].id);
  expect([...first.tasks, ...second.tasks].every(task => task.status === 'in_progress' && task.assignedAgentId === f.agents[0].agentId)).toBe(true);
  expect((await listNativeTasks(f.persons[0], { assignedAgentId: f.agents[1].agentId }, now)).tasks).toHaveLength(0);
  await expect(listNativeTasks(f.persons[0], { unassigned: 'true', assignedAgentId: f.agents[0].agentId }, now)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(listNativeTasks(f.persons[0], { unassigned: 'false' }, now)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(listNativeTasks(f.persons[0], { status: 'blocked' }, now)).rejects.toMatchObject({ code: 'bad_input' });
}));


test('unassigned tasks can be canceled by controllers, kept in history, and explicitly reopened before claiming', async () => scope(async () => {
  const f = await fixture();
  let { task } = await mutateNativeTask(f.persons[0], createInput('No longer needed'), now);
  const input = { operation: 'update', taskId: task.id, expectedRevision: task.revision, status: 'canceled', clientRequestId: randomUUID() };
  for (const actor of [f.persons[1], ...f.actors]) await expect(mutateNativeTask(actor, input, now)).rejects.toMatchObject({ code: 'forbidden' });
  const result = await mutateNativeTask(f.persons[0], input, now); task = result.task;
  expect(task).toMatchObject({ status: 'canceled', assignedAgentId: null, revision: 2 });
  expect(await mutateNativeTask(f.persons[0], input, now)).toEqual({ ...result, replayed: true });
  expect((await listNativeTasks(f.persons[0], { status: 'backlog', unassigned: 'true' }, now)).tasks).toHaveLength(0);
  expect((await listNativeTasks(f.persons[0], { status: 'canceled', unassigned: 'true' }, now)).tasks[0].id).toBe(task.id);
  await expect(mutateNativeTask(f.actors[0], { operation: 'claim', taskId: task.id, expectedRevision: task.revision, clientRequestId: randomUUID() }, now)).rejects.toMatchObject({ code: 'intent_conflict' });
  const detail = await getNativeTask(f.persons[0], task.id, {}, now);
  const versions = await Promise.all(detail.activity.map(event => getNativeTask(f.persons[0], task.id, { activityId: event.id }, now)));
  expect(versions.map(version => version.activity[0].task!.status)).toEqual(['backlog', 'canceled']);
  expect(detail.permissions).toMatchObject({ control: true, assign: 'none' });
  task = (await mutateNativeTask(f.persons[0], { operation: 'update', taskId: task.id, expectedRevision: task.revision, status: 'backlog', clientRequestId: randomUUID() }, now)).task;
  task = (await mutateNativeTask(f.actors[0], { operation: 'claim', taskId: task.id, expectedRevision: task.revision, clientRequestId: randomUUID() }, now)).task;
  expect(task).toMatchObject({ status: 'in_progress', assignedAgentId: f.agents[0].agentId });
}));

test('assigned cancellation preserves ownership and edits; only explicit Backlog reopening leaves Canceled', async () => scope(async () => {
  const f = await fixture();
  let { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  task = (await mutateNativeTask(f.actors[1], { operation: 'claim', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID() }, now)).task;
  const cancel = { operation: 'update', taskId: task.id, expectedRevision: task.revision, status: 'canceled', clientRequestId: randomUUID() };
  await expect(mutateNativeTask(f.actors[0], cancel, now)).rejects.toMatchObject({ code: 'forbidden' });
  task = (await mutateNativeTask(f.actors[1], cancel, now)).task;
  expect(task).toMatchObject({ status: 'canceled', assignedAgentId: f.agents[1].agentId });
  const write = async (fields: object) => { task = (await mutateNativeTask(f.persons[1], { ...fields, taskId: task.id, expectedRevision: task.revision, clientRequestId: randomUUID() }, now)).task; };
  await write({ operation: 'update', title: 'Canceled with context', description: 'No longer required' });
  await write({ operation: 'comment', body: 'Kept for history' });
  await write({ operation: 'add_reference', reference: { id: 'why', kind: 'result', url: 'https://example.com/decision' } });
  expect(task).toMatchObject({ status: 'canceled', assignedAgentId: f.agents[1].agentId });
  for (const fields of [{ operation: 'release' }, { operation: 'assign', assignedAgentId: f.agents[0].agentId }, { operation: 'update', status: 'in_progress' }, { operation: 'update', status: 'done' }]) {
    await expect(write(fields)).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('Reopen') });
  }
  await write({ operation: 'update', status: 'backlog' });
  expect(task).toMatchObject({ status: 'backlog', assignedAgentId: f.agents[1].agentId });
  await write({ operation: 'update', status: 'in_progress' });
  expect(task.status).toBe('in_progress');
}));

test('controllers may cancel Done or stale assignments without requiring an available agent', async () => scope(async () => {
  const f = await fixture();
  let { task } = await mutateNativeTask(f.persons[0], createInput(), now);
  task = (await mutateNativeTask(f.actors[0], { operation: 'claim', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID() }, now)).task;
  task = (await mutateNativeTask(f.actors[0], { operation: 'update', taskId: task.id, expectedRevision: task.revision, status: 'done', clientRequestId: randomUUID() }, now)).task;
  await agents().doc(f.agents[0].agentId).update({ revokedAt: now() });
  const canceled = await mutateNativeTask(f.persons[0], { operation: 'update', taskId: task.id, expectedRevision: task.revision, status: 'canceled', description: 'Work withdrawn', clientRequestId: randomUUID() }, now);
  expect(canceled.task).toMatchObject({ status: 'canceled', assignedAgentId: task.assignedAgentId, description: 'Work withdrawn' });
  await expect(mutateNativeTask(f.persons[0], { operation: 'update', taskId: task.id, expectedRevision: task.revision, status: 'backlog', clientRequestId: randomUUID() }, now)).rejects.toMatchObject({ code: 'intent_conflict' });
}));


test('full task reads combine title search with assignment/state and pagination, including title edits', async () => scope(async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (const title of ['Review parser', 'PARSER review', 'Different work']) ids.push((await mutateNativeTask(f.persons[0], createInput(title), now)).task.id);
  const first = await listNativeTasks(f.persons[0], { search: ' parser ', status: 'backlog', unassigned: 'true', limit: 1 }, now);
  expect(first.tasks).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
  const second = await listNativeTasks(f.persons[0], { search: 'PARSER', status: 'backlog', unassigned: 'true', limit: 1, cursor: first.nextCursor }, now);
  expect(second.tasks).toHaveLength(1);
  const all = [...first.tasks, ...second.tasks];
  expect(new Set(all.map(task => task.id))).toEqual(new Set(ids.slice(0, 2)));
  expect(all.every(task => 'description' in task && 'references' in task)).toBe(true);
  const task = first.tasks[0];
  await mutateNativeTask(f.persons[0], { operation: 'update', taskId: task.id, expectedRevision: task.revision, title: 'Renamed', clientRequestId: randomUUID() }, now);
  expect((await listNativeTasks(f.persons[0], { search: 'parser' }, now)).tasks.map(task => task.id)).toEqual([second.tasks[0].id]);
  await expect(listNativeTasks(f.persons[0], { search: 'x'.repeat(301) }, now)).rejects.toMatchObject({ code: 'bad_input' });
}));

test('a person assigning a task notifies the agent’s inbox; a claim does not', async () => scope(async () => {
  const f = await fixture(), { task } = await mutateNativeTask(f.persons[0], createInput('Fix the map'), now);
  const kinds = async (agentId: string) => (await readUpdates(agentId, undefined, now)).items.filter(item => item.kind === 'task_assigned');
  const assign = { operation: 'assign', taskId: task.id, expectedRevision: 1, clientRequestId: randomUUID(), assignedAgentId: f.agents[0].agentId };
  await mutateNativeTask(f.persons[0], assign, now);
  await mutateNativeTask(f.persons[0], assign, now); // A replay delivers nothing new.
  expect(await kinds(f.agents[0].agentId)).toEqual([expect.objectContaining({ payload: expect.objectContaining({
    type: 'task_assigned', taskId: task.id, revision: 2, assignedBy: { kind: 'person', id: f.personIds[0] },
    title: { trust: 'untrusted', source: { type: 'person', personId: f.personIds[0] }, content: 'Fix the map' } }) })]);
  const other = (await mutateNativeTask(f.persons[0], createInput('Other'), now)).task;
  await mutateNativeTask(f.actors[1], { operation: 'claim', taskId: other.id, expectedRevision: 1, clientRequestId: randomUUID() }, now);
  expect(await kinds(f.agents[1].agentId)).toEqual([]);
}));
