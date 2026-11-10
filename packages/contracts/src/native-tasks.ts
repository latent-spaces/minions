/** Native task contract v1. Assignment never grants execution or repository authority. */
export type NativeTaskStatus = 'backlog' | 'in_progress' | 'done' | 'canceled';
export type NativeTaskPriority = 'low' | 'normal' | 'high';
export type NativeTaskActor = { kind: 'person' | 'agent'; id: string };
export type NativeTaskContributor = { kind: 'agent'; id: string };
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
  | { operation: 'create'; title: string; description?: string; assignedAgentId?: null; priority?: NativeTaskPriority }
  | { operation: 'update'; taskId: string; expectedRevision: number; title?: string; description?: string; status?: NativeTaskStatus; priority?: NativeTaskPriority; contributors?: NativeTaskContributor[] }
  | { operation: 'claim' | 'release'; taskId: string; expectedRevision: number }
  | { operation: 'assign'; taskId: string; expectedRevision: number; assignedAgentId: string }
  | { operation: 'comment'; taskId: string; expectedRevision: number; body: string }
  | { operation: 'edit_comment'; taskId: string; expectedRevision: number; commentId: string; body: string }
  | { operation: 'add_reference'; taskId: string; expectedRevision: number; reference: NativeTaskReference }
  | { operation: 'remove_reference'; taskId: string; expectedRevision: number; referenceId: string }
);
export interface NativeTaskMutationResult {
  task: NativeTask; comment?: NativeTaskComment;
  /** True for an exact retry's saved outcome. Its task is historical; read again for current state. */
  replayed: boolean;
}
/** Compact discovery fields. Read the full task before acting on its requirements. */
export type NativeTaskSummary = Pick<NativeTask, 'id' | 'title' | 'status' | 'assignedAgentId' | 'priority' | 'revision'>;
export interface NativeTaskPage { tasks: NativeTask[]; nextCursor: string | null }
export interface NativeTaskPermissions { edit: boolean; editDescription: boolean; control: boolean; assign: 'any' | 'own' | 'none' }
export interface NativeTaskDetail { task: NativeTask; permissions: NativeTaskPermissions; comments: NativeTaskComment[]; activity: NativeTaskActivity[]; nextCommentCursor: string | null; nextActivityCursor: string | null }

/** v2: optional project capability. Missing persisted configuration means enabled. */
export interface NativeTaskSettings { enabled: boolean; revision: number }
export function nativeTasksEnabled(settings?: { enabled?: boolean } | null): boolean { return settings?.enabled !== false; }

/** Literal title substring search, shared by server readers and visible-row updates. */
export function nativeTaskTitleMatches(title: string, search: string): boolean {
  return title.toLocaleLowerCase('en-US').includes(search.trim().toLocaleLowerCase('en-US'));
}
