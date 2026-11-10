import { HOSTING_LIMITS } from '@mlswarm/contracts';
import { createHash } from 'node:crypto';
import type { Transaction } from '../firestore.js';
import { collection, db } from '../firestore.js';
import { validProjectId } from '../projects/access.js';
import { hostingCandidates, hostingReceipts, hostingState } from './records.js';
import { hostingTransport, type HostingTransport } from './transport.js';

type CleanupJob = { projectId: string; candidateId: string; intent: string; retryAt: number; attempts: number;
  phase: 'inspect' | 'delete' | 'audit'; scope: 'staging' | 'all'; fenceGeneration: number };
export const hostingCleanupJobs = collection<CleanupJob>('hostingCleanupJobs');
export const hostingCleanupRef = (id: string, candidate: string) => hostingCleanupJobs.doc(createHash('sha256').update(JSON.stringify([id, candidate])).digest('hex'));
export function scheduleHostingCleanup(tx: Transaction, id: string, candidateId: string, intent: string, at: number) {
  tx.set(hostingCleanupRef(id, candidateId), { projectId: id, candidateId, intent, retryAt: at, attempts: 0,
    phase: 'inspect', scope: 'staging', fenceGeneration: 0 });
}

/** One global due-index page on the existing private worker, never a project poll.
 * Physical namespaces belong to unique upload IDs. Duplicate or late deletes can
 * therefore never erase a later upload of the same content hash.
 */
export async function reconcileHostingCleanup(now = Date.now, suppliedTransport?: HostingTransport) {
  if (!suppliedTransport && (!process.env.HOSTING_CONTROL_ORIGIN || !process.env.HOSTING_CONTROL_TOKEN)) return { selected: 0, attempted: 0, deletedObjects: 0, releasedBytes: 0, failed: 0, exhausted: 0 };
  const transport = suppliedTransport ?? hostingTransport();
  const due = await hostingCleanupJobs.where('retryAt', '<=', now()).orderBy('retryAt').limit(4).get();
  let attempted = 0, deletedObjects = 0, releasedBytes = 0, failed = 0, exhausted = 0;
  for (const row of due.docs) {
    const initial = row.data();
    if (!validProjectId(initial.projectId) || !/^[a-f0-9]{64}$/.test(initial.candidateId)
      || row.id !== hostingCleanupRef(initial.projectId, initial.candidateId).id) { failed++; continue; }
    const job = await db.runTransaction(async tx => {
      const current = (await tx.get(row.ref)).data(), state = (await tx.get(hostingState(initial.projectId))).data();
      const candidateRef = hostingCandidates(initial.projectId).doc(initial.candidateId), candidate = (await tx.get(candidateRef)).data();
      if (!current || current.retryAt > now()) return null;
      if (current.projectId !== initial.projectId || current.candidateId !== initial.candidateId
        || !['inspect', 'delete', 'audit'].includes(current.phase) || !['staging', 'all'].includes(current.scope)) throw new Error('Cleanup intent scope changed.');
      if (current.phase === 'audit') {
        if (current.attempts >= 64) { tx.update(row.ref, { attempts: 0, retryAt: now() + 7 * 86400000 }); return { exhausted: true as const }; }
        const claimed = { ...current, retryAt: now() + 60000, attempts: current.attempts + 1 };
        tx.set(row.ref, claimed); return claimed;
      }
      if (!candidate) { tx.delete(row.ref); return null; }
      if (!state || candidate.projectId !== initial.projectId) throw new Error('Invalid cleanup scope.');
      if (current.attempts >= 64) { tx.update(row.ref, { retryAt: Number.MAX_SAFE_INTEGER }); return { exhausted: true as const }; }
      if (current.phase === 'delete' && current.scope === 'all' && (candidate.state !== 'deleting' || state.observedCandidate === candidate.id)) throw new Error('Retired upload authority changed.');
      let scope = current.scope;
      if (current.phase === 'inspect') {
        if (state.pendingOperation) { tx.update(row.ref, { retryAt: now() + 60_000 }); return null; }
        let deadline: number | null = null;
        if (candidate.id !== state.observedCandidate) {
          if (candidate.lastPublishedAt !== null) {
            const retiredAt = state.retiredBuilds[candidate.id];
            if (retiredAt === undefined) throw new Error('Retirement is not confirmed.');
            deadline = retiredAt + HOSTING_LIMITS.retirementGraceMs;
          } else if (candidate.policyRevision !== state.policy.revision || !state.policy.enabled) {
            deadline = state.policyChangedAt + HOSTING_LIMITS.retirementGraceMs;
          } else if (candidate.state === 'ready' && state.policy.mode === 'automatic') {
            if (candidate.readyAt === null) throw new Error('Ready time is not confirmed.');
            deadline = candidate.readyAt + HOSTING_LIMITS.retirementGraceMs;
          } else if (candidate.state === 'uploading') {
            deadline = candidate.expiresAt + HOSTING_LIMITS.retirementGraceMs;
          }
        }
        if (deadline !== null && deadline > now()) { tx.update(row.ref, { retryAt: deadline }); return null; }
        scope = deadline === null ? 'staging' : 'all';
        if (scope === 'all') {
          tx.update(candidateRef, { state: 'deleting' });
          tx.update(hostingState(initial.projectId), { changeRevision: state.changeRevision + 1, updatedAt: now() });
        }
      }
      const claimed: CleanupJob = { ...current, scope, phase: 'delete', fenceGeneration: state.generation,
        retryAt: now() + 60_000, attempts: current.attempts + 1 };
      tx.set(row.ref, claimed); return claimed;
    });
    if (!job) continue;
    if ('exhausted' in job) { exhausted++; failed++; continue; }
    attempted++;
    try {
      const result = await transport.command(job.projectId, `${job.phase === 'audit' ? 'audit' : 'cleanup'}/${job.candidateId}`, { scope: job.scope, fenceGeneration: job.fenceGeneration });
      if (result.candidateId !== job.candidateId || result.scope !== job.scope || typeof result.done !== 'boolean'
        || !Number.isSafeInteger(result.deleted) || Number(result.deleted) < 0 || Number(result.deleted) > HOSTING_LIMITS.cleanupBatch
        || result.done && result.deleted !== 0) throw new Error('Cleanup acknowledgement does not match its scope.');
      deletedObjects += Number(result.deleted);
      releasedBytes += await db.runTransaction(async tx => {
        const current = (await tx.get(row.ref)).data();
        if (!current || current.intent !== job.intent || current.phase !== job.phase || current.scope !== job.scope) return 0;
        const candidateRef = hostingCandidates(job.projectId).doc(job.candidateId);
        const candidate = (await tx.get(candidateRef)).data(), state = (await tx.get(hostingState(job.projectId))).data();
        if (!result.done) { tx.update(row.ref, { retryAt: now() + 1 }); return 0; }
        if (job.phase === 'audit') {
          tx.set(row.ref, { ...current, attempts: 0, retryAt: now() + 7 * 86400000 }); return 0;
        }
        if (job.scope === 'all' && candidate) {
          if (!state || state.observedCandidate === candidate.id || candidate.state !== 'deleting'
            || state.reservedBytes < candidate.artifact.bytes || state.candidates < 1) throw new Error('Cleanup accounting needs review.');
          // Keep a small permanent intent receipt, not old file inventories. Exactly-once
          // capacity release and nonce retirement share this transaction.
          tx.set(hostingReceipts(job.projectId).doc(candidate.id), { fingerprint: candidate.artifact.digest,
            result: { kind: 'retired-upload', candidateId: candidate.id, deletedAt: now() } });
          tx.delete(candidateRef);
          const retiredBuilds = { ...state.retiredBuilds }; delete retiredBuilds[candidate.id];
          tx.set(hostingState(job.projectId), { ...state, retiredBuilds, reservedBytes: state.reservedBytes - candidate.artifact.bytes,
            candidates: state.candidates - 1, changeRevision: state.changeRevision + 1, updatedAt: now() });
          tx.set(row.ref, { ...current, phase: 'audit', attempts: 0, retryAt: now() + 86400000 }); return candidate.artifact.bytes;
        }
        tx.set(row.ref, { ...current, phase: 'audit', attempts: 0, retryAt: now() + 86400000 }); return 0;
      });
    } catch {
      failed++;
      await db.runTransaction(async tx => {
        const current = (await tx.get(row.ref)).data();
        if (current?.intent === job.intent) tx.update(row.ref, { retryAt: now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(job.attempts - 1, 6)) });
      });
    }
  }
  return { selected: due.size, attempted, deletedObjects, releasedBytes, failed, exhausted };
}
