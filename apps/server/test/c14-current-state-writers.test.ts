// c14's writer probe, in the default suite since c4's A1/E1 writers landed (integration a697f708). It gates every writer of
// the status document's agent and run-end groups, and the queued cases (from today's starts query since card v15 S4).
// Current-state contract C3/C6 (c14, failing first): every writer of an agent's run end or agent identity merges its group
// into the status document presence/{agentId} in its own transaction. Each case calls the actual writer, then compares the
// state derived from the status document (c5's sourcesFromStatusDoc) with the state derived from the agent's sources
// (request-time source reader with a direct authoritative-run test oracle), with the same deriveAgentState.
// Two checks per writer: (1) safety, always: a complete document never derives a different state from the sources, which
// is checked against the independent run oracle; (2) the contract: after the writer the document is complete.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { agents, collection, db, inProject, profiles, type Agent, type Profile, type WithId } from '../src/firestore.js';
import { hashToken, newToken } from '../src/auth.js';
import { registerAgent } from '../src/onboarding/registration.js';
import { connectOwnAgent } from '../src/owner/agents.js';
import { reportAgentFocus } from '../src/projects/agent-focus.js';
import { saveAgentPersona } from '../src/projects/agent-participation.js';
import { revokeOwned } from '../src/onboarding/store.js';
import { acceptAgentStart, createWebAgentStart, projectQueuedStarts, publishRuntimeReadiness, webAgentStarts } from '../src/owner/web-agent-starts.js';
import { activeRecipientOperators, connectionAllowed, membershipDoc, membershipFenceDoc, membershipsOf } from '../src/projects/access.js';
import { requestParticipationControl, syncParticipations } from '../src/projects/chat-controls.js';
import { endProjectWork } from '../src/projects/close-work.js';
import { continueMembershipCleanup, membershipCleanup } from '../src/projects/member-cleanup.js';
import { projects } from '../src/projects/records.js';
import { continueAccountCleanup } from '../src/store/account-cleanup.js';
import { removePerson } from '../src/store/profiles.js';
import { presence, runs } from '../src/v2/records.js';
import { reportPhase, startChatParticipation, startRun } from '../src/v2/runs.js';
import { sourcesFromStatusDoc, type AgentStatusDoc } from '../src/view/agent-status-doc.js';
import { canonicalStatusSources, deriveAgentState } from '../src/view/communication-agents.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';

// Writers that compare against the wall clock (chat participations, computer approvals) read Date.now: pin it to `at`.
let at = 2_000_000_000_000;
const scope = <T>(work: () => Promise<T>) => inProject(TEST_PROJECT, work);
beforeEach(async () => { await resetEmulator(); at += 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => at); });
afterEach(() => vi.restoreAllMocks());

// Both derivations at `now`, for one agent. complete = the document holds the agent group and the run's end (C3).
async function compare(agentId: string, now = at) {
  return scope(async () => {
    const found = await agents().doc(agentId).get();
    const [actual] = await canonicalStatusSources([found], null);
    // Independent test oracle after run-read retirement: the authoritative run is read directly here only.
    // Keep this separate from the candidate status path so a stale-covered-run mutation still fails the control.
    actual!.run = (await runs().doc(agentId).get()).data();
    const doc = (await presence().doc(agentId).get()).data() as AgentStatusDoc | undefined;
    const operators = await db.runTransaction(tx => activeRecipientOperators(tx, [found.data()!.ownerProfileId]), { readOnly: true });
    const fromDoc = sourcesFromStatusDoc(agentId, doc, { allowed: a => connectionAllowed(a as Agent, operators),
      // Queued from today's open-starts query, as the endpoint takes it (card v15 S4: no start group).
      queued: actual!.queued, ...(actual!.pause ? { pause: actual!.pause } : {}) });
    return { complete: fromDoc !== null, fromDoc: fromDoc && deriveAgentState(fromDoc, now), actual: deriveAgentState(actual!, now), doc };
  });
}
async function expectWritten(writer: string, agentId: string, expected: { state: string; doc: Record<string, unknown> }) {
  const r = await compare(agentId);
  expect(r.actual.state, `${writer}: the sources' state`).toBe(expected.state);
  if (r.complete) expect(r.fromDoc, `${writer}: a complete status document derives the sources' state`).toEqual(r.actual);
  // Real creation/run writers establish an explicit run marker. Mutating another group preserves that marker.
  expect(r.complete, `${writer}: status document complete, got ${JSON.stringify(r.doc)}`).toBe(true);
  expect(r.doc?.agent, `${writer}: agent group written`).toBeDefined();
  expect(r.doc).toMatchObject(expected.doc);
}
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'cs-writers-alice@example.test' }] });
  const personId = f.personIds[0]!;
  const { agentId } = await scope(() => registerAgent(personId, 'alice-fox', () => at));
  return { personId, agentId };
}
const start = (agentId: string) => scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => at));

test('agent creation (registerAgent) writes the agent group, so an agent that never ran has a status document', async () => {
  const { personId } = await fixture();
  const { agentId } = await scope(() => registerAgent(personId, 'carol-cat', () => at)) as { agentId: string };
  await expectWritten('registerAgent', agentId, { state: 'unknown',
    doc: { agent: { name: 'carol-cat', ownerProfileId: personId, revokedAt: null, connectionEpoch: 0, focus: null, personaText: '' } } });
});

test('startRun writes the run group with runEndedAt null and the agent group', async () => {
  const { agentId } = await fixture();
  const run = await start(agentId);
  await expectWritten('startRun', agentId, { state: 'idle', doc: { runId: run.run_id, runEndedAt: null, agent: { revokedAt: null } } });
});

test('reportPhase stopping merges runEndedAt', async () => {
  const { agentId } = await fixture();
  const run = await scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => at));
  await scope(() => reportPhase(agentId, run.run_id, { phase: 'turn' }, () => at));
  at += 1000;
  await scope(() => reportPhase(agentId, run.run_id, { phase: 'stopping' }, () => at));
  await expectWritten('reportPhase stopping', agentId, { state: 'stopped', doc: { runId: run.run_id, runEndedAt: at } });
});

test('control: the comparison accepts the groups a conforming writer would merge and catches a stale run end', async () => {
  const { personId, agentId } = await fixture();
  const run = await start(agentId);
  at += 1000;
  await scope(() => reportPhase(agentId, run.run_id, { phase: 'stopping' }, () => at));
  const agent = { name: 'alice-fox', ownerProfileId: personId, revokedAt: null, connectionEpoch: 0, focus: null, personaText: '' };
  // A run-ending writer that forgot runEndedAt after startRun had written null: complete, and once the stopping contact
  // is older than 90 s it reads Offline while the sources read Stopped.
  await scope(() => presence().doc(agentId).set({ runEndedAt: null, runMode: null, agent } as never, { merge: true }));
  const stale = await compare(agentId, at + 120_000);
  expect(stale.complete).toBe(true);
  expect([stale.fromDoc?.state, stale.actual.state]).toEqual(['offline', 'stopped']);
  await scope(() => presence().doc(agentId).set({ runEndedAt: at } as never, { merge: true }));
  const fixed = await compare(agentId);
  expect([fixed.complete, fixed.fromDoc]).toEqual([true, fixed.actual]);
  expect(fixed.actual.state).toBe('stopped');
});

test('owner revocation (revokeOwned) merges agent.revokedAt and runEndedAt', async () => {
  const { personId, agentId } = await fixture();
  await start(agentId);
  at += 1000;
  await scope(() => revokeOwned(personId, agentId, () => at));
  await expectWritten('revokeOwned', agentId, { state: 'revoked', doc: { runEndedAt: at, agent: { revokedAt: at } } });
});

test('membership cleanup (continueMembershipCleanup) merges agent.revokedAt and runEndedAt for the removed member\'s agents', async () => {
  const { personId, agentId } = await fixture();
  await start(agentId);
  at += 1000;
  // The removal as store.ts writes it: membership removed at a new fence epoch, and a pending cleanup job.
  const owner = { id: 'seed-owner', name: 'Owner', email: 'cs-writers-owner@example.test', removedAt: null };
  await profiles.doc(owner.id).set({ name: owner.name, email: owner.email, removedAt: null } as never);
  await scope(async () => {
    const removed = { status: 'removed' as const, statusChangedAt: at, revision: 2, updatedAt: at };
    await membershipDoc(TEST_PROJECT, personId).update(removed);
    await membershipsOf(personId).doc(TEST_PROJECT).update(removed);
    await membershipFenceDoc(TEST_PROJECT, personId).set({ profileId: personId, projectId: TEST_PROJECT, epoch: 1 });
    await membershipCleanup().doc(personId).set({ operatorId: personId, projectId: TEST_PROJECT, epoch: 1, cursor: '', status: 'pending',
      createdAt: at, updatedAt: at, revoked: 0 });
  });
  expect(await continueMembershipCleanup(owner as unknown as WithId<Profile>, TEST_PROJECT, personId, () => at)).toMatchObject({ status: 'done', revoked: 1 });
  await expectWritten('continueMembershipCleanup', agentId, { state: 'revoked', doc: { runEndedAt: at, agent: { revokedAt: at } } });
});

// A current-chat participation on an approved computer, as chat-controls.test.ts sets it up.
async function chatFixture() {
  const { personId, agentId } = await fixture();
  const computer = randomUUID(), participationId = randomUUID(), approvedAt = at, deadlineAt = at + 600_000;
  await collection('computerConnections').doc(computer).set({ profileId: personId, approvedAt: at, revokedAt: null, connectionExpiresAt: at + 86_400_000 });
  const started = await scope(() => startChatParticipation(agentId, { clientRunId: participationId, runnerVersion: 'synthetic-chat', approvedAt, deadlineAt }, () => at));
  const snapshot = { target: { site: 'https://karma42.ai', ownerId: personId, projectId: TEST_PROJECT, agentId }, participationId, generation: 17,
    state: 'active' as const, scope: 'Status document writer fixture.', approvedAt, deadlineAt,
    cloudRun: { runId: participationId, generation: started.generation, deadlineAt } };
  await syncParticipations(personId, computer, { participations: [snapshot] }, () => at);
  return { personId, agentId, computer, participationId, deadlineAt };
}

test('chat operator stop (requestParticipationControl release) merges runEndedAt', async () => {
  const f = await chatFixture();
  at += 1000;
  await scope(() => requestParticipationControl(f.personId, f.agentId, { id: randomUUID(), kind: 'release', participationId: f.participationId,
    generation: 17, expectedDeadlineAt: f.deadlineAt, approved: true }, () => at));
  await expectWritten('chat operator stop', f.agentId, { state: 'stopped', doc: { runId: f.participationId, runEndedAt: at, runMode: 'current_chat' } });
});

test('project close (endProjectWork) merges runEndedAt for current-chat runs', async () => {
  const f = await chatFixture();
  at += 1000;
  const project = projects.doc(TEST_PROJECT);
  await project.update({ 'execution.completedAt': at, 'execution.paused': true });
  const revision = (await project.get()).data()!.revision;
  await endProjectWork(TEST_PROJECT, () => at, revision, 'closer');
  await expectWritten('endProjectWork', f.agentId, { state: 'stopped', doc: { runId: f.participationId, runEndedAt: at } });
});

test('account removal (removePerson, continueAccountCleanup) merges agent.revokedAt and runEndedAt', async () => {
  const { personId, agentId } = await fixture();
  await start(agentId);
  at += 1000;
  await removePerson(personId, () => at);
  await continueAccountCleanup(personId, () => at);
  const revokedAt = (await scope(() => agents().doc(agentId).get())).data()!.revokedAt;
  await expectWritten('continueAccountCleanup', agentId, { state: 'revoked', doc: { runEndedAt: at, agent: { revokedAt } } });
});

// The groups a conforming writer would already have merged, to start the next writer from a complete document (c1).
async function conformingGroups(agentId: string, personId: string, fields: Record<string, unknown>) {
  const agent = { name: 'alice-fox', ownerProfileId: personId, revokedAt: null, connectionEpoch: 0, focus: null, personaText: '' };
  await scope(() => presence().doc(agentId).set({ agent, runMode: null, ...fields } as never, { merge: true }));
}

test('restart after stop (c1): startRun resets runEndedAt to null under the new runId', async () => {
  const { personId, agentId } = await fixture();
  const first = await start(agentId);
  at += 1000;
  await scope(() => reportPhase(agentId, first.run_id, { phase: 'stopping' }, () => at));
  await conformingGroups(agentId, personId, { runEndedAt: at });  // the stop, as a conforming reportPhase writes it
  at += 1000;
  const second = await start(agentId);
  // A startRun that merges only its run fields keeps the old runEndedAt: the document says Stopped, the sources Idle.
  await expectWritten('startRun after stop', agentId, { state: 'idle', doc: { runId: second.run_id, runEndedAt: null } });
});

test('takeover (c1): the new run has runEndedAt null and the old run\'s worker group is ignored (v2.3 R2)', async () => {
  const { personId, agentId } = await fixture();
  const first = await start(agentId);
  await conformingGroups(agentId, personId, { runEndedAt: null,
    worker: { runId: first.run_id, phase: 'working', deadlineAt: at + 600_000, projectPauseRevision: null, contactAt: at } });
  at += 1000;
  const second = await scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: true }, () => at));
  expect(second.run_id).not.toBe(first.run_id);
  await expectWritten('startRun takeover', agentId, { state: 'idle', doc: { runId: second.run_id, runEndedAt: null, worker: { runId: first.run_id } } });
});

// Queued (card v15 S4): the start group is gone; queued comes from today's open-starts query, as the endpoint reads it
// (current-state.ts), so it covers starts with no agent yet and starts from before any status-document writer. These cases
// keep the queued semantics the group was tested for: Waiting while a pending or accepted start names the agent, until a
// writer expires it (the computer's next pickup, acceptAgentStart, or project close); expiring at the limit is an owner
// option, not tested here.
const keyOf = async (requestId: string) => (await webAgentStarts.where('id', '==', requestId).get()).docs[0]!.id;
const READINESS = { protocol: 1, version: '1.0.0', platform: 'darwin', providers: [{ id: 'codex', available: true, reason: 'ready' }] };
async function queuedFixture() {
  const { personId } = await fixture();
  const { agentId } = await scope(() => registerAgent(personId, 'erin-elk', () => at)) as { agentId: string };
  // One run, ended, so the document is complete (C3 98b01fa3) and queued is what decides Waiting.
  const run = await scope(() => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, () => at));
  await scope(() => reportPhase(agentId, run.run_id, { phase: 'stopping' }, () => at));
  const computer = randomUUID(), requestId = randomUUID(), incarnation = randomUUID();
  await collection('computerConnections').doc(computer).set({ profileId: personId, approvedAt: at, revokedAt: null, connectionExpiresAt: at + 30 * 86_400_000 });
  await createWebAgentStart(personId, { id: requestId, connectionId: computer, projectId: TEST_PROJECT, name: 'erin-elk', agentId,
    execution: { provider: 'codex', model: null }, approved: true }, () => at);
  const start = (await webAgentStarts.where('agentId', '==', agentId).get()).docs[0]!.data();
  return { personId, agentId, computer, requestId, incarnation, start, key: await keyOf(requestId) };
}
const noStartGroup = async (agentId: string) =>
  expect((await scope(() => presence().doc(agentId).get())).data(), 'no start group (S4)').not.toHaveProperty('start');

test('a queued web start for an existing agent (createWebAgentStart) reads Waiting and writes no start group', async () => {
  const { agentId } = await queuedFixture();
  await expectWritten('createWebAgentStart', agentId, { state: 'waiting', doc: {} });
  await noStartGroup(agentId);
});

test('past pickupByAt with no write, both the document and the sources still say Waiting (today\'s semantics, C1)', async () => {
  const { agentId, start } = await queuedFixture();
  at = start.pickupByAt + 1000;
  await expectWritten('no write after pickupByAt', agentId, { state: 'waiting', doc: {} });
});

test('the lazy expiry at the computer\'s next pickup (acceptAgentStart) ends Waiting', async () => {
  const { personId, agentId, computer, requestId, incarnation, start } = await queuedFixture();
  at = start.pickupByAt + 1000;
  await publishRuntimeReadiness(personId, computer, { ...READINESS, incarnation }, () => at);
  expect((await acceptAgentStart(personId, computer, requestId, { incarnation }, () => at)).request).toMatchObject({ state: 'expired' });
  expect((await webAgentStarts.where('agentId', '==', agentId).get()).docs[0]!.data().state).toBe('expired');
  await expectWritten('acceptAgentStart expiry', agentId, { state: 'stopped', doc: {} });
});

test('project close (endProjectWork) cancels a queued start and ends Waiting', async () => {
  const { agentId } = await queuedFixture();
  at += 1000;
  const project = projects.doc(TEST_PROJECT);
  await project.update({ 'execution.completedAt': at, 'execution.paused': true });
  await endProjectWork(TEST_PROJECT, () => at, (await project.get()).data()!.revision, 'closer');
  expect((await webAgentStarts.where('agentId', '==', agentId).get()).docs[0]!.data().state).toBe('expired');
  await expectWritten('endProjectWork queued', agentId, { state: 'stopped', doc: {} });
});

test('agent creation from a computer (connectOwnAgent) writes the agent group (c4)', async () => {
  const { personId } = await fixture();
  const { agentId } = await scope(() => connectOwnAgent(personId, { name: 'dan-dog', candidateTokenHash: hashToken(newToken()), clientName: 'test',
    folder: '/synthetic/c14' }, () => at));
  await expectWritten('connectOwnAgent', agentId, { state: 'unknown', doc: { agent: { name: 'dan-dog', ownerProfileId: personId, revokedAt: null } } });
});

test('a focus report (reportAgentFocus) merges agent.focus with the agents/{id} value (c4)', async () => {
  const { agentId } = await fixture();
  const run = await start(agentId);
  at += 1000;
  await scope(() => reportAgentFocus(agentId, run.run_id, { status: 'Binding writer tests.', client_request_id: 'c14-focus' }, () => at));
  const focus = (await scope(() => agents().doc(agentId).get())).data()!.focus;
  expect(focus?.text).toBe('Binding writer tests.');
  await expectWritten('reportAgentFocus', agentId, { state: 'idle', doc: { agent: { focus: { text: focus!.text, updatedAt: focus!.updatedAt } } } });
});

test('a persona save (saveAgentPersona) merges agent.personaText (c4)', async () => {
  const { personId, agentId } = await fixture();
  await scope(() => saveAgentPersona(personId, agentId, { text: 'Careful reviewer.', expectedRevision: 0 }, () => at));
  expect((await scope(() => agents().doc(agentId).get())).data()!.persona?.text).toBe('Careful reviewer.');
  await expectWritten('saveAgentPersona', agentId, { state: 'unknown', doc: { agent: { personaText: 'Careful reviewer.' } } });
});

test('two starts for one agent: when the older one expires, the agent stays Waiting on the newer (c4\'s map case)', async () => {
  const { personId, agentId, computer, requestId: older, incarnation, start } = await queuedFixture();
  at += 60_000;
  const newer = randomUUID();
  await createWebAgentStart(personId, { id: newer, connectionId: computer, projectId: TEST_PROJECT, name: 'erin-elk', agentId,
    execution: { provider: 'codex', model: null }, approved: true }, () => at);
  at = start.pickupByAt + 1000;  // past the older start's limit, not the newer's
  await publishRuntimeReadiness(personId, computer, { ...READINESS, incarnation }, () => at);
  expect((await acceptAgentStart(personId, computer, older, { incarnation }, () => at)).request).toMatchObject({ state: 'expired' });
  await expectWritten('acceptAgentStart expiry of one of two', agentId, { state: 'waiting', doc: {} });
});

// No time floor (c9, c14): a pending or accepted start whose computer never returns stays Waiting past both limits, from
// the document as from the sources, since queued comes from today's starts query (formerly the pre-S1 gate case).
test('pending and accepted starts with no computer return stay Waiting past their limits, from the document and the sources', async () => {
  const pending = await queuedFixture();
  const accepted = await queuedFixture();
  await webAgentStarts.doc(accepted.key).update({ state: 'accepted', launchByAt: at + 600_000 });
  at = Math.max(pending.start.pickupByAt, at + 600_000) + 86_400_000;  // past both limits; no writer runs
  for (const q of [pending, accepted]) {
    const r = await compare(q.agentId);
    expect(r.actual.state, 'today\'s sources').toBe('waiting');
    expect(r.fromDoc?.state, 'the status document').toBe('waiting');
  }
});

test('recorded, not changed (c9): project close expires pending starts only; an accepted start stays Waiting today', async () => {
  const q = await queuedFixture();
  await webAgentStarts.doc(q.key).update({ state: 'accepted', launchByAt: at + 600_000 });
  at += 1000;
  const project = projects.doc(TEST_PROJECT);
  await project.update({ 'execution.completedAt': at, 'execution.paused': true });
  await endProjectWork(TEST_PROJECT, () => at, (await project.get()).data()!.revision, 'closer');
  expect((await webAgentStarts.doc(q.key).get()).data()!.state).toBe('accepted');
  expect((await compare(q.agentId)).actual.state).toBe('waiting');
});

test('an agentless queued start (C3 b87fabba) is listed by today\'s path', async () => {
  const { personId } = await fixture();
  const computer = randomUUID(), requestId = randomUUID();
  await collection('computerConnections').doc(computer).set({ profileId: personId, approvedAt: at, revokedAt: null, connectionExpiresAt: at + 30 * 86_400_000 });
  await createWebAgentStart(personId, { id: requestId, connectionId: computer, projectId: TEST_PROJECT, name: 'new-newt',
    execution: { provider: 'codex', model: null }, approved: true }, () => at);
  const key = await keyOf(requestId);
  expect((await projectQueuedStarts(TEST_PROJECT, at)).map(r => r.id)).toEqual([`queued-${key}`]);
  // Recorded, not changed: today's agentless path lists a start only while pickupByAt > now, unlike agent starts above.
  const start = (await webAgentStarts.doc(key).get()).data()!;
  expect(await projectQueuedStarts(TEST_PROJECT, start.pickupByAt + 1000)).toEqual([]);
});

test('a never-run agent\'s start: Waiting from sources; lazy expiry ends it and the agent reads Unknown (c9)', async () => {
  const { personId } = await fixture();
  // Real registration writes the explicit no-run marker; a queued start does not invent a run.
  const { agentId } = await scope(() => registerAgent(personId, 'nova-newt', () => at)) as { agentId: string };
  const computer = randomUUID(), requestId = randomUUID(), incarnation = randomUUID();
  await collection('computerConnections').doc(computer).set({ profileId: personId, approvedAt: at, revokedAt: null, connectionExpiresAt: at + 30 * 86_400_000 });
  await createWebAgentStart(personId, { id: requestId, connectionId: computer, projectId: TEST_PROJECT, name: 'nova-newt', agentId,
    execution: { provider: 'codex', model: null }, approved: true }, () => at);
  const start = (await webAgentStarts.doc(await keyOf(requestId)).get()).data()!;
  await expectWritten('createWebAgentStart, never run', agentId, { state: 'waiting', doc: {} });
  at = start.pickupByAt + 1000;
  await publishRuntimeReadiness(personId, computer, { ...READINESS, incarnation }, () => at);
  expect((await acceptAgentStart(personId, computer, requestId, { incarnation }, () => at)).request).toMatchObject({ state: 'expired' });
  await expectWritten('acceptAgentStart expiry, never run', agentId, { state: 'unknown', doc: {} });
});
