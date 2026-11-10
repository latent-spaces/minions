import { beforeEach, expect, test } from 'vitest';
import { HOSTING_LIMITS, parseArtifact, artifactMime, sha256, type HostingServingHead } from '@mlswarm/contracts';
import { agents, inProject, profiles } from '../src/firestore.js';
import { randomUUID } from 'node:crypto';
import { startRun } from '../src/v2/runs.js';
import { computerConnections } from '../src/owner/computer-access.js';
import { projectListings } from '../src/projects/catalog.js';
import { DEFAULT_WORKSPACE_ID } from '../src/workspaces/schema.js';
import { projects } from '../src/projects/records.js';
import { membershipDoc } from '../src/projects/access.js';
import { configureHosting, prepareHosting, uploadHostingFile, sealHosting, requestHostingPublication,
  requestHostingUnpublish, applyHostingOperation, readHosting, hostingUploadStatus, reconcileHostingOperations, readPublicHosting } from '../src/hosting/service.js';
import { reconcileHostingCleanup, hostingCleanupRef } from '../src/hosting/cleanup.js';
import { hostingCandidates, hostingState } from '../src/hosting/records.js';
import type { HostingTransport } from '../src/hosting/transport.js';
import type { HostingActor } from '../src/hosting/authority.js';
import { resetEmulator, seed, seedRuntime, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const now = () => 10000;
class Transport implements HostingTransport {
  calls: string[] = []; head: HostingServingHead | null = null; loseReply = false; tamperReply = false;
  manifests = new Map<string, Awaited<ReturnType<typeof parseArtifact>>>();
  async command(project: string, path: string, body?: unknown, method?: string) {
    this.calls.push(`${project}:${method ?? 'POST'}:${path}`);
    if ((path.startsWith('cleanup/') || path.startsWith('audit/'))) return { candidateId: path.split('/')[1], scope: (body as { scope: string }).scope, done: true, deleted: 0 };
    if (path.startsWith('prepare/')) {
      const input = body as { manifest: unknown };
      const artifact = await parseArtifact(input.manifest); this.manifests.set(path.split('/')[1], artifact);
      return { digest: artifact.digest };
    }
    if (path.startsWith('seal/')) {
      const artifact = this.manifests.get(path.split('/')[1])!;
      return { digest: artifact.digest, bytes: artifact.bytes, sealed: true };
    }
    if (path.startsWith('status/')) return { digest: this.manifests.get(path.split('/')[1])!.digest, uploaded: [] };
    if (method === 'GET') return { head: this.head };
    const input = body as { operationId: string; artifact: string | null; candidateId: string | null; generation: number; expectedRevision: number };
    if ((this.head?.generation ?? 0) >= input.generation || (this.head?.revision ?? 0) !== input.expectedRevision) throw new Error('Synthetic CAS conflict');
    this.head = { version: 1, revision: (this.head?.revision ?? 0) + 1, generation: input.generation,
      operationId: input.operationId, intent: await sha256(JSON.stringify({ operationId: input.operationId, generation: input.generation, artifact: input.artifact, candidateId: input.candidateId })), current: input.artifact, disabled: input.artifact === null,
      releases: input.artifact ? [{ artifact: input.artifact, buildId: input.candidateId!, retiredAt: null, bytes: 1 }] : [] };
    if (this.loseReply) { this.loseReply = false; throw new Error('Synthetic acknowledgement loss'); }
    if (this.tamperReply) { this.tamperReply = false; return { ...this.head, intent: 'f'.repeat(64) }; }
    return this.head as unknown as Record<string, unknown>;
  }
  async upload(_project: string, candidate: string, index: number) { this.calls.push(`upload:${candidate}:${index}`); }
}
async function fixture(mode: 'approval' | 'automatic' = 'approval') {
  const seeded = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }, { name: 'Submitter', email: 'submit@example.test' },
    { name: 'Approver', email: 'approve@example.test' }, { name: 'Other', email: 'other@example.test' }],
    agents: [{ person: 0, name: 'Synthetic owner agent' }] });
  await projects.doc(TEST_PROJECT).update({ ownerProfileId: seeded.personIds[0] });
  const actors: HostingActor[] = await Promise.all(seeded.personIds.map(async id => ({ kind: 'person' as const, person: { id, ...(await profiles.doc(id).get()).data()! } })));
  const [owner, submitter, approver, other] = actors, transport = new Transport();
  const settings = { clientRequestId: 'configure', expectedRevision: 0, confirmPublic: true as const, mode,
    approvers: [seeded.personIds[2]], submitters: [seeded.personIds[1]] };
  await configureHosting(TEST_PROJECT, owner, settings, now);
  const text = '<h1>Synthetic hosting fixture</h1>';
  const artifact = await parseArtifact({ version: 1, entry: 'index.html', files: [{ path: 'index.html', bytes: Buffer.byteLength(text), sha256: await sha256(text), mime: artifactMime('index.html') }] });
  const input = { clientRequestId: 'candidate', policyRevision: 1, manifest: artifact.manifest };
  const prepare = () => prepareHosting(TEST_PROJECT, submitter, input, now, transport);
  const candidate = await prepare();
  const ready = async () => {
    await uploadHostingFile(TEST_PROJECT, submitter, candidate.candidateId, 0, Buffer.from(text), now, transport);
    await sealHosting(TEST_PROJECT, submitter, candidate.candidateId, now, transport);
  };
  const publishInput = { clientRequestId: 'publish', policyRevision: 1, candidateId: candidate.candidateId };
  return { owner, submitter, approver, other, seeded, settings, artifact, text, transport, candidate, prepare, ready, input, publishInput };
}
test('owner configuration, exact-artifact approval and actual acknowledgement are separate authorities', async () => {
  const f = await fixture();
  await expect(configureHosting(TEST_PROJECT, f.approver, { ...f.settings, clientRequestId: 'steal', expectedRevision: 1 }, now)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now)).rejects.toMatchObject({ code: 'intent_conflict' });
  await f.ready();
  await expect(requestHostingPublication(TEST_PROJECT, f.submitter, f.publishInput, now)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(requestHostingPublication(TEST_PROJECT, f.owner, f.publishInput, now)).rejects.toMatchObject({ code: 'forbidden' });
  const op = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  expect(op.state).toBe('queued'); expect(f.transport.head).toBeNull();
  const applied = await applyHostingOperation(TEST_PROJECT, f.approver, op.id, now, f.transport);
  expect(applied.state).toBe('published');
  expect(f.transport.head?.current).toBe(f.artifact.digest);
  expect((await readHosting(TEST_PROJECT, f.owner, undefined, now)).observedArtifact).toBe(f.artifact.digest);
});
test('reservation and publication receipts replay without double counting; altered input conflicts', async () => {
  const f = await fixture(); await f.prepare(); await f.prepare();
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(f.artifact.bytes);
  expect((await hostingState(TEST_PROJECT).get()).data()?.candidates).toBe(1);
  await expect(prepareHosting(TEST_PROJECT, f.submitter, { ...f.input, manifest: { ...f.artifact.manifest, entry: 'other.html' } }, now, f.transport)).rejects.toThrow();
  await f.ready(); const op = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  expect((await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now)).id).toBe(op.id);
  await expect(requestHostingPublication(TEST_PROJECT, f.approver, { ...f.publishInput, candidateId: 'b'.repeat(64) }, now)).rejects.toMatchObject({ code: 'intent_conflict' });
});
test('removed/rejoined approver and policy revisions cannot reuse a designation or pending build', async () => {
  const f = await fixture(); await f.ready();
  await membershipDoc(TEST_PROJECT, f.seeded.personIds[2]).update({ status: 'removed', connectionEpoch: 1 });
  await expect(requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now)).rejects.toMatchObject({ code: 'unauthorized' });
  await membershipDoc(TEST_PROJECT, f.seeded.personIds[2]).update({ status: 'active' });
  await expect(requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now)).rejects.toMatchObject({ code: 'forbidden' });
  await configureHosting(TEST_PROJECT, f.owner, { ...f.settings, clientRequestId: 'new-policy', expectedRevision: 1 }, now);
  await expect(requestHostingPublication(TEST_PROJECT, f.approver, { ...f.publishInput, policyRevision: 2 }, now)).rejects.toMatchObject({ code: 'intent_conflict' });
});
test('automatic mode requires a current designated submitter; preparing a build does not publish it', async () => {
  const f = await fixture('automatic'); await f.ready();
  expect(f.transport.head).toBeNull();
  await expect(requestHostingPublication(TEST_PROJECT, f.other, f.publishInput, now)).rejects.toMatchObject({ code: 'forbidden' });
  const op = await requestHostingPublication(TEST_PROJECT, f.submitter, f.publishInput, now);
  expect((await applyHostingOperation(TEST_PROJECT, f.submitter, op.id, now, f.transport)).state).toBe('published');
});
test('lost acknowledgements stay uncertain until exact observed state is recovered by owner', async () => {
  const f = await fixture(); await f.ready(); const op = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  f.transport.loseReply = true;
  expect((await applyHostingOperation(TEST_PROJECT, f.approver, op.id, now, f.transport)).state).toBe('uncertain');
  await membershipDoc(TEST_PROJECT, f.seeded.personIds[2]).update({ status: 'removed' });
  expect((await applyHostingOperation(TEST_PROJECT, f.owner, op.id, now, f.transport)).state).toBe('published');
  expect(f.transport.calls.filter(path => path.endsWith('POST:head'))).toHaveLength(1);
});
test('Unpublish supersedes queued publication, disables policy and is available on closed projects', async () => {
  const f = await fixture(); await f.ready(); const pending = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  await seedRuntime(TEST_PROJECT, { completedAt: 1000, paused: true });
  const stop = await requestHostingUnpublish(TEST_PROJECT, f.owner, { clientRequestId: 'stop' }, now);
  expect((await applyHostingOperation(TEST_PROJECT, f.owner, stop.id, now, f.transport)).state).toBe('unpublished');
  expect((await applyHostingOperation(TEST_PROJECT, f.approver, pending.id, now, f.transport)).state).toBe('superseded');
  expect(f.transport.head?.disabled).toBe(true);
  expect((await hostingState(TEST_PROJECT).get()).data()?.policy.enabled).toBe(false);
});
test('cross-project candidate substitution, unauthorized reads and removal never expose a manifest', async () => {
  const f = await fixture(); await f.ready();
  const original = (await hostingCandidates(TEST_PROJECT).doc(f.candidate.candidateId).get()).data()!;
  await hostingCandidates(TEST_PROJECT).doc(f.candidate.candidateId).set({ ...original, projectId: 'c'.repeat(64) });
  await expect(requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now)).rejects.toMatchObject({ code: 'intent_conflict' });
  await profiles.doc(f.seeded.personIds[3]).update({ removedAt: 2000 });
  await expect(readHosting(TEST_PROJECT, f.other, undefined, now)).rejects.toMatchObject({ code: 'unauthorized' });
  const result = await inProject(TEST_PROJECT, () => readHosting(TEST_PROJECT, f.owner, undefined, now));
  expect(JSON.stringify(result)).not.toContain('Synthetic hosting fixture');
});
test('owner status grants no implicit upload authority to a person or their agent; revoked computers stay fenced', async () => {
  const f = await fixture('automatic'), agentId = f.seeded.agents[0].agentId;
  const run = await inProject(TEST_PROJECT, () => startRun(agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
  const agent = await inProject(TEST_PROJECT, async () => ({ id: agentId, ...(await agents().doc(agentId).get()).data()! }));
  const actor: HostingActor = { kind: 'agent', agent, runId: run.run_id };
  await expect(prepareHosting(TEST_PROJECT, f.owner, { ...f.input, clientRequestId: 'owner-person' }, now, f.transport)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(prepareHosting(TEST_PROJECT, actor, { ...f.input, clientRequestId: 'owner-agent' }, now, f.transport)).rejects.toMatchObject({ code: 'forbidden' });
  await configureHosting(TEST_PROJECT, f.owner, { ...f.settings, clientRequestId: 'explicit-owner-grant', expectedRevision: 1,
    submitters: [...f.settings.submitters, f.seeded.personIds[0]] }, now);
  const allowed = await prepareHosting(TEST_PROJECT, actor, { ...f.input, clientRequestId: 'explicit-owner-agent', policyRevision: 2 }, now, f.transport);
  await computerConnections.doc('hosting-test-computer').set({ requestId: 'synthetic', pollingSecretHash: 'a'.repeat(64), candidateTokenHash: 'b'.repeat(64),
    clientName: 'Synthetic computer', createdAt: 1000, expiresAt: 2000, approvedAt: 1000, revokedAt: 10001,
    connectionExpiresAt: 1000000, profileId: f.seeded.personIds[0], firebaseUid: 'synthetic', authenticatedAt: 1000 });
  await inProject(TEST_PROJECT, () => agents().doc(agentId).update({ computerConnectionId: 'hosting-test-computer' }));
  const before = f.transport.calls.length;
  await expect(hostingUploadStatus(TEST_PROJECT, actor, allowed.candidateId, now, f.transport)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(f.transport.calls).toHaveLength(before);
});
test('a mismatched semantic acknowledgement stays uncertain and recovers only from exact observed intent', async () => {
  const f = await fixture(); await f.ready(); const op = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  f.transport.tamperReply = true;
  expect((await applyHostingOperation(TEST_PROJECT, f.approver, op.id, now, f.transport)).state).toBe('uncertain');
  expect((await applyHostingOperation(TEST_PROJECT, f.owner, op.id, now, f.transport)).state).toBe('published');
  expect(f.transport.calls.filter(path => path.endsWith('POST:head'))).toHaveLength(1);
});
test('expired upload retries preserve reservations and require a new intent instead of silently restarting', async () => {
  const f = await fixture();
  const later = () => f.candidate.expiresAt + 1;
  await expect(prepareHosting(TEST_PROJECT, f.submitter, f.input, later, f.transport)).rejects.toMatchObject({ code: 'hosting_upload_expired' });
  await expect(hostingUploadStatus(TEST_PROJECT, f.submitter, f.candidate.candidateId, later, f.transport)).rejects.toMatchObject({ code: 'hosting_upload_expired' });
  expect((await readHosting(TEST_PROJECT, f.owner, undefined, later)).candidates[0].state).toBe('expired');
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(f.artifact.bytes);
});

test('private recovery claims each due intent once and never creates a new approval', async () => {
  const f = await fixture(); await f.ready();
  const op = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  const rounds = await Promise.all([reconcileHostingOperations(now, f.transport), reconcileHostingOperations(now, f.transport)]);
  expect(rounds.reduce((sum, round) => sum + round.retried, 0)).toBe(1);
  expect((await readHosting(TEST_PROJECT, f.owner, undefined, now)).observedArtifact).toBe(f.artifact.digest);
  expect(f.transport.calls.filter(path => path.endsWith('POST:head'))).toHaveLength(1);
  expect(op.approvedBy?.profileId).toBe(f.seeded.personIds[2]);
});
test('worker rechecks revoked authority before dispatch but can observe a committed lost acknowledgement', async () => {
  const f = await fixture(); await f.ready();
  await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  await membershipDoc(TEST_PROJECT, f.seeded.personIds[2]).update({ status: 'removed' });
  expect((await reconcileHostingOperations(now, f.transport)).failed).toBe(1);
  expect(f.transport.head).toBeNull();
  expect((await reconcileHostingOperations(now, f.transport)).retried, 'persisted backoff prevents hot retries').toBe(0);
  // An owner can always supersede that blocked operation with a new takedown intent.
  await requestHostingUnpublish(TEST_PROJECT, f.owner, { clientRequestId: 'worker-stop' }, now);
  f.transport.loseReply = true;
  expect((await reconcileHostingOperations(now, f.transport)).failed).toBe(1);
  expect(f.transport.head?.disabled).toBe(true);
  expect((await reconcileHostingOperations(() => now() + 60001, f.transport)).failed).toBe(0);
  expect((await readHosting(TEST_PROJECT, f.owner, undefined, now)).operation).toBeNull();
  expect(f.transport.calls.filter(path => path.endsWith('POST:head'))).toHaveLength(1);
});

test('anonymous output discovery rechecks public listing and returns no policy or candidate metadata', async () => {
  const f = await fixture(); await f.ready();
  const op = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  await applyHostingOperation(TEST_PROJECT, f.approver, op.id, now, f.transport);
  await expect(readPublicHosting(TEST_PROJECT)).rejects.toMatchObject({ code: 'not_found' });
  await projects.doc(TEST_PROJECT).update({ publication: { listed: true, revision: 1 } });
  await projectListings.doc(TEST_PROJECT).set({ workspaceId: DEFAULT_WORKSPACE_ID, title: 'Synthetic', summary: 'Synthetic', category: 'games', tags: [], ownerName: 'Owner', revision: 1, publishedAt: 1, updatedAt: 1, prefixes: [] });
  const result = await readPublicHosting(TEST_PROJECT);
  expect(Object.keys(result)).toEqual(['publishedUrl']);
  await projects.doc(TEST_PROJECT).update({ approval: null, publication: { listed: false, revision: 2 }, privacy: { visibility: 'private', messageProtection: 'server_readable_v1', createdAt: 1 } });
  await expect(readPublicHosting(TEST_PROJECT)).rejects.toMatchObject({ code: 'not_found' });
});

async function replaceBuild(f: Awaited<ReturnType<typeof fixture>>, at: number) {
  const clock = () => at;
  const next = await prepareHosting(TEST_PROJECT, f.submitter, { ...f.input, clientRequestId: `replacement-${at}` }, clock, f.transport);
  await uploadHostingFile(TEST_PROJECT, f.submitter, next.candidateId, 0, Buffer.from(f.text), clock, f.transport);
  await sealHosting(TEST_PROJECT, f.submitter, next.candidateId, clock, f.transport);
  const operation = await requestHostingPublication(TEST_PROJECT, f.approver, { ...f.publishInput, candidateId: next.candidateId, clientRequestId: `publish-${at}` }, clock);
  await applyHostingOperation(TEST_PROJECT, f.approver, operation.id, clock, f.transport);
  return next;
}
test('expired abandoned upload is reclaimed exactly once only after confirmed scoped deletion', async () => {
  const f = await fixture(), at = f.candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs;
  expect((await reconcileHostingCleanup(() => at - 1, f.transport)).attempted).toBe(0);
  const before = (await hostingState(TEST_PROJECT).get()).data()!.reservedBytes;
  const command = f.transport.command.bind(f.transport); let calls = 0;
  f.transport.command = async (project, path, body, method) => {
    if (!(path.startsWith('cleanup/') || path.startsWith('audit/'))) return command(project, path, body, method);
    calls++;
    if (calls === 1) return { done: false, deleted: 200, scope: 'all', candidateId: f.candidate.candidateId };
    if (calls === 2) throw new Error('Synthetic lost deletion acknowledgement');
    return command(project, path, body, method);
  };
  expect((await reconcileHostingCleanup(() => at, f.transport)).releasedBytes).toBe(0);
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(before);
  expect((await hostingCandidates(TEST_PROJECT).doc(f.candidate.candidateId).get()).data()?.state).toBe('deleting');
  await expect(prepareHosting(TEST_PROJECT, f.submitter, f.input, () => at, f.transport)).rejects.toMatchObject({ code: 'hosting_upload_expired' });
  expect((await reconcileHostingCleanup(() => at + 1, f.transport)).failed).toBe(1);
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(before);
  const result = await reconcileHostingCleanup(() => at + 120001, f.transport);
  expect(result.releasedBytes).toBe(f.artifact.bytes);
  expect((await hostingState(TEST_PROJECT).get()).data()).toMatchObject({ reservedBytes: 0, candidates: 0 });
  expect((await hostingCandidates(TEST_PROJECT).doc(f.candidate.candidateId).get()).exists).toBe(false);
  await expect(prepareHosting(TEST_PROJECT, f.submitter, f.input, () => at + 120001, f.transport)).rejects.toMatchObject({ code: 'hosting_upload_expired' });
  expect((await reconcileHostingCleanup(() => at + 240001, f.transport)).releasedBytes).toBe(0);
  const fresh = await prepareHosting(TEST_PROJECT, f.submitter, { ...f.input, clientRequestId: 'new-upload-after-cleanup' }, () => at + 240001, f.transport);
  expect(fresh.candidateId).not.toBe(f.candidate.candidateId);
});
test('current build and valid approval candidate retain final payload reservations while staging is cleaned', async () => {
  const f = await fixture(); await f.ready();
  const operation = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  await applyHostingOperation(TEST_PROJECT, f.approver, operation.id, now, f.transport);
  const pending = await prepareHosting(TEST_PROJECT, f.submitter, { ...f.input, clientRequestId: 'awaiting-human' }, now, f.transport);
  await sealHosting(TEST_PROJECT, f.submitter, pending.candidateId, now, f.transport);
  const scopes: unknown[] = [], original = f.transport.command.bind(f.transport);
  f.transport.command = async (project, path, body, method) => { if ((path.startsWith('cleanup/') || path.startsWith('audit/'))) scopes.push(body); return original(project, path, body, method); };
  const result = await reconcileHostingCleanup(() => f.candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs, f.transport);
  expect(result.attempted).toBe(2); expect(result.releasedBytes).toBe(0);
  expect(scopes).toHaveLength(2); expect(scopes.every(scope => (scope as { scope: string }).scope === 'staging')).toBe(true);
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(2 * f.artifact.bytes);
  expect((await hostingCandidates(TEST_PROJECT).doc(pending.candidateId).get()).data()?.state).toBe('ready');
});
test('replacement of identical bytes retires the previous upload identity for 24 hours', async () => {
  const f = await fixture(); await f.ready();
  const operation = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, now);
  await applyHostingOperation(TEST_PROJECT, f.approver, operation.id, now, f.transport);
  const at = 20000, current = await replaceBuild(f, at), due = at + HOSTING_LIMITS.retirementGraceMs;
  expect((await readHosting(TEST_PROJECT, f.owner, undefined, now)).observedCandidate).toBe(current.candidateId);
  expect((await hostingState(TEST_PROJECT).get()).data()?.retiredBuilds[f.candidate.candidateId]).toBe(at);
  expect((await reconcileHostingCleanup(() => due - 1, f.transport)).releasedBytes).toBe(0);
  expect((await reconcileHostingCleanup(() => due, f.transport)).releasedBytes).toBe(f.artifact.bytes);
  expect((await hostingCandidates(TEST_PROJECT).doc(current.candidateId).get()).exists).toBe(true);
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(f.artifact.bytes);
});
test('policy-invalidated ready builds become abandoned after policy grace; publication in flight blocks cleanup', async () => {
  const f = await fixture(); await f.ready();
  const at = 20000;
  await configureHosting(TEST_PROJECT, f.owner, { ...f.settings, expectedRevision: 1, clientRequestId: 'retire-policy' }, () => at);
  expect((await reconcileHostingCleanup(() => at + HOSTING_LIMITS.retirementGraceMs - 1, f.transport)).attempted).toBe(0);
  // An accepted pending intent is protected even when another candidate is due.
  const stop = await requestHostingUnpublish(TEST_PROJECT, f.owner, { clientRequestId: 'pending-stop' }, () => at);
  expect((await reconcileHostingCleanup(() => at + HOSTING_LIMITS.retirementGraceMs, f.transport)).attempted).toBe(0);
  expect((await hostingCandidates(TEST_PROJECT).doc(f.candidate.candidateId).get()).data()?.state).toBe('ready');
  await applyHostingOperation(TEST_PROJECT, f.owner, stop.id, () => at, f.transport);
  expect((await reconcileHostingCleanup(() => at + HOSTING_LIMITS.retirementGraceMs + 60000, f.transport)).releasedBytes).toBe(f.artifact.bytes);
});
test('parallel cleanup rounds claim once; exhausted retries preserve reservations for operator review', async () => {
  const f = await fixture(), at = f.candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs;
  const results = await Promise.all([reconcileHostingCleanup(() => at, f.transport), reconcileHostingCleanup(() => at, f.transport)]);
  expect(results.reduce((total, result) => total + result.releasedBytes, 0)).toBe(f.artifact.bytes);
  expect((await hostingState(TEST_PROJECT).get()).data()?.candidates).toBe(0);
  const next = await prepareHosting(TEST_PROJECT, f.submitter, { ...f.input, clientRequestId: 'exhausted' }, () => at, f.transport);
  await hostingCleanupRef(TEST_PROJECT, next.candidateId).update({ attempts: 64, retryAt: at });
  expect(await reconcileHostingCleanup(() => at, f.transport)).toMatchObject({ attempted: 0, failed: 1, exhausted: 1 });
  expect((await hostingCleanupRef(TEST_PROJECT, next.candidateId).get()).data()?.retryAt).toBe(Number.MAX_SAFE_INTEGER);
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(f.artifact.bytes);
});

test('a ready automatic submission abandoned before publication is reclaimed after 24 hours', async () => {
  const f = await fixture('automatic'); await f.ready();
  expect((await reconcileHostingCleanup(() => now() + HOSTING_LIMITS.retirementGraceMs - 1, f.transport)).attempted).toBe(0);
  expect((await reconcileHostingCleanup(() => now() + HOSTING_LIMITS.retirementGraceMs, f.transport)).releasedBytes).toBe(f.artifact.bytes);
  expect(f.transport.head).toBeNull();
});
test('a stale staging-cleanup acknowledgement cannot drop a newly scheduled retirement', async () => {
  const f = await fixture(); await f.ready();
  const at = now() + HOSTING_LIMITS.retirementGraceMs;
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = f.transport.command.bind(f.transport);
  f.transport.command = async (project, path, body, method) => {
    if ((path.startsWith('cleanup/') || path.startsWith('audit/'))) { entered(); await held; }
    return original(project, path, body, method);
  };
  const cleanup = reconcileHostingCleanup(() => at, f.transport); await arrived;
  try {
    const operation = await requestHostingPublication(TEST_PROJECT, f.approver, f.publishInput, () => at);
    await applyHostingOperation(TEST_PROJECT, f.approver, operation.id, () => at, f.transport);
    await replaceBuild(f, at + 1);
  } finally { release(); }
  expect((await cleanup).releasedBytes).toBe(0);
  expect((await hostingCleanupRef(TEST_PROJECT, f.candidate.candidateId).get()).data()?.intent).toMatch(/^retire:/);
  expect((await reconcileHostingCleanup(() => at + 1 + HOSTING_LIMITS.retirementGraceMs, f.transport)).releasedBytes).toBe(f.artifact.bytes);
});
test('a seal completion accepted before retirement cannot revive a deleting candidate', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = f.transport.command.bind(f.transport);
  f.transport.command = async (project, path, body, method) => {
    if (path.startsWith('seal/')) { entered(); await held; }
    if ((path.startsWith('cleanup/') || path.startsWith('audit/'))) return { done: false, deleted: 1, scope: 'all', candidateId: f.candidate.candidateId };
    return original(project, path, body, method);
  };
  const sealing = sealHosting(TEST_PROJECT, f.submitter, f.candidate.candidateId, now, f.transport);
  await arrived;
  try { await reconcileHostingCleanup(() => f.candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs, f.transport); } finally { release(); }
  await expect(sealing).rejects.toMatchObject({ code: 'forbidden' });
  expect((await hostingCandidates(TEST_PROJECT).doc(f.candidate.candidateId).get()).data()?.state).toBe('deleting');
});
test('post-cleanup orphan audits persist, repeat without releasing capacity twice, and remain bounded', async () => {
  const f=await fixture(),at=f.candidate.expiresAt+HOSTING_LIMITS.retirementGraceMs;
  expect((await reconcileHostingCleanup(()=>at,f.transport)).releasedBytes).toBe(f.artifact.bytes);
  const ref=hostingCleanupRef(TEST_PROJECT,f.candidate.candidateId);
  expect((await ref.get()).data()?.phase).toBe('audit');
  const original=f.transport.command.bind(f.transport);let audits=0;
  f.transport.command=async(project,path,body,method)=>{if(path.startsWith('audit/'))audits++;return original(project,path,body,method);};
  expect((await reconcileHostingCleanup(()=>at+86400000,f.transport)).releasedBytes).toBe(0);expect(audits).toBe(1);
  expect((await ref.get()).data()?.retryAt).toBe(at+8*86400000);
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(0);
});
test('a five-build cleanup backlog drains across bounded rounds without dropping reservations early', async () => {
  const f = await fixture();
  const candidates = [f.candidate];
  for (let i = 1; i < 5; i++) candidates.push(await prepareHosting(TEST_PROJECT, f.submitter,
    { ...f.input, clientRequestId: `backlog-${i}` }, now, f.transport));
  const at = f.candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs;
  const before = (await hostingState(TEST_PROJECT).get()).data()!;
  expect(before.reservedBytes).toBe(5 * f.artifact.bytes);
  const calls = f.transport.calls.length;
  const first = await reconcileHostingCleanup(() => at, f.transport);
  expect(first).toMatchObject({ selected: 4, attempted: 4, failed: 0, exhausted: 0, releasedBytes: 4 * f.artifact.bytes });
  expect(f.transport.calls.slice(calls)).toHaveLength(4);
  expect(f.transport.calls.slice(calls).every(call => call.includes(':POST:cleanup/'))).toBe(true);
  const remaining = await hostingCandidates(TEST_PROJECT).get();
  expect(remaining.size).toBe(1);
  expect(candidates.some(candidate => candidate.candidateId === remaining.docs[0].id)).toBe(true);
  expect(remaining.docs[0].data().state).toBe('uploading');
  expect((await hostingState(TEST_PROJECT).get()).data()?.reservedBytes).toBe(f.artifact.bytes);
  expect(await reconcileHostingCleanup(() => at, f.transport)).toMatchObject({ selected: 1, attempted: 1, releasedBytes: f.artifact.bytes });
  expect(f.transport.calls.slice(calls)).toHaveLength(5);
  expect((await hostingState(TEST_PROJECT).get()).data()).toMatchObject({ reservedBytes: 0, candidates: 0 });
  // Completed jobs retain their delayed audit; an idle round cannot repeat capacity release.
  expect(await reconcileHostingCleanup(() => at, f.transport)).toMatchObject({ selected: 0, attempted: 0, releasedBytes: 0 });
  expect(f.transport.calls.slice(calls)).toHaveLength(5);
  for (const candidate of candidates) expect((await hostingCleanupRef(TEST_PROJECT, candidate.candidateId).get()).data()).toMatchObject({ phase: 'audit', retryAt: at + 86400000 });
});
test('an exhausted orphan audit retains a slow retry and resumes without another capacity release', async () => {
  const f = await fixture(), at = f.candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs;
  expect((await reconcileHostingCleanup(() => at, f.transport)).releasedBytes).toBe(f.artifact.bytes);
  const ref = hostingCleanupRef(TEST_PROJECT, f.candidate.candidateId), due = at + 86400000;
  // Explicit retry-boundary fixture, not a claim that 64 failures elapsed.
  await ref.update({ attempts: 64, retryAt: due });
  const calls = f.transport.calls.length;
  expect(await reconcileHostingCleanup(() => due, f.transport)).toMatchObject({ selected: 1, attempted: 0, failed: 1, exhausted: 1, releasedBytes: 0 });
  expect(f.transport.calls).toHaveLength(calls);
  const next = due + 7 * 86400000;
  expect((await ref.get()).data()).toMatchObject({ phase: 'audit', attempts: 0, retryAt: next });
  expect(await reconcileHostingCleanup(() => next - 1, f.transport)).toMatchObject({ selected: 0, attempted: 0 });
  expect(await reconcileHostingCleanup(() => next, f.transport)).toMatchObject({ selected: 1, attempted: 1, failed: 0, exhausted: 0, releasedBytes: 0 });
  expect(f.transport.calls).toHaveLength(calls + 1);
  expect(f.transport.calls.at(-1)).toContain(`audit/${f.candidate.candidateId}`);
  expect((await ref.get()).data()).toMatchObject({ phase: 'audit', attempts: 0, retryAt: next + 7 * 86400000 });
  expect((await hostingState(TEST_PROJECT).get()).data()).toMatchObject({ reservedBytes: 0, candidates: 0 });
});
