import type { WorkSignal } from './work-signals.js';
// Plan v2 records, as in section 3 of docs/architecture/agent-coordination-api.md. Times are Unix
// milliseconds.
import type { DocumentData, Timestamp } from '../firestore.js';
import { projectCollection as collection } from '../firestore.js';
import type { AgentGroup } from './agent-group.js';

export type Audience = 'direct' | 'project';

// A thread's first message has its own id as threadId, so one query returns the whole thread.
export type MessageV2 = {
  id: string;
  agentId: string;
  agentName: string;
  threadId: string;
  body: string;
  summary?: string;
  to: string[];
  audience: Audience;
  createdAt: number;
  protocol: 2;
};

export type ItemKind = 'message' | 'announcement' | 'project_started' | 'paused' | 'resumed' | 'card_changed' | 'task_assigned' | 'task_children_closed' | 'task_created';

// last: the highest delivered seq. acked: the highest acknowledged.
export type Inbox = { last: number; acked: number; updatedAt: number; lastDirect?: number };

export type InboxItem = {
  seq: number;
  sourceId: string;
  kind: ItemKind;
  messageId: string | null;
  payload: DocumentData;
  deliveredAt: number;
  // Set when the item is acknowledged. A Firestore TTL policy on this field deletes the item.
  expireAt?: Timestamp;
};

type SourceMarker = { seq: number };

// One per project-wide item. cursor: the last agent id done, in document id order.
export type Fanout = {
  kind: ItemKind;
  payload: DocumentData;
  messageId: string | null;
  // The agent that sent it, which does not receive it.
  senderId: string | null;
  createdAt: number;
  audienceBefore: number;
  cursor: string;
  delivered: number;
  status: 'pending' | 'done';
  leaseOwner: string | null;
  leaseUntil: number;
  protocol: 2;
};

export type Run = {
  mode?: 'current_chat';
  approvedAt?: number;
  deadlineAt?: number;
  workSignal?: WorkSignal;
  runId: string;
  generation: number;
  runnerVersion: string;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  protocol: 2;
};

export type Phase = 'idle' | 'turn' | 'backoff' | 'paused' | 'stopping';
type CoordinationContext = import('@mlswarm/contracts').ContextSummary;
export type TurnUsage = {
  nativeContext?:import('@mlswarm/contracts').NativeContextObservation;
  sequence: number; model: string | null; seconds: number; costUsd?: number | null;
  provider?: 'claude' | 'codex'; modelSource?: 'provider-report' | 'client-selected' | 'provider-rerouted' | 'unknown';
  inputSemantics?: 'uncached' | 'includes-cache'; toolCalls?: number; toolScope?: 'provider-stream' | 'mcp-bridge' | 'partial';
  context?: CoordinationContext;
  tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; modelCalls: number | null } | null;
};
export type UsageTotals = {
  runId: string; sequence: number; firstReportedAt: number; lastReportedAt: number;
  turns: number; seconds: number; model: string | null; costUsd: number; costReports: number; tokenReports: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; modelCalls: number;
  tokenCoverage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  provider?: string; modelSource?: string; inputSemantics?: 'uncached' | 'includes-cache' | 'mixed' | 'unknown';
  toolCalls?: number; toolReports?: number; partialToolReports?: number;

};
export const runnerUsage = () => collection<UsageTotals>('runnerUsage');
// Owner End may arrive before the device's first cloud registration.
export const chatParticipationEnds = () => collection<{ agentId: string; runId: string; endedAt: number;
  stopFingerprint?: string; reportedAt?: number }>('chatParticipationEnds');

export type LastTurn = { kind: string; outcome: 'succeeded' | 'failed' | 'timed_out' | 'budget_cap'; endedAt: number; usage?: TurnUsage };

export type Presence = {
  runId: string;
  lastContactAt: number;
  phase: Phase;
  phaseAt: number;
  lastTurn: LastTurn | null;
  activity?: { tool: string; at: number } | null;
  acceptingWork: boolean | null;
  protocol: 2;
  // Contract C3 worker group (gate 2 (a)): the worker-session summary, written on every sync (staged W1/R2/W3 beside the pointer's).
  worker?: WorkerSummaryFields;
  // The run's end and mode, mirrored from runs/{agent} by its start and every run-ending writer (stage E1).
  runEndedAt?: number | null;
  runMode?: 'current_chat' | null;
  // The agent group (current-state contract C3), written whole by writeAgentGroup in agent-group.ts.
  agent?: AgentGroup;
};
// The worker-session summary's fields (the same as projects/worker-sessions.ts WorkerSummary).
export type WorkerSummaryFields = { runId: string; phase: 'working' | 'idle' | 'waiting' | 'paused' | 'blocked' | 'stopped' | 'completed';
  lastContactAt: number; deadlineAt: number; projectPauseRevision?: number | null };

export const messagesV2 = () => collection<MessageV2>('messages');
export const inboxes = () => collection<Inbox>('inboxes');
export const fanouts = () => collection<Fanout>('fanouts');
export const runs = () => collection<Run>('runs');
export const presence = () => collection<Presence>('presence');

export function inboxItems(agentId: string) {
  return collection<InboxItem>(`inboxes/${agentId}/items`);
}

export function sourceMarkers(agentId: string) {
  return collection<SourceMarker>(`inboxes/${agentId}/sources`);
}

// Padded, so items sort by id in seq order.
export function itemId(seq: number): string {
  return String(seq).padStart(12, '0');
}

// Returned positions are scoped to the run that read them. Never infer a receipt from inbox.last.
export function readReceipts(agentId: string) {
  return collection<{ positions: number[] }>(`inboxes/${agentId}/receipts`);
}

// Inert completion evidence is retained independently of the current runner lease.
export type RunHistory = { agentId: string; runId: string; generation: number; startedAt: number;
  mode?: 'current_chat'; approvedAt?: number; deadlineAt?: number;
  startInput: { runnerVersion: string; takeover?: boolean; mode?: 'current_chat'; approvedAt?: number; deadlineAt?: number };
  stopFingerprint?: string; endedAt?: number };
type ChatDeadlineReceipt = { agentId: string; runId: string; requestId: string; fingerprint: string;
  approvedAt: number; expectedDeadlineAt: number; deadlineAt: number; receivedAt: number };
type TurnReceipt = { agentId: string; runId: string; sequence: number; fingerprint: string;
  lastTurn: LastTurn; receivedAt: number };
export const runHistory = () => collection<RunHistory>('runHistory');
export const turnReceipts = () => collection<TurnReceipt>('turnReports');
export const chatDeadlineReceipts = () => collection<ChatDeadlineReceipt>('chatDeadlineReceipts');
