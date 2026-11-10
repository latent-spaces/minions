import type { HostingArtifact, HostingPolicy, HostingOperationState } from '@mlswarm/contracts';
import { collection } from '../firestore.js';

export type HostingState = {
  policy: HostingPolicy; changeRevision: number; generation: number; observedRevision: number; observedArtifact: string | null;
  observedCandidate: string | null; retiredBuilds: Record<string, number>; policyChangedAt: number;
  pendingOperation: string | null; reservedBytes: number; candidates: number; updatedAt: number;
};
export type HostingCandidate = {
  id: string; projectId: string; actorKey: string; profileId: string; epoch: number; policyRevision: number;
  artifact: HostingArtifact; fileCount: number; createdAt: number; expiresAt: number;
  submittedBy: { profileId: string; name: string; agentId: string | null };
  lastPublishedAt: number | null; readyAt: number | null;
  state: 'uploading' | 'ready' | 'deleting';
};
export type HostingOperation = {
  id: string; projectId: string; fingerprint: string; actorKey: string; profileId: string; epoch: number;
  candidateId: string | null; artifact: string | null; policyRevision: number; generation: number;
  approvedBy: { profileId: string; epoch: number } | null;
  connection: { agentId: string; runId: string; tokenHashDigest: string } | null;
  computerConnection?: { connectionId: string; tokenHashDigest: string };
  state: HostingOperationState; createdAt: number; updatedAt: number; attempts: number; retryAt: number; recoveries: number;
};
export const hostingState = (id: string) => collection<HostingState>(`projects/${id}/hosting`).doc('primary');
export const hostingCandidates = (id: string) => collection<HostingCandidate>(`projects/${id}/hostingCandidates`);
export const hostingOperations = (id: string) => collection<HostingOperation>(`projects/${id}/hostingOperations`);
export const hostingReceipts = (id: string) => collection<{ fingerprint: string; result: object }>(`projects/${id}/hostingReceipts`);
export const initialHostingState = (): HostingState => ({
  policy: { revision: 0, enabled: false, audience: 'public', mode: 'approval', approvers: [], submitters: [] },
  observedCandidate: null, retiredBuilds: {}, policyChangedAt: 0,
  changeRevision: 0, generation: 0, observedRevision: 0, observedArtifact: null, pendingOperation: null,
  reservedBytes: 0, candidates: 0, updatedAt: 0,
});
