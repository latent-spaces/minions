import type { NativeTaskActor } from './native-tasks.js';

export interface DeliveryReviewRequiredCheck {
  name: string;
  workflowId: number;
  workflowPath: string;
  workflowBlobSha: string;
}

export interface DeliveryReviewSubmission {
  repository: string;
  pullRequest: number;
  headSha: string;
  manifest: string;
  reportedTests?: { path: string; sha256: string }[];
}

export interface DeliveryReviewCandidate extends DeliveryReviewSubmission {
  generation: number;
  submittedBy: NativeTaskActor;
  submittedAt: number;
}

export interface DeliveryReviewVerdict {
  verdict: 'approved' | 'changes_requested';
  note: string;
  actor: NativeTaskActor;
  at: number;
}

export type DeliveryReviewMutation = { taskId: string; clientRequestId: string } & (
  | { operation: 'configure'; enabled: boolean; expectedGeneration: number; reviewerAgentId?: string | null; requiredChecks?: DeliveryReviewRequiredCheck[]; reason?: string }
  | ({ operation: 'submit'; expectedGeneration: number } & DeliveryReviewSubmission)
  | { operation: 'verdict'; generation: number; verdict: DeliveryReviewVerdict['verdict']; note: string }
  | { operation: 'refresh'; generation: number }
);

export interface DeliveryReviewObservation {
  status: 'verified' | 'pending' | 'failed' | 'stale' | 'unavailable';
  observedAt: number;
  actualHeadSha: string | null;
  staleReason?: 'closed' | 'head_changed';
  checks: { name: string; status: 'verified' | 'pending' | 'failed' | 'unavailable'; runId?: number; runAttempt?: number; jobId?: number; checkRunId?: number }[];
}

export interface DeliveryReviewState {
  failedCheckNames: string[];
  enabled: boolean;
  reviewerAgentId: string | null;
  requiredChecks: DeliveryReviewRequiredCheck[];
  generation: number;
  current: DeliveryReviewCandidate | null;
  verdict: DeliveryReviewVerdict | null;
  observation: DeliveryReviewObservation | null;
}

export type DeliveryReviewEvent = { id: string; generation: number; at: number } & (
  | { kind: 'configured'; actor: NativeTaskActor; enabled: boolean; reviewerAgentId: string | null; requiredChecks: DeliveryReviewRequiredCheck[]; reason?: string }
  | { kind: 'submitted'; candidate: DeliveryReviewCandidate }
  | { kind: 'verdict'; verdict: DeliveryReviewVerdict }
  | { kind: 'observed'; observation: DeliveryReviewObservation }
  | { kind: 'invalidated'; actor: NativeTaskActor; reason: 'task_requirements_changed' | 'task_assignment_changed' }
);

export interface DeliveryReviewDetail extends DeliveryReviewState {
  events: DeliveryReviewEvent[];
  nextCursor: string | null;
}

export interface DeliveryReviewMutationResult {
  event: DeliveryReviewEvent;
  replayed: boolean;
}
