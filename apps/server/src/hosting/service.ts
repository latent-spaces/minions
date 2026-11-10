import { z } from 'zod';
import { createHash } from 'node:crypto';
import { FieldPath } from '../firestore.js';
import { HOSTING_LIMITS, hostingContentHost, parseArtifact, sha256, type HostingArtifact, type HostingPolicy, type HostingSummary } from '@mlswarm/contracts';
import { agents, db, inProject } from '../firestore.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { activeRecipientOperators, validProjectId } from '../projects/access.js';
import { hostingAuthority, hostingWritable, assertHostingComputer, type HostingActor } from './authority.js';
import { hostingCandidates, hostingOperations, hostingReceipts, hostingState, initialHostingState, type HostingOperation } from './records.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { assertPublicProject } from '../projects/public-access.js';
import { scheduleHostingCleanup } from './cleanup.js';
import { hostingTransport, observedHead, type HostingTransport } from './transport.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const HOSTING_POLICY_INPUT = z.object({ clientRequestId: requestId, expectedRevision: revision,
  confirmPublic: z.literal(true), mode: z.enum(['approval', 'automatic']),
  approvers: z.array(identity).max(20), submitters: z.array(identity).max(20),
}).strict().refine(v => new Set(v.approvers).size === v.approvers.length && new Set(v.submitters).size === v.submitters.length
  && (v.mode !== 'approval' || v.approvers.length > 0));
export const HOSTING_PREPARE_INPUT = z.object({ clientRequestId: requestId, policyRevision: revision, manifest: z.unknown() }).strict();
export const HOSTING_PUBLISH_INPUT = z.object({ clientRequestId: requestId, policyRevision: revision, candidateId: digest }).strict();
export const HOSTING_UNPUBLISH_INPUT = z.object({ clientRequestId: requestId }).strict();
function conflict(message: string): never { throw new Refusal('intent_conflict', message); }
function forbidden(message: string): never { throw new Refusal('forbidden', message); }
function scope(id: string) { if (!validProjectId(id)) throw new Refusal('not_found', 'Choose one of your projects.'); }
function permitted(policy: HostingPolicy, operator: { profileId: string; epoch: number; role?: string }, action: 'submit' | 'approve') {
  return policy[action === 'submit' ? 'submitters' : 'approvers'].some(p => p.profileId === operator.profileId && p.epoch === operator.epoch);
}
const operationId = (actorKey: string, action: string, clientRequestId: string) => hashToken(JSON.stringify([actorKey, action, clientRequestId]));
export const hostingOperationReceipt = (operation: HostingOperation) => ({ id: operation.id, state: operation.state,
  artifact: operation.artifact, generation: operation.generation, updatedAt: operation.updatedAt });

export async function configureHosting(id: string, actor: HostingActor, raw: unknown, now: () => number) {
  scope(id);
  if (JSON.stringify(raw)?.length > 16 * 1024) throw new Refusal('bad_input', 'Hosting settings are too large.');
  const input = HOSTING_POLICY_INPUT.parse(raw), fingerprint = hashToken(JSON.stringify(input));
  return inProject(id, () => db.runTransaction(async tx => {
    const authority = await hostingAuthority(tx, actor, now);
    if (actor.kind !== 'person' || authority.role !== 'owner') forbidden('Only the project owner configures public hosting.');
    const ref = hostingState(id), state = (await tx.get(ref)).data() ?? initialHostingState();
    const receiptRef = hostingReceipts(id).doc(operationId(authority.actorKey, 'policy', input.clientRequestId));
    const receipt = (await tx.get(receiptRef)).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) conflict('This request ID belongs to different hosting settings.');
      return receipt.result;
    }
    await hostingWritable(tx, actor);
    if (state.policy.revision !== input.expectedRevision) conflict('Hosting settings changed. Reload before saving.');
    if (state.pendingOperation) throw new Refusal('project_busy', 'Resolve the pending hosting operation or Unpublish before changing settings.');
    const ids = [...new Set([...input.approvers, ...input.submitters])], operators = await activeRecipientOperators(tx, ids);
    if (ids.some(profileId => !operators.has(profileId))) forbidden('Choose current project members for hosting permissions.');
    const members = (values: string[]) => values.map(profileId => ({ profileId, epoch: operators.get(profileId)!.epoch }));
    const builds = await tx.get(hostingCandidates(id).select('id', 'state', 'lastPublishedAt').limit(101));
    if (builds.size > 100) throw new Error('Hosting candidate capacity needs review.');
    const policy: HostingPolicy = { revision: state.policy.revision + 1, enabled: true, audience: 'public', mode: input.mode,
      approvers: members(input.approvers), submitters: members(input.submitters) };
    tx.set(ref, { ...state, changeRevision: state.changeRevision + 1, policy, policyChangedAt: now(), updatedAt: now() });
    for (const build of builds.docs) if (build.data().state !== 'deleting' && build.data().lastPublishedAt === null) scheduleHostingCleanup(tx, id, build.id, `policy:${policy.revision}`, now() + HOSTING_LIMITS.retirementGraceMs);
    const result = { policy };
    tx.create(receiptRef, { fingerprint, result });
    return result;
  }));
}

export async function prepareHosting(id: string, actor: HostingActor, raw: unknown, now: () => number, transport: HostingTransport = hostingTransport()) {
  scope(id); const input = HOSTING_PREPARE_INPUT.parse(raw), artifact = await parseArtifact(input.manifest);
  const candidate = await inProject(id, () => db.runTransaction(async tx => {
    const authority = await hostingAuthority(tx, actor, now);
    const stateRef = hostingState(id), state = (await tx.get(stateRef)).data() ?? initialHostingState();
    const candidateId = operationId(authority.actorKey, 'candidate', input.clientRequestId), ref = hostingCandidates(id).doc(candidateId);
    const existing = (await tx.get(ref)).data();
    const retired = (await tx.get(hostingReceipts(id).doc(candidateId))).data();
    if (retired?.result && (retired.result as { kind?: string }).kind === 'retired-upload') throw new Refusal('hosting_upload_expired', 'This upload was cleaned up. Use a new request ID.');
    if (!state.policy.enabled || !permitted(state.policy, authority, 'submit')) forbidden('The owner must enable hosting and designate you as a submitter.');
    if (input.policyRevision !== state.policy.revision) conflict('Hosting policy changed. Prepare a new candidate under the current policy.');
    if (existing) {
      if (existing.state === 'deleting') throw new Refusal('hosting_upload_expired', 'This upload is being cleaned up. Use a new request ID.');
      if (existing.artifact.digest !== artifact.digest || existing.policyRevision !== input.policyRevision) conflict('This candidate request ID was used for different bytes or policy.');
      if (existing.state === 'uploading' && existing.expiresAt <= now()) throw new Refusal('hosting_upload_expired', 'This upload expired. Select the output folder again with a new request ID.');
      return existing;
    }
    await hostingWritable(tx, actor);
    // Conservative cumulative reservation: no capacity is reclaimed before confirmed object deletion.
    if (state.reservedBytes + artifact.bytes > HOSTING_LIMITS.retainedBytes || state.candidates >= 100) throw new Refusal('too_long', 'This project’s hosting storage is full. No upload was reserved.');
    const createdAt = now();
    const record = { id: candidateId, projectId: id, actorKey: authority.actorKey, profileId: authority.profileId,
      epoch: authority.epoch, policyRevision: state.policy.revision, artifact, fileCount: artifact.manifest.files.length, createdAt, expiresAt: createdAt + HOSTING_LIMITS.stagingTtlMs, state: 'uploading' as const,
      submittedBy: { profileId: authority.profileId, name: [...authority.name].slice(0, 120).join(''), agentId: actor.kind === 'agent' ? actor.agent.id : null }, lastPublishedAt: null, readyAt: null };
    tx.create(ref, record);
    scheduleHostingCleanup(tx, id, candidateId, 'prepare', record.expiresAt + HOSTING_LIMITS.retirementGraceMs);
    tx.set(stateRef, { ...state, changeRevision: state.changeRevision + 1, reservedBytes: state.reservedBytes + artifact.bytes, candidates: state.candidates + 1, updatedAt: createdAt });
    return record;
  }));
  if (candidate.state === 'uploading') await transport.command(id, `prepare/${candidate.id}`, { manifest: candidate.artifact.manifest, expiresAt: candidate.expiresAt });
  return { candidateId: candidate.id, artifact: candidate.artifact, expiresAt: candidate.expiresAt, state: candidate.state };
}

async function uploadAuthority(id: string, actor: HostingActor, candidateId: string, now: () => number) {
  if (!/^[a-f0-9]{64}$/.test(candidateId)) throw new Refusal('bad_input', 'Choose a candidate.');
  return inProject(id, () => db.runTransaction(async tx => {
    const authority = await hostingAuthority(tx, actor, now), state = (await tx.get(hostingState(id))).data();
    const candidate = (await tx.get(hostingCandidates(id).doc(candidateId))).data();
    if (!candidate || candidate.state === 'deleting' || candidate.projectId !== id || candidate.actorKey !== authority.actorKey || candidate.epoch !== authority.epoch) forbidden('This upload belongs to a different connection.');
    if (!state?.policy.enabled || state.policy.revision !== candidate.policyRevision || !permitted(state.policy, authority, 'submit')) forbidden('This upload is no longer permitted by the current hosting policy.');
    if (candidate.state === 'uploading' && candidate.expiresAt <= now()) throw new Refusal('hosting_upload_expired', 'This upload expired. Start a new candidate with a new request ID.');
    await hostingWritable(tx, actor);
    return candidate;
  }));
}
export async function uploadHostingFile(id: string, actor: HostingActor, candidateId: string, index: number, bytes: Buffer, now: () => number, transport: HostingTransport = hostingTransport()) {
  scope(id); const candidate = await uploadAuthority(id, actor, candidateId, now);
  const file = candidate.artifact.manifest.files[index];
  if (candidate.state !== 'uploading' || candidate.expiresAt <= now()) forbidden('This upload is sealed or expired.');
  if (!Number.isSafeInteger(index) || !file || !Buffer.isBuffer(bytes) || bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Refusal('bad_input', 'Upload the exact reserved file bytes.');
  await transport.upload(id, candidateId, index, bytes);
  return { uploaded: true, index };
}
export async function hostingUploadStatus(id: string, actor: HostingActor, candidateId: string, now: () => number, transport: HostingTransport = hostingTransport()) {
  scope(id); const candidate = await uploadAuthority(id, actor, candidateId, now);
  if (candidate.state === 'ready') return { digest: candidate.artifact.digest, uploaded: candidate.artifact.manifest.files.map((_file, index) => index) };
  const status = await transport.command(id, `status/${candidateId}`, undefined, 'GET');
  if (status.digest !== candidate.artifact.digest || !Array.isArray(status.uploaded) || status.uploaded.length > HOSTING_LIMITS.files
    || status.uploaded.some(index => !Number.isSafeInteger(index) || index < 0 || index >= candidate.artifact.manifest.files.length)
    || new Set(status.uploaded).size !== status.uploaded.length) throw new Error('Hosting upload progress was not verified.');
  return { digest: candidate.artifact.digest, uploaded: status.uploaded as number[] };
}
export async function sealHosting(id: string, actor: HostingActor, candidateId: string, now: () => number, transport: HostingTransport = hostingTransport()) {
  scope(id); const candidate = await uploadAuthority(id, actor, candidateId, now);
  if (candidate.state === 'ready') return { candidateId, state: 'ready', digest: candidate.artifact.digest };
  const sealed = await transport.command(id, `seal/${candidateId}`, { digest: candidate.artifact.digest });
  if (sealed.digest !== candidate.artifact.digest || sealed.bytes !== candidate.artifact.bytes || typeof sealed.sealed !== 'boolean') throw new Error('Artifact sealing was not confirmed.');
  if (!sealed.sealed) return { candidateId, state: 'validating', digest: candidate.artifact.digest, next: sealed.next, total: sealed.total };
  await inProject(id, () => db.runTransaction(async tx => {
    const authority = await hostingAuthority(tx, actor, now), state = (await tx.get(hostingState(id))).data();
    const current = (await tx.get(hostingCandidates(id).doc(candidateId))).data();
    if (!current || current.state === 'deleting' || current.actorKey !== authority.actorKey || current.epoch !== authority.epoch
      || !state?.policy.enabled || state.policy.revision !== current.policyRevision || !permitted(state.policy, authority, 'submit')) forbidden('The upload permission changed before sealing completed.');
    await hostingWritable(tx, actor);
    tx.update(hostingCandidates(id).doc(candidateId), { state: 'ready', readyAt: current.readyAt ?? now() });
    if (current.readyAt === null) scheduleHostingCleanup(tx, id, candidateId, `seal:${candidate.policyRevision}`, now() + HOSTING_LIMITS.retirementGraceMs);
    tx.update(hostingState(id), { changeRevision: state.changeRevision + 1, updatedAt: now() });
  }));
  return { candidateId, state: 'ready', digest: candidate.artifact.digest };
}

export async function requestHostingPublication(id: string, actor: HostingActor, raw: unknown, now: () => number) {
  scope(id); const input = HOSTING_PUBLISH_INPUT.parse(raw), fingerprint = hashToken(JSON.stringify(input));
  return inProject(id, () => db.runTransaction(async tx => {
    const authority = await hostingAuthority(tx, actor, now), stateRef = hostingState(id), state = (await tx.get(stateRef)).data();
    const opId = operationId(authority.actorKey, 'publish', input.clientRequestId), ref = hostingOperations(id).doc(opId), existing = (await tx.get(ref)).data();
    if (existing) {
      if (existing.fingerprint !== fingerprint) conflict('This request ID belongs to another publication.');
      return existing;
    }
    if (!state?.policy.enabled || state.policy.revision !== input.policyRevision) conflict('Hosting policy changed or is disabled.');
    if (state.pendingOperation) throw new Refusal('project_busy', 'Resolve the current publication before publishing another.');
    await hostingWritable(tx, actor);
    const candidate = (await tx.get(hostingCandidates(id).doc(input.candidateId))).data();
    if (!candidate || candidate.projectId !== id || candidate.state !== 'ready' || candidate.policyRevision !== state.policy.revision) conflict('Choose a sealed candidate prepared under the current hosting policy.');
    const submitter = (await activeRecipientOperators(tx, [candidate.profileId])).get(candidate.profileId);
    if (!submitter || submitter.epoch !== candidate.epoch || !permitted(state.policy, { profileId: candidate.profileId, ...submitter }, 'submit')) forbidden('The original submitter is no longer eligible.');
    const manual = state.policy.mode === 'approval';
    if (manual ? actor.kind !== 'person' || !permitted(state.policy, authority, 'approve') : !permitted(state.policy, authority, 'submit')) forbidden(manual ? 'A currently designated person must approve this exact build.' : 'Only an owner-designated submitter may request automatic publication.');
    const at = now(), op: HostingOperation = { id: opId, projectId: id, fingerprint, actorKey: authority.actorKey,
      profileId: authority.profileId, epoch: authority.epoch, candidateId: candidate.id, artifact: candidate.artifact.digest,
      policyRevision: state.policy.revision, generation: state.generation + 1,
      approvedBy: manual ? { profileId: authority.profileId, epoch: authority.epoch } : null,
      connection: actor.kind === 'agent' ? { agentId: actor.agent.id, runId: actor.runId, tokenHashDigest: hashToken(actor.agent.tokenHash) } : null,
      ...(actor.kind === 'person' && actor.computer ? { computerConnection: actor.computer } : {}),
      state: 'queued', createdAt: at, updatedAt: at, attempts: 0, retryAt: at, recoveries: 0 };
    tx.create(ref, op); tx.set(stateRef, { ...state, changeRevision: state.changeRevision + 1, generation: op.generation, pendingOperation: opId, updatedAt: at });
    return op;
  }));
}

export async function requestHostingUnpublish(id: string, actor: HostingActor, raw: unknown, now: () => number) {
  scope(id); const input = HOSTING_UNPUBLISH_INPUT.parse(raw), fingerprint = hashToken(JSON.stringify(input));
  return inProject(id, () => db.runTransaction(async tx => {
    const authority = await hostingAuthority(tx, actor, now);
    if (actor.kind !== 'person' || authority.role !== 'owner') forbidden('Only the project owner can unpublish this output.');
    const ref = hostingState(id), state = (await tx.get(ref)).data() ?? initialHostingState();
    const opId = operationId(authority.actorKey, 'unpublish', input.clientRequestId), opRef = hostingOperations(id).doc(opId), existing = (await tx.get(opRef)).data();
    if (existing) {
      if (existing.fingerprint !== fingerprint) conflict('Unpublish request identity changed.');
      return existing;
    }
    const pending = state.pendingOperation ? (await tx.get(hostingOperations(id).doc(state.pendingOperation))).data() : undefined;
    const at = now(), op: HostingOperation = { id: opId, projectId: id, fingerprint, actorKey: authority.actorKey,
      profileId: authority.profileId, epoch: authority.epoch, candidateId: null, artifact: null,
      policyRevision: state.policy.revision + 1, generation: state.generation + 1, approvedBy: null, connection: null,
      ...(actor.kind === 'person' && actor.computer ? { computerConnection: actor.computer } : {}),
      state: 'queued', createdAt: at, updatedAt: at, attempts: 0, retryAt: at, recoveries: 0 };
    const builds = await tx.get(hostingCandidates(id).select('id', 'state', 'lastPublishedAt').limit(101));
    if (builds.size > 100) throw new Error('Hosting candidate capacity needs review.');
    for (const build of builds.docs) if (build.data().state !== 'deleting' && build.data().lastPublishedAt === null) scheduleHostingCleanup(tx, id, build.id, `unpublish:${opId}`, at + HOSTING_LIMITS.retirementGraceMs);
    if (pending) tx.update(hostingOperations(id).doc(pending.id), { state: 'superseded', updatedAt: at });
    tx.create(opRef, op);
    tx.set(ref, { ...state, changeRevision: state.changeRevision + 1, policy: { ...state.policy, revision: op.policyRevision, enabled: false },
      generation: op.generation, policyChangedAt: at, pendingOperation: opId, updatedAt: at });
    return op;
  }));
}

/** Authenticated retry of one accepted operation; the private worker uses the same dispatcher. */
export async function applyHostingOperation(id: string, actor: HostingActor, opId: string, now: () => number, transport: HostingTransport = hostingTransport()) {
  return dispatchHostingOperation(id, actor, opId, now, transport);
}

async function dispatchHostingOperation(id: string, actor: HostingActor | null, opId: string, now: () => number, transport: HostingTransport) {
  scope(id); if (!/^[a-f0-9]{64}$/.test(opId)) throw new Refusal('bad_input', 'Choose a hosting operation.');
  const op = await inProject(id, () => db.runTransaction(async tx => {
    const authority = actor ? await hostingAuthority(tx, actor, now) : null;
    const state = (await tx.get(hostingState(id))).data(), current = (await tx.get(hostingOperations(id).doc(opId))).data();
    if (!state || !current || current.projectId !== id) throw new Refusal('not_found', 'Hosting operation not found.');
    if (actor && authority && current.actorKey !== authority.actorKey && (actor.kind !== 'person' || authority.role !== 'owner')) forbidden('Only the requester or project owner can recover this operation.');
    return { ...current, pending: state.pendingOperation === opId };
  }));
  if (!op.pending || ['published', 'unpublished', 'superseded'].includes(op.state)) return op;
  try {
    let head = observedHead((await transport.command(id, 'head', undefined, 'GET')).head);
    if ((head?.generation ?? 0) < op.generation) {
      // An observed committed result can be recovered after the original actor leaves.
      // Dispatching a NEW command still needs every current authority fence.
      const eligible = await inProject(id, () => db.runTransaction(async tx => {
        if (actor) await hostingAuthority(tx, actor, now);
        const state = (await tx.get(hostingState(id))).data()!, current = (await tx.get(hostingOperations(id).doc(opId))).data()!;
        if (state.pendingOperation !== opId || current.state === 'superseded') return false;
        if (current.artifact !== null) {
          if (!state.policy.enabled || state.policy.revision !== current.policyRevision) conflict('This publication is superseded by the current policy.');
          const participant = (await activeRecipientOperators(tx, [current.profileId])).get(current.profileId);
          if (!participant || participant.epoch !== current.epoch || !permitted(state.policy, { profileId: current.profileId, ...participant }, current.approvedBy ? 'approve' : 'submit')) forbidden('The publication requester is no longer eligible. Unpublish to cancel this operation.');
          if (current.computerConnection) await assertHostingComputer(tx, current.computerConnection, current.profileId, now());
          if (current.connection) {
            await assertRunInTransaction(tx, current.connection.agentId, current.connection.runId, now);
            const agent = (await tx.get(agents().doc(current.connection.agentId))).data();
            if (!agent || agent.ownerProfileId !== current.profileId || hashToken(agent.tokenHash) !== current.connection.tokenHashDigest) forbidden('The requesting agent connection changed.');
          }
          await hostingWritable(tx, actor, current.connection !== null);
        }
        if (current.attempts >= 20) throw new Refusal('project_busy', 'Hosting recovery needs operator review. Unpublish can still supersede it.');
        tx.set(hostingOperations(id).doc(opId), { ...current, state: 'applying', attempts: current.attempts + 1, updatedAt: now() });
        tx.update(hostingState(id), { changeRevision: state.changeRevision + 1, updatedAt: now() });
        return true;
      }));
      if (!eligible) return { ...op, state: 'superseded' as const };
      head = observedHead(await transport.command(id, 'head', { operationId: op.id, generation: op.generation,
        expectedRevision: head?.revision ?? 0, artifact: op.artifact, candidateId: op.candidateId }));
    }
    const expectedIntent = await sha256(JSON.stringify({ operationId: op.id, generation: op.generation, artifact: op.artifact, candidateId: op.candidateId }));
    if (!head || head.generation < op.generation || head.generation === op.generation && (head.operationId !== op.id || head.current !== op.artifact || head.current !== null && head.releases.find(release => release.artifact === head!.current)?.buildId !== op.candidateId || head.intent !== expectedIntent)) throw new Error('Publication acknowledgement does not match the requested artifact.');
    const state = head.generation > op.generation ? 'superseded' as const : op.artifact === null ? 'unpublished' as const : 'published' as const;
    return await inProject(id, () => db.runTransaction(async tx => {
      const currentState = (await tx.get(hostingState(id))).data()!, current = (await tx.get(hostingOperations(id).doc(op.id))).data()!;
      if (currentState.generation !== op.generation || currentState.pendingOperation !== op.id) return current;
      const candidate = current.candidateId ? (await tx.get(hostingCandidates(id).doc(current.candidateId))).data() : undefined;
      const observedCandidate = head!.releases.find(release => release.artifact === head!.current)?.buildId ?? null;
      const retiredBuilds = { ...currentState.retiredBuilds };
      if (currentState.observedCandidate && currentState.observedCandidate !== observedCandidate) {
        retiredBuilds[currentState.observedCandidate] = now();
        scheduleHostingCleanup(tx, id, currentState.observedCandidate, `retire:${op.id}`, now() + HOSTING_LIMITS.retirementGraceMs);
      }
      if (observedCandidate) delete retiredBuilds[observedCandidate];
      const result = { ...current, state, updatedAt: now() };
      tx.set(hostingOperations(id).doc(op.id), result);
      if (state === 'published' && candidate?.projectId === id && candidate.artifact.digest === op.artifact)
        tx.update(hostingCandidates(id).doc(candidate.id), { lastPublishedAt: now() });
      tx.set(hostingState(id), { ...currentState, changeRevision: currentState.changeRevision + 1, observedRevision: head!.revision, observedArtifact: head!.current, observedCandidate, retiredBuilds, pendingOperation: null, updatedAt: now() });
      return result;
    }));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return inProject(id, () => db.runTransaction(async tx => {
      const current = (await tx.get(hostingOperations(id).doc(op.id))).data()!;
      const state = (await tx.get(hostingState(id))).data()!;
      if (state.pendingOperation !== op.id || !['queued', 'applying', 'uncertain'].includes(current.state)) return current;
      const result = { ...current, state: 'uncertain' as const, updatedAt: now() };
      tx.set(hostingOperations(id).doc(op.id), result);
      tx.update(hostingState(id), { changeRevision: state.changeRevision + 1, updatedAt: now() }); return result;
    }));
  }
}

export async function readHosting(id: string, actor: HostingActor, cursor: string | undefined, now: () => number): Promise<HostingSummary> {
  scope(id); if (cursor !== undefined && !/^[a-f0-9]{64}$/.test(cursor)) throw new Refusal('bad_input', 'Invalid hosting cursor.');
  return inProject(id, () => db.runTransaction(async tx => {
    await hostingAuthority(tx, actor, now);
    const state = (await tx.get(hostingState(id))).data() ?? initialHostingState();
    let query = hostingCandidates(id).select('id', 'state', 'artifact.digest', 'artifact.bytes', 'fileCount', 'createdAt', 'expiresAt', 'policyRevision', 'submittedBy', 'lastPublishedAt').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(21);
    if (cursor) {
      const previous = (await tx.get(hostingCandidates(id).where(FieldPath.documentId(), '==', cursor).select('createdAt').limit(1))).docs[0]?.data();
      if (!previous) conflict('This build page changed. Return to the first page.');
      query = query.startAfter(previous.createdAt, cursor);
    }
    const records = await tx.get(query), page = records.docs.slice(0, 20);
    const operation = state.pendingOperation ? (await tx.get(hostingOperations(id).doc(state.pendingOperation))).data() ?? null : null;
    const publicOperation = operation ? { id: operation.id, state: operation.state, artifact: operation.artifact, attempts: operation.attempts, updatedAt: operation.updatedAt } : null;
    const domain = process.env.HOSTING_CONTENT_DOMAIN;
    const configured = Boolean(domain && process.env.HOSTING_CONTROL_ORIGIN && process.env.HOSTING_CONTROL_TOKEN);
    const publishedUrl = domain && state.observedArtifact ? `https://${hostingContentHost(id, domain)}/_releases/${state.observedArtifact}/` : null;
    return { ...state, configured, publishedUrl, operation: publicOperation, candidates: page.map(row => {
      const value = row.data();
      return { id: value.id, state: value.state === 'uploading' && value.expiresAt <= now() ? 'expired' : value.state, digest: value.artifact.digest, bytes: value.artifact.bytes,
        files: value.fileCount, createdAt: value.createdAt, expiresAt: value.expiresAt, policyRevision: value.policyRevision, submittedBy: value.submittedBy, lastPublishedAt: value.lastPublishedAt };
    }), candidateCount: state.candidates, next: records.size > 20 ? page.at(-1)!.id : null };
  }));
}

export async function readHostingCandidate(id: string, actor: HostingActor, candidateId: string, now: () => number) {
  scope(id); if (!/^[a-f0-9]{64}$/.test(candidateId)) throw new Refusal('bad_input', 'Choose a hosting candidate.');
  return inProject(id, () => db.runTransaction(async tx => {
    const authority = await hostingAuthority(tx, actor, now), state = (await tx.get(hostingState(id))).data();
    const candidate = (await tx.get(hostingCandidates(id).doc(candidateId))).data();
    if (!candidate || candidate.state === 'deleting' || candidate.projectId !== id) throw new Refusal('not_found', 'Build not found.');
    if (authority.role !== 'owner' && candidate.actorKey !== authority.actorKey
      && (!state || !permitted(state.policy, authority, 'submit') && !permitted(state.policy, authority, 'approve'))) forbidden('Only the owner, uploader or designated hosting participants can inspect these files.');
    return { candidateId, artifact: candidate.artifact };
  }));
}

export type { HostingArtifact };

export async function readPublicHosting(id: string) {
  scope(id);
  return inProject(id, () => db.runTransaction(async tx => {
    await assertPublicProject(tx);
    const state = (await tx.get(hostingState(id))).data(), domain = process.env.HOSTING_CONTENT_DOMAIN;
    const artifact = state?.observedArtifact ?? null;
    return { publishedUrl: domain && artifact ? `https://${hostingContentHost(id, domain)}/_releases/${artifact}/` : null };
  }));
}

/** Existing private Scheduler/IAM worker only. No new approval or upload can be minted here.
 * One due-index page; no project roster scans, listeners, model execution or process timer.
 * A persisted retryAt claim prevents competing worker rounds from retrying the same intent.
 */
export async function reconcileHostingOperations(now = Date.now, suppliedTransport?: HostingTransport) {
  if (!suppliedTransport && (!process.env.HOSTING_CONTROL_ORIGIN || !process.env.HOSTING_CONTROL_TOKEN)) return { selected: 0, retried: 0, failed: 0 };
  const transport = suppliedTransport ?? hostingTransport();
  const due = await db.collectionGroup('hostingOperations').where('state', 'in', ['queued', 'applying', 'uncertain'])
    .where('retryAt', '<=', now()).orderBy('retryAt').limit(4).get();
  let retried = 0, failed = 0;
  for (const row of due.docs) {
    const parts = row.ref.path.split('/');
    if (parts.length !== 4 || parts[0] !== 'projects' || parts[2] !== 'hostingOperations' || !validProjectId(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[3])) continue;
    const claimed = await db.runTransaction(async tx => {
      const operation = (await tx.get(row.ref)).data() as HostingOperation | undefined;
      if (!operation || operation.projectId !== parts[1] || operation.id !== parts[3]
        || !['queued', 'applying', 'uncertain'].includes(operation.state) || operation.retryAt > now() || operation.recoveries >= 20) return false;
      const attempts = operation.recoveries + 1;
      tx.update(row.ref, { recoveries: attempts, retryAt: attempts >= 20 ? Number.MAX_SAFE_INTEGER : now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts - 1, 6)) });
      return true;
    });
    if (!claimed) continue;
    retried++;
    try {
      const result = await dispatchHostingOperation(parts[1], null, parts[3], now, transport);
      if (!['published', 'unpublished', 'superseded'].includes(result.state)) failed++;
    } catch { failed++; }
  }
  return { selected: due.size, retried, failed };
}
