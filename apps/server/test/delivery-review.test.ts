import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { DeliveryReviewMutation, DeliveryReviewObservation, DeliveryReviewRequiredCheck } from '@minions/contracts';
import { beforeEach, expect, test } from 'vitest';
import { currentProjectId, inProject, profiles, projectDoc } from '../src/firestore.js';
import { getDeliveryReview, mutateDeliveryReview, setDeliveryReviewObserver } from '../src/projects/delivery-review.js';
import { getNativeTask, mutateNativeTask } from '../src/projects/native-tasks.js';
import type { ProgressActor } from '../src/projects/progress-authority.js';
import { startRun } from '../src/v2/runs.js';
import { addAgent, loadAgent, resetEmulator, seed, setTestMembership, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);

const headSha = 'a'.repeat(40);
const requiredCheck: DeliveryReviewRequiredCheck = {
  name: 'Unit tests', workflowId: 42, workflowPath: '.github/workflows/test.yml', workflowBlobSha: 'b'.repeat(40),
};
const checkRun = { runId: 5, runAttempt: 1, jobId: 7, checkRunId: 9 };
const observed = (status: DeliveryReviewObservation['checks'][number]['status'], now: () => number): DeliveryReviewObservation => ({
  status, actualHeadSha: headSha, observedAt: now(),
  checks: [{ name: requiredCheck.name, status, ...(status === 'verified' || status === 'failed' ? checkRun : {}) }],
});
const submission = { operation: 'submit', repository: 'Example/Game', pullRequest: 3, headSha, manifest: 'Ran the unit tests.' } as const;
const refreshInput = { operation: 'refresh', generation: 2 } as const;
type WithoutBase<M = DeliveryReviewMutation> = M extends DeliveryReviewMutation ? Omit<M, 'taskId' | 'clientRequestId'> : never;

async function fixture() {
  const { personIds } = await seed({
    profiles: [{ name: 'Owner', email: 'owner@example.test', role: 'owner' }, { name: 'Member', email: 'member@example.test' }],
  });
  if (currentProjectId() !== TEST_PROJECT) await setTestMembership(currentProjectId(), personIds[1]);
  let at = 10_000;
  const now = () => at;
  const person = async (id: string) => ({ kind: 'person' as const, person: { id, ...(await profiles.doc(id).get()).data()! } });
  const owner = await person(personIds[0]);
  const member = await person(personIds[1]);
  const workers = [];
  for (const [person, name] of [[0, 'author'], [1, 'reviewer'], [0, 'other peer']] as const) {
    const { agentId } = await addAgent(personIds[person], name, () => 1_000);
    const agent = await loadAgent(agentId);
    const { run_id: runId } = await startRun(agent.id, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now);
    workers.push({ kind: 'agent' as const, agent, runId });
  }
  const [author, reviewer, alternate] = workers;
  const created = await mutateNativeTask(owner, { operation: 'create', title: 'Delivery', description: 'Original requirement', clientRequestId: randomUUID() }, now);
  let { task } = await mutateNativeTask(owner, { operation: 'assign', taskId: created.task.id, expectedRevision: created.task.revision,
    assignedAgentId: author.agent.id, clientRequestId: randomUUID() }, now);
  const mutate = (actor: ProgressActor, input: WithoutBase, clientRequestId = randomUUID()) =>
    mutateDeliveryReview(actor, { ...input, taskId: task.id, clientRequestId }, now);
  const read = (query?: unknown) => getDeliveryReview(owner, task.id, query, now);
  const edit = async (input: object) => {
    ({ task } = await mutateNativeTask(owner, { ...input, taskId: task.id, expectedRevision: task.revision, clientRequestId: randomUUID() }, now));
    return task;
  };
  const detail = () => getNativeTask(owner, task.id, {}, now);
  return { owner, member, author, reviewer, alternate, mutate, read, edit, detail, now, advance: (ms: number) => { at += ms; } };
}

async function configuredFixture(requiredChecks = [requiredCheck]) {
  const result = await fixture();
  await result.mutate(result.owner, { operation: 'configure', enabled: true, expectedGeneration: 0, requiredChecks });
  await result.mutate(result.author, { ...submission, expectedGeneration: 1 });
  return result;
}

function holdObservation() {
  let start!: () => void;
  let release!: (value: DeliveryReviewObservation) => void;
  let calls = 0;
  const started = new Promise<void>(resolve => { start = resolve; });
  const result = new Promise<DeliveryReviewObservation>(resolve => { release = resolve; });
  setDeliveryReviewObserver(() => {
    calls++;
    start();
    return result;
  });
  return { started, release, get calls() { return calls; } };
}

test('delivery candidates and peer evidence are attributed, independently versioned, and replayable', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, member, author, reviewer, alternate, mutate, read, edit, detail } = await fixture();
    const configure = { operation: 'configure', enabled: true, expectedGeneration: 0, reviewerAgentId: reviewer.agent.id } as const;
    await expect(mutate(member, configure)).rejects.toMatchObject({ code: 'forbidden' });
    await mutate(owner, configure);
    await expect(mutate(reviewer, { ...submission, expectedGeneration: 1 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(mutate(author, { ...submission, expectedGeneration: 0 })).rejects.toMatchObject({ code: 'intent_conflict' });
    const identity = { path: 'test/unit.ts', sha256: 'c'.repeat(64) };
    await expect(mutate(author, { ...submission, expectedGeneration: 1, reportedTests: [identity, identity] })).rejects.toMatchObject({ code: 'bad_input' });
    const request = randomUUID();
    const submit = { ...submission, expectedGeneration: 1, reportedTests: [identity] };
    const saved = await mutate(author, submit, request);
    expect(saved.event).toMatchObject({ generation: 2, kind: 'submitted', candidate: { repository: 'example/game', reportedTests: [identity] } });
    expect(await mutate(author, submit, request)).toEqual({ ...saved, replayed: true });
    await expect(mutate(author, { ...submit, manifest: 'Changed' }, request)).rejects.toMatchObject({ code: 'intent_conflict' });
    const verdict = { operation: 'verdict', generation: 2, verdict: 'approved', note: 'Reviewed the exact commit.' } as const;
    await expect(mutate(author, verdict)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(mutate(alternate, verdict)).rejects.toMatchObject({ code: 'forbidden' });
    await mutate(reviewer, verdict);
    await edit({ operation: 'comment', body: 'Independent comment.' });
    await edit({ operation: 'update', title: 'Edited title' });
    expect((await detail()).deliveryReview?.verdict).toMatchObject({ actor: { kind: 'agent', id: reviewer.agent.id } });
    await edit({ operation: 'update', description: 'Different requirement' });
    await edit({ operation: 'update', description: 'Original requirement' });
    expect(await read()).toMatchObject({ current: null, verdict: null, observation: null, generation: 4 });
    await expect(mutate(reviewer, verdict)).rejects.toMatchObject({ code: 'intent_conflict' });
    const page = await read({ limit: 2 });
    expect(page.events.map(event => event.kind)).toEqual(['invalidated', 'invalidated']);
    expect((await read({ cursor: page.nextCursor })).events.map(event => event.kind)).toEqual(['verdict', 'submitted', 'configured']);
    await projectDoc().update({ nativeTasks: { enabled: false, revision: 1 } });
    await expect(mutate(author, submit, request)).rejects.toMatchObject({ code: 'tasks_disabled' });
  });
});

test('failed checks require an owner reason to remove, and a late trusted observation stays historical', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, author, mutate, read, detail, now, advance } = await fixture();
    await mutate(owner, { operation: 'configure', enabled: true, expectedGeneration: 0, requiredChecks: [requiredCheck] });
    await mutate(author, { ...submission, expectedGeneration: 1 });
    await expect(mutateDeliveryReview(owner, { operation: 'refresh', taskId: (await detail()).task.id, clientRequestId: randomUUID(),
      generation: 2, observation: { status: 'verified' } }, now)).rejects.toMatchObject({ code: 'bad_input' });
    setDeliveryReviewObserver(async () => observed('failed', now));
    await mutate(owner, { operation: 'refresh', generation: 2 });
    expect((await read()).observation?.status).toBe('failed');
    advance(5 * 60_000);
    expect((await read()).observation).toBeNull();
    const { started, release } = holdObservation();
    const refreshRequest = randomUUID();
    const pending = mutate(owner, { operation: 'refresh', generation: 2 }, refreshRequest);
    await started;
    await expect(mutate(owner, { operation: 'configure', enabled: false, reason: 'Turning review off.', expectedGeneration: 2 }, refreshRequest))
      .rejects.toMatchObject({ code: 'intent_conflict' });
    await mutate(author, { ...submission, headSha: 'd'.repeat(40), expectedGeneration: 2 });
    release(observed('verified', now));
    const saved = await pending;
    expect(saved.event).toMatchObject({ generation: 2, kind: 'observed' });
    expect(await mutate(owner, { operation: 'refresh', generation: 2 }, refreshRequest)).toEqual({ ...saved, replayed: true });
    expect(await read()).toMatchObject({ generation: 3, current: { headSha: 'd'.repeat(40) }, observation: null });
    const weaken = { operation: 'configure', enabled: true, expectedGeneration: 3, requiredChecks: [] } as const;
    await expect(mutate(owner, { ...weaken, requiredChecks: [] })).rejects.toMatchObject({ code: 'bad_input' });
    const result = await mutate(owner, { ...weaken, requiredChecks: [], reason: 'The owner retired the broken workflow.' });
    expect(result.event).toMatchObject({ kind: 'configured', reason: 'The owner retired the broken workflow.' });
    expect((await read()).events).toContainEqual(expect.objectContaining({ kind: 'observed', observation: expect.objectContaining({ status: 'failed' }) }));
  });
});

test('a repository rebind hides previous current evidence from both detail reads', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, author, reviewer, mutate, read, detail } = await fixture();
    await mutate(owner, { operation: 'configure', enabled: true, expectedGeneration: 0 });
    await mutate(author, { ...submission, expectedGeneration: 1 });
    await mutate(reviewer, { operation: 'verdict', generation: 2, verdict: 'approved', note: 'Approved original delivery.' });
    const project = (await projectDoc().get()).data()!;
    await projectDoc().set({ ...project, setup: { ...project.setup, repoUrl: 'https://github.com/another/repo', repositoryRevision: 8 } });
    expect((await detail()).deliveryReview).toMatchObject({ current: null, verdict: null });
    expect(await read()).toMatchObject({ current: null, verdict: null, events: expect.arrayContaining([expect.objectContaining({ kind: 'submitted' })]) });
    await projectDoc().set({ ...project, setup: { ...project.setup, repositoryRevision: 9 } });
    expect(await read()).toMatchObject({ current: null, verdict: null, generation: 2 });
    await mutate(author, { ...submission, expectedGeneration: 2 });
    expect(await read()).toMatchObject({ current: { generation: 3 }, verdict: null });
  });
});

test('a passing observation resolves a prior failure and preserves its history', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, mutate, read, now } = await configuredFixture();
    for (const status of ['failed', 'unavailable', 'verified'] as const) {
      setDeliveryReviewObserver(async () => observed(status, now));
      await mutate(owner, refreshInput);
      expect((await read()).failedCheckNames).toEqual(status === 'verified' ? [] : [requiredCheck.name]);
    }
    await mutate(owner, { operation: 'configure', enabled: false, expectedGeneration: 2 });
    expect((await read()).events.filter(event => event.kind === 'observed').map(event => event.observation.status))
      .toEqual(['verified', 'unavailable', 'failed']);
  });
});

test.each(['pending', 'unavailable'] as const)('an overlapping %s refresh preserves a failure in either completion order', async status => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, mutate, read, now } = await configuredFixture();
    for (const failureFirst of [true, false]) {
      const older = holdObservation();
      const failure = mutate(owner, refreshInput);
      await older.started;
      const newer = holdObservation();
      const inconclusive = mutate(owner, refreshInput);
      await newer.started;
      if (failureFirst) {
        older.release(observed('failed', now));
        await failure;
      }
      newer.release(observed(status, now));
      await inconclusive;
      if (!failureFirst) {
        older.release(observed('failed', now));
        await failure;
      }
      expect(await read()).toMatchObject({ observation: { status }, failedCheckNames: [requiredCheck.name] });
      setDeliveryReviewObserver(async () => observed('verified', now));
      await mutate(owner, refreshInput);
      expect((await read()).failedCheckNames).toEqual([]);
    }
  });
});

test('late failures cannot override a newer verification after another inconclusive refresh', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, mutate, read, now, advance } = await configuredFixture();
    const older = holdObservation();
    const request = randomUUID();
    const failure = mutate(owner, refreshInput, request);
    await older.started;
    setDeliveryReviewObserver(async () => observed('verified', now));
    await mutate(owner, refreshInput);
    setDeliveryReviewObserver(async () => observed('pending', now));
    await mutate(owner, refreshInput);
    advance(100);
    older.release(observed('failed', now));
    const original = await failure;
    expect(await read()).toMatchObject({ observation: { status: 'pending' }, failedCheckNames: [] });
    advance(5 * 60_000);
    setDeliveryReviewObserver(async () => { throw new Error('A durable receipt replay must not observe again'); });
    expect(await mutate(owner, refreshInput, request)).toEqual({ ...original, replayed: true });
    expect(await read()).toMatchObject({ observation: null, failedCheckNames: [] });
  });
});

test('each pinned check retains its own conclusive admission order', async () => {
  await inProject(TEST_PROJECT, async () => {
    const secondCheck = { ...requiredCheck, name: 'Browser tests' };
    const { owner, mutate, read, now } = await configuredFixture([requiredCheck, secondCheck]);
    const older = holdObservation();
    const failed = mutate(owner, refreshInput);
    await older.started;
    setDeliveryReviewObserver(async () => ({
      ...observed('pending', now),
      checks: [...observed('verified', now).checks, { name: secondCheck.name, status: 'pending' }],
    }));
    await mutate(owner, refreshInput);
    older.release({
      ...observed('failed', now),
      checks: [...observed('failed', now).checks, { name: secondCheck.name, status: 'failed', ...checkRun }],
    });
    await failed;
    expect(await read()).toMatchObject({ observation: { status: 'pending' }, failedCheckNames: [secondCheck.name] });
  });
});

test.each(['unavailable', 'verified'] as const)('a confirmed head change survives an overlapping %s refresh', async status => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, reviewer, author, mutate, read, now } = await configuredFixture();
    const older = holdObservation();
    const stale = mutate(owner, refreshInput);
    await older.started;
    const newer = holdObservation();
    const overlap = mutate(owner, refreshInput);
    await newer.started;
    const staleObservation: DeliveryReviewObservation = { status: 'stale', observedAt: now(),
      actualHeadSha: 'f'.repeat(40), staleReason: 'head_changed', checks: [] };
    if (status === 'verified') {
      older.release(staleObservation);
      await stale;
    }
    newer.release(observed(status, now));
    await overlap;
    if (status === 'unavailable') {
      older.release(staleObservation);
      await stale;
    }
    expect((await read()).observation).toMatchObject({ status: 'stale', staleReason: 'head_changed' });
    await expect(mutate(reviewer, { operation: 'verdict', generation: 2, verdict: 'approved', note: 'Reviewed candidate.' }))
      .rejects.toMatchObject({ code: 'intent_conflict' });
    await mutate(author, { ...submission, headSha: 'f'.repeat(40), expectedGeneration: 2 });
    expect(await read()).toMatchObject({ generation: 3, observation: null });
  });
});

test('concurrent duplicate refreshes share one observation and each caller checks current authority', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { author, mutate, read, now } = await configuredFixture();
    const held = holdObservation();
    const request = randomUUID();
    const first = mutate(author, refreshInput, request);
    await held.started;
    await expect(mutate({ ...author, agent: { ...author.agent, tokenHash: 'rotated' } }, refreshInput, request))
      .rejects.toMatchObject({ code: 'unauthorized' });
    const second = mutate(author, refreshInput, request);
    await setImmediate();
    expect(held.calls).toBe(1);
    held.release(observed('verified', now));
    const replies = await Promise.all([first, second]);
    expect(replies.map(reply => reply.replayed).sort()).toEqual([false, true]);
    expect(replies[0].event).toEqual(replies[1].event);
    expect((await read()).events.filter(event => event.kind === 'observed')).toHaveLength(1);
  });
});

test('matching refresh request IDs in different projects use separate observers', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, mutate, now } = await configuredFixture();
    const request = randomUUID();
    const firstObservation = holdObservation();
    const first = mutate(owner, refreshInput, request);
    await firstObservation.started;
    const otherProject = 'a2b3'.repeat(16);
    await inProject(otherProject, async () => {
      const other = await configuredFixture();
      await setTestMembership(otherProject, owner.person.id);
      setDeliveryReviewObserver(async () => observed('pending', other.now));
      const second = other.mutate(owner, refreshInput, request);
      await setImmediate();
      firstObservation.release(observed('failed', now));
      expect((await first).event).toMatchObject({ observation: { status: 'failed' } });
      expect((await second).event).toMatchObject({ observation: { status: 'pending' } });
    });
  });
});

test('revocation aborts a reserved refresh and its retry keeps the original admission order', async () => {
  await inProject(TEST_PROJECT, async () => {
    const { owner, member, mutate, read, now } = await configuredFixture();
    const held = holdObservation();
    const request = randomUUID();
    const aborted = expect(mutate(member, refreshInput, request)).rejects.toMatchObject({ code: 'unauthorized' });
    await held.started;
    const failed = holdObservation();
    const firstFailure = mutate(owner, refreshInput);
    await failed.started;
    const aborting = holdObservation();
    const abortingRequest = randomUUID();
    const abortedLater = expect(mutate(member, refreshInput, abortingRequest)).rejects.toMatchObject({ code: 'unauthorized' });
    await aborting.started;
    await setTestMembership(TEST_PROJECT, member.person.id, 'left', now());
    held.release(observed('failed', now));
    aborting.release(observed('verified', now));
    await Promise.all([aborted, abortedLater]);
    failed.release(observed('failed', now));
    await firstFailure;
    expect(await read()).toMatchObject({ observation: null, failedCheckNames: [requiredCheck.name] });

    setDeliveryReviewObserver(async () => observed('verified', now));
    await mutate(owner, refreshInput);
    setDeliveryReviewObserver(async () => observed('pending', now));
    await mutate(owner, refreshInput);
    await setTestMembership(TEST_PROJECT, member.person.id);
    setDeliveryReviewObserver(async () => observed('failed', now));
    const retried = await mutate(member, refreshInput, request);
    expect(retried).toMatchObject({ replayed: false, event: { observation: { status: 'failed' } } });
    expect(await read()).toMatchObject({ observation: { status: 'pending' }, failedCheckNames: [] });
    expect(await mutate(member, refreshInput, request)).toEqual({ ...retried, replayed: true });
  });
});
