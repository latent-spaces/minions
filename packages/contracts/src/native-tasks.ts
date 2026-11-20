import type { DeliveryReviewState } from './delivery-review.js';

/** Native task contract v1. Assignment never grants execution or repository authority. */
export type NativeTaskStatus = 'backlog' | 'in_progress' | 'done' | 'canceled';
export type NativeTaskPriority = 'low' | 'normal' | 'high';
export type NativeTaskActor = { kind: 'person' | 'agent'; id: string };
export type NativeTaskContributor = { kind: 'agent'; id: string };
/** Exact progress across all direct, accepted subtasks, independent of list filters and pagination. */
export interface NativeSubtaskProgress { done: number; total: number }
export type NativeTaskReference =
  | { id: string; kind: 'pull_request' | 'result'; url: string; label?: string }
  | { id: string; kind: 'conversation' | 'message'; sourceId: string; label?: string };
export interface NativeTask {
  id: string; projectId: string; title: string; description: string;
  status: NativeTaskStatus; assignedAgentId: string | null;
  contributors: NativeTaskContributor[]; priority: NativeTaskPriority;
  references: NativeTaskReference[]; createdBy: NativeTaskActor;
  createdAt: number; updatedAt: number; revision: number;
  /** v1.2: actual field authors; createdBy remains the task creator. */
  titleAuthor?: NativeTaskActor; descriptionAuthor?: NativeTaskActor;
  referenceAuthors?: Record<string, NativeTaskActor>;
  /** v1.3 subtasks (owner, 11 November 2026): the parent task, set at creation; missing or null is a top-level task. */
  parentId?: string | null;
  /** v1.3: an agent's proposed subtask, waiting for an owner's yes. It can't be claimed, assigned or started. */
  proposed?: boolean;
  /** Computed on list/detail reads, never persisted in a task or mutation receipt. Canceled children count as done. */
  subtaskProgress?: NativeSubtaskProgress;
}
export interface NativeTaskComment {
  id: string; taskId: string; author: NativeTaskActor; body: string;
  createdAt: number; updatedAt: number;
}
export interface NativeTaskActivity {
  id: string; taskId: string; actor: NativeTaskActor; action: NativeTaskMutation['operation'];
  revision: number; at: number;
  /** v1.1: immutable mutation snapshots for readable edit and status history. */
  task?: NativeTask; comment?: NativeTaskComment;
  fields?: (keyof NativeTask)[];
}
export type NativeTaskMutation = { clientRequestId: string } & (
  /** `message` (people only): a note to the person's own agents, kept as the task's first comment. */
  | { operation: 'create'; title: string; description?: string; assignedAgentId?: null; priority?: NativeTaskPriority; parentId?: string; message?: string }
  | { operation: 'update'; taskId: string; expectedRevision: number; title?: string; description?: string; status?: NativeTaskStatus; priority?: NativeTaskPriority; contributors?: NativeTaskContributor[] }
  | { operation: 'claim' | 'release'; taskId: string; expectedRevision: number }
  /** `message` (people only, to their own agent): rides on the task_assigned item and is kept as a task comment. */
  | { operation: 'assign'; taskId: string; expectedRevision: number; assignedAgentId: string; message?: string }
  | { operation: 'comment'; taskId: string; expectedRevision: number; body: string }
  | { operation: 'edit_comment'; taskId: string; expectedRevision: number; commentId: string; body: string }
  | { operation: 'add_reference'; taskId: string; expectedRevision: number; reference: NativeTaskReference }
  | { operation: 'remove_reference'; taskId: string; expectedRevision: number; referenceId: string }
  | { operation: 'review_proposal'; taskId: string; expectedRevision: number; accept: boolean }
);
export interface NativeTaskMutationResult {
  task: NativeTask; comment?: NativeTaskComment;
  /** True for an exact retry's saved outcome. Its task is historical; read again for current state. */
  replayed: boolean;
}
/** Compact discovery fields. Read the full task before acting on its requirements. */
export type NativeTaskSummary = Pick<NativeTask, 'id' | 'title' | 'status' | 'assignedAgentId' | 'priority' | 'revision' | 'parentId' | 'proposed' | 'subtaskProgress'>;
/** A task page's breadcrumb entry, root first. */
export interface NativeTaskAncestor { id: string; title: string }
export interface NativeTaskPage { tasks: NativeTask[]; nextCursor: string | null }
export interface NativeTaskPermissions { edit: boolean; editDescription: boolean; control: boolean; assign: 'any' | 'own' | 'none';
  /** v1.3: may accept or decline this proposed subtask (project owners and admins). */
  review?: boolean;
  configureDeliveryReview?: boolean }
export interface NativeTaskDetail { task: NativeTask; permissions: NativeTaskPermissions; comments: NativeTaskComment[]; activity: NativeTaskActivity[]; nextCommentCursor: string | null; nextActivityCursor: string | null;
  /** v1.3: parents from the top-level task down to this task's parent. */
  ancestors?: NativeTaskAncestor[];
  /** v1.3: this task's direct subtasks (up to 100), oldest first, including proposals. */
  subtasks?: NativeTaskSummary[];
  deliveryReview?: DeliveryReviewState }

/** Agents nest subtasks two levels deep: a task and its subtasks. People may nest deeper. */
export const AGENT_TASK_DEPTH = 2;
/** A subtask counts as closed for its parent's done/total ring when it is done or canceled. Pending proposals don't count. */
export function closedTask(task: Pick<NativeTask, 'status'>): boolean { return task.status === 'done' || task.status === 'canceled'; }

/** v2: optional project capability. Missing persisted configuration means enabled. */
export interface NativeTaskSettings { enabled: boolean; revision: number }
export function nativeTasksEnabled(settings?: { enabled?: boolean } | null): boolean { return settings?.enabled !== false; }

const foldText = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US');
// True when a and b differ by at most one insertion, deletion, substitution or swap of neighbours.
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
/**
 * Fuzzy title search, shared by server readers and visible-row updates. Case and accents are ignored and every
 * search word must match, in any order: as text anywhere in the title, or, for words of four or more letters,
 * a title word or its start that is one typo away.
 */
export function nativeTaskTitleMatches(title: string, search: string): boolean {
  const text = foldText(title), words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return foldText(search).split(/\s+/).filter(Boolean).every(token => text.includes(token)
    || (token.length >= 4 && words.some(word => [-1, 0, 1].some(extra => withinOneEdit(token, word.slice(0, token.length + extra))))));
}
