import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db, inProject, profiles } from '../src/firestore.js';
import { journeyId, projectJourneys, recordProjectVisit } from '../src/onboarding/journeys.js';
import { onboardingDistribution as distribution } from '@mlswarm/contracts';
import { readOnboardingTimings } from '../src/platform/onboarding.js';
import { platformRoutes } from '../src/platform/routes.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { humanChatRoutes } from '../src/projects/chat.js';
import { createPrivateProject } from '../src/projects/private.js';
import { connectOwnAgent } from '../src/owner/agents.js';
import { publishRuntimeReadiness } from '../src/owner/web-agent-starts.js';
import { startRun, reportPhase, recordContact } from '../src/v2/runs.js';
import { reportTurn } from '../src/v2/turn-reports.js';
import { syncWorkerSession } from '../src/projects/worker-sessions.js';
import { submitSteering } from '../src/projects/steering.js';
import { membershipDoc } from '../src/projects/access.js';
import { exportPerson } from '../src/store/person-export.js';
import { hashToken, newToken } from '../src/auth.js';
import { ownerRoutes } from '../src/owner/routes.js';
import { idTokenFor, resetEmulator, seedRuntime, setTestMembership } from './helpers.js';
const initial = 2_000_000_000_000;
let at: number;
const now = () => at;
const owner = { id: 'founder', name: 'Founder', email: 'founder@example.test', removedAt: null };
const founder = { kind: 'person' as const, operatorId: owner.id, adminAuthenticated: true, verifiedGithubSession: true };
async function project(title = 'Synthetic') { return (await createPrivateProject(owner, { client_request_id: randomUUID(), title, goal: 'Disposable timing verification', githubUrl: 'https://github.com/example/test' }, now) as { id: string }).id; }
// A private-project member who joined by invitation before invitations were removed: the stored membership and
// fully recorded journey stay readable.
async function invited(id: string, email = 'person@example.test') {
  const person = { id: hashToken(`invited-profile:${email}`), name: 'Person', email, removedAt: null };
  await profiles.doc(person.id).set({ name: person.name, email, removedAt: null });
  return { person, accept: async () => {
    await setTestMembership(id, person.id, 'active', at);
    await projectJourneys.doc(journeyId(person.id, id)).set({ profileId: person.id, projectId: id, enteredAt: initial, source: 'invitation', recordingFromEntry: true,
      milestones: { joined: at, accepted: at }, reused: { computer: false, github: false }, humanActivity: { firstAt: null, lastAt: null, chatMessages: 0, steeringCommands: 0 } });
  } };
}
const evidence = () => ({ kind: 'work', outcome: 'succeeded' as const, endedAt: at, usage: { sequence: 1, model: 'synthetic', seconds: 1, tokens: { input: 1, output: 1, modelCalls: 1, cacheRead: 0, cacheWrite: 0 } } });
beforeEach(async () => { await resetEmulator(); at = initial; await profiles.doc(owner.id).set(owner); });
test('only accepted human chat/steering count, exactly once; visits and agent completion stay separate and project-isolated', async () => {
  const first = await project('First'), second = await project('Second'), f = await invited(first); await f.accept();
  const f2 = await invited(second); await f2.accept();
  // Native work reports require an actually started, unpaused project.
  await seedRuntime(first, { started: true, paused: false });
  at += 1000; await recordProjectVisit(f.person, first, now);
  const token = await idTokenFor(f.person.email), body = { client_request_id: randomUUID(), body: 'Private human text NEVER_COPY' };
  const post = () => fetch(`${base}/chat/${first}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post()).status).toBe(200); at += 1000; expect((await post()).status).toBe(200);
  await inProject(first, async () => {
    const connected = await connectOwnAgent(f.person.id, { name: 'worker', candidateTokenHash: hashToken(newToken()), clientName: 'test', folder: 'C:\\Synthetic path' }, now);
    const run = await startRun(connected.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic', takeover: false }, now);
    await recordContact(connected.agentId, run.run_id, at); await reportPhase(connected.agentId, run.run_id, { phase: 'turn' }, now);
    expect((await projectJourneys.doc(journeyId(f.person.id, first)).get()).data()?.milestones.firstWork).toBeUndefined();
    await syncWorkerSession(connected.agentId, { run_id: run.run_id, missionId: run.run_id, generation: 1, startedAt: at, remainingSlots: 64, phase: 'waiting' }, now);
    const command = { operationId: randomUUID(), agentId: connected.agentId, missionId: run.run_id, generation: 1, body: 'Private steering NEVER_COPY', origin: 'coding_chat' };
    await submitSteering(f.person.id, command, now); at += 1000; await submitSteering(f.person.id, command, now);
    await expect(submitSteering(owner.id, { ...command, operationId: randomUUID() }, now)).rejects.toMatchObject({ code: 'forbidden' });
    const completion = evidence();
    await reportTurn(connected.agentId, run.run_id, completion, now);
    at += 1000; await reportPhase(connected.agentId, run.run_id, { phase: 'idle', lastTurn: completion }, now);
  });
  const result = await readOnboardingTimings(founder, {}, now), a = result.journeys.find(j => j.projectId === first)!, b = result.journeys.find(j => j.projectId === second)!;
  expect(a.humanActivity).toMatchObject({ chatMessages: 1, steeringCommands: 1 });
  expect(a.milestones.firstVisit).toBe(initial + 1000); expect(a.elapsed.firstSteering).toBe(2000); expect(a.elapsed.firstWork).toBe(3000);
  expect(b.milestones.firstSteering).toBeUndefined(); expect(b.milestones.firstWork).toBeUndefined(); expect(b.humanActivity.firstAt).toBeNull();
  const recorded = JSON.stringify((await projectJourneys.get()).docs.map(d => d.data()));
  expect(recorded).not.toContain('NEVER_COPY'); expect(recorded).not.toContain('recipientEmail');
  expect(JSON.stringify(result)).not.toContain('candidateTokenHash');
  const exported = await exportPerson(f.person.id, now); expect(exported.records.some(r => r.path === `onboardingJourneys/${a.id}`)).toBe(true);
});
test('computer approval and GitHub readiness are real account observations reused by matching project journeys', async () => {
  const id = await project(), f = await invited(id); await f.accept(); const token = await idTokenFor(f.person.email), connectionId = randomUUID();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  expect((await fetch(`${base}/owner/connect`, { method: 'POST', headers, body: JSON.stringify({ requestId: connectionId, pollingSecret: newToken(), candidateTokenHash: hashToken(newToken()), clientName: 'Windows computer' }) })).status).toBe(200);
  at += 1000;
  const approve = () => fetch(`${base}/owner/connect/${connectionId}/approve`, { method: 'POST', headers, body: '{"approved":true}' });
  expect((await approve()).status).toBe(200); at += 1000; expect((await approve()).status).toBe(200);
  await publishRuntimeReadiness(f.person.id, connectionId, { protocol: 1, version: 'test', incarnation: randomUUID(), platform: 'win32', github: 'ready', providers: [] }, now);
  const result = await readOnboardingTimings(founder, {}, now);
  expect(result.journeys[0].elapsed).toMatchObject({ computer: 1000, github: 2000 });
});
test('bounded timing reads disclose partial sets, validate query, exclude removed accounts and reject non-admins', async () => {
  const id = await project(), f = await invited(id); await f.accept();
  const template = (await projectJourneys.doc(journeyId(f.person.id, id)).get()).data()!;
  const batch = db.batch(); for (let i = 0; i < 500; i++) batch.set(projectJourneys.doc(`synthetic-${i}`), { ...template, profileId: `unregistered-${i}`, enteredAt: at - i }); await batch.commit();
  const result = await readOnboardingTimings(founder, {}, now); expect(result.scope.truncated).toBe(true); expect(result.scope.recordsChecked).toBe(500);
  await expect(readOnboardingTimings({ ...founder, adminAuthenticated: false }, { days: 'invalid' }, now)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(readOnboardingTimings(founder, { days: '9999' }, now)).rejects.toMatchObject({ code: 'bad_input' });
  await profiles.doc(f.person.id).update({ removedAt: at });
  expect((await readOnboardingTimings(founder, {}, now)).journeys.some(j => j.profileId === f.person.id)).toBe(false);
});
test('distribution reports sample coverage, median, p90 and fastest/slowest without fabricated zero', () => {
  expect(distribution([])).toEqual({ samples: 0, medianMs: null, p90Ms: null, minMs: null, maxMs: null });
  expect(distribution([10, 30, 20, 40, -1, NaN])).toEqual({ samples: 4, medianMs: 25, p90Ms: 40, minMs: 10, maxMs: 40 });
});
let server: Server, base: string;
beforeAll(async () => { const app = express(); app.use('/owner', ownerRoutes(now)); app.use('/projects', projectManagementRoutes(now)); app.use('/chat', humanChatRoutes(now)); app.use(platformRoutes(now)); server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });
test('visit endpoint is profile-fenced, membership checked, no-store, and never counts as human action', async () => {
  const id = await project(), f = await invited(id); await f.accept(); const token = await idTokenFor(f.person.email);
  const headers = { authorization: `Bearer ${token}`, 'x-mlswarm-profile-id': f.person.id, 'content-type': 'application/json' };
  const visit = (h = headers) => fetch(`${base}/projects/${id}/visit`, { method: 'POST', headers: h, body: '{}' });
  const result = await visit(); expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
  expect((await visit({ ...headers, 'x-mlswarm-profile-id': 'other' })).status).toBe(401);
  await membershipDoc(id, f.person.id).update({ status: 'left' }); expect((await visit()).status).toBe(401);
  const journey = (await projectJourneys.doc(journeyId(f.person.id, id)).get()).data()!; expect(journey.humanActivity.firstAt).toBeNull(); expect(journey.milestones.firstVisit).toBe(at);
});
test('admin HTTP requires verified current co-founder session, prevents caching and clears removed authority', async () => {
  const old = process.env.ADMIN_EMAILS; process.env.ADMIN_EMAILS = owner.email;
  try {
    const token = await idTokenFor(owner.email), headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/onboarding`)).status).toBe(401);
    const result = await fetch(`${base}/onboarding`, { headers }); expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    await profiles.doc(owner.id).update({ removedAt: at }); expect((await fetch(`${base}/onboarding`, { headers })).status).toBe(401);
  } finally { if (old === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = old; }
});
