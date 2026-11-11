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
  | { operation: 'create'; title: string; description?: string; assignedAgentId?: null; priority?: NativeTaskPriority; parentId?: string }
  | { operation: 'update'; taskId: string; expectedRevision: number; title?: string; description?: string; status?: NativeTaskStatus; priority?: NativeTaskPriority; contributors?: NativeTaskContributor[] }
  | { operation: 'claim' | 'release'; taskId: string; expectedRevision: number }
  | { operation: 'assign'; taskId: string; expectedRevision: number; assignedAgentId: string }
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
  review?: boolean }
export interface NativeTaskDetail { task: NativeTask; permissions: NativeTaskPermissions; comments: NativeTaskComment[]; activity: NativeTaskActivity[]; nextCommentCursor: string | null; nextActivityCursor: string | null;
  /** v1.3: parents from the top-level task down to this task's parent. */
  ancestors?: NativeTaskAncestor[];
  /** v1.3: this task's direct subtasks (up to 100), oldest first, including proposals. */
  subtasks?: NativeTaskSummary[] }

/** Agents nest subtasks two levels deep: a task and its subtasks. People may nest deeper. */
export const AGENT_TASK_DEPTH = 2;
/** A subtask counts as closed for its parent's done/total ring when it is done or canceled. Pending proposals don't count. */
export function closedTask(task: Pick<NativeTask, 'status'>): boolean { return task.status === 'done' || task.status === 'canceled'; }

/** v2: optional project capability. Missing persisted configuration means enabled. */
export interface NativeTaskSettings { enabled: boolean; revision: number }
export function nativeTasksEnabled(settings?: { enabled?: boolean } | null): boolean { return settings?.enabled !== false; }

/** Literal title substring search, shared by server readers and visible-row updates. */
export function nativeTaskTitleMatches(title: string, search: string): boolean {
  return title.toLocaleLowerCase('en-US').includes(search.trim().toLocaleLowerCase('en-US'));
}
