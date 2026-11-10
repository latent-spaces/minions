import type { NativeTask, NativeTaskDetail, NativeTaskMutation, NativeTaskMutationResult, NativeTaskPage, NativeTaskReference } from '@mlswarm/contracts';
import type { NativeTaskStatus } from '@mlswarm/contracts';

export interface TasksApi {
  list(cursor?: string | null, status?: NativeTaskStatus, assignedAgentId?: string | null, search?: string): Promise<NativeTaskPage>;
  get(taskId: string, cursors?: { commentCursor?: string | null; activityCursor?: string | null; activityOrder?: 'asc' | 'desc'; activityId?: string }): Promise<NativeTaskDetail>;
  mutate(mutation: NativeTaskMutation): Promise<NativeTaskMutationResult>;
}

// Native tasks (contract v1): the project's own work record. Assignment never starts, steers or extends an agent.
export const TASK_STATUSES: { id: NativeTaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Backlog' }, { id: 'in_progress', label: 'In progress' }, { id: 'done', label: 'Done' }, { id: 'canceled', label: 'Canceled' }];
export const statusLabel = (status: NativeTaskStatus) => TASK_STATUSES.find(s => s.id === status)?.label ?? status;

/** The app-side status rules the server also enforces: why a task cannot move to `status` from here, or null when it may. */
export function statusChangeBlock(task: Pick<NativeTask, 'status' | 'assignedAgentId'>, status: NativeTaskStatus): string | null {
  if (task.status === status) return null;
  if (task.status === 'canceled' && status !== 'backlog') return 'Reopen to Backlog first';
  if ((status === 'in_progress' || status === 'done') && !task.assignedAgentId) return 'Assign an agent before starting or completing this task';
  return null;
}

/** Tasks tab views (owner direction, 9 November 2026): the existing list and a board of status columns. The choice is kept per browser. */
export type TasksView = 'list' | 'board';
export const TASKS_VIEW_KEY = 'k42.tasksView';
export function readTasksView(storage: Pick<Storage, 'getItem'> | null): TasksView {
  try { return storage?.getItem(TASKS_VIEW_KEY) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
}
export function writeTasksView(storage: Pick<Storage, 'setItem'> | null, view: TasksView): void {
  try { storage?.setItem(TASKS_VIEW_KEY, view); } catch { /* Blocked storage keeps the choice for this visit only. */ }
}

type Mutation = NativeTaskMutation extends infer M ? M extends unknown ? Omit<M, 'clientRequestId'> : never : never;

/** One mutation: a stable clientRequestId per attempt, so a retry after an uncertain response replays the same outcome. */
export function taskMutation(input: Mutation, clientRequestId: string = crypto.randomUUID()): NativeTaskMutation {
  return { ...input, clientRequestId } as NativeTaskMutation;
}

/** A replay receipt proves a past write, not that its task snapshot is still current. */
export function newestTaskSnapshot(current: NativeTask | null | undefined, incoming: NativeTask): NativeTask {
  return current?.id === incoming.id && current.projectId === incoming.projectId && current.revision > incoming.revision ? current : incoming;
}

/** Tasks were turned off for the project after this page loaded (server refusal `tasks_disabled`, sent as 409). */
export const isTasksDisabled = (error: unknown) => !!error && typeof error === 'object' && (error as { code?: string }).code === 'tasks_disabled';

/** A stale revision (409) means someone else changed the task first; the drawer reloads and keeps the draft. */
export const isConflict = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 409 && !isTasksDisabled(error);

/** Confirmed refusals: the outcome is known, so the request is not retried. Anything else (network, 5xx) is uncertain. */
export const isSettledRefusal = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [400, 401, 403, 404, 409, 422].includes((error as { status: number }).status);
/** Access to the project or task is gone: drop anything already shown. */
export const isAccessLoss = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [401, 403, 404].includes((error as { status: number }).status);

/** Only http(s) URLs render as links; anything else stays plain text. */
export function safeUrl(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null; } catch { return null; }
}

export function taskSourceHref(reference: NativeTaskReference, projectId?: string, viewerUrl?: string): string | null {
  if (!('sourceId' in reference) || !projectId || !viewerUrl) return null;
  const url = new URL(viewerUrl);
  url.search = new URLSearchParams({ project: projectId, section: 'conversations', [reference.kind === 'message' ? 'message' : 'thread']: reference.sourceId }).toString();
  return url.href;
}
export function taskReferenceFromUrl(value: string, id: string, projectId?: string, viewerUrl?: string, label?: string): NativeTaskReference {
  const trimmedLabel = label?.trim();
  if (trimmedLabel && trimmedLabel.length > 120) throw new Error('Keep the link label to 120 characters or fewer.');
  const named = trimmedLabel ? { label: trimmedLabel } : {};
  const href = safeUrl(value.trim());
  if (!href || !href.startsWith('https:') && !(viewerUrl && new URL(href).origin === new URL(viewerUrl).origin)) throw new Error('Enter a full https:// link or a project conversation link.');
  const url = new URL(href);
  if (viewerUrl && url.origin === new URL(viewerUrl).origin && url.searchParams.get('section') === 'conversations') {
    if (url.searchParams.get('project') !== projectId) throw new Error('Choose a conversation from this project.');
    const message = url.searchParams.get('message'), thread = url.searchParams.get('thread'), sourceId = message ?? thread;
    if (!sourceId || !/^[\w-]{1,200}$/.test(sourceId)) throw new Error('Copy the link to a specific conversation or message.');
    return { id, kind: message ? 'message' : 'conversation', sourceId, ...named };
  }
  if (url.protocol !== 'https:') throw new Error('Result links must use https://.');
  return { id, kind: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?(?:[?#].*)?$/.test(href) ? 'pull_request' : 'result', url: href, ...named };
}

/** A label explains the relationship; the type and original destination stay separate. */
export function taskReferenceView(reference: NativeTaskReference): { label: string; text: string; href: string | null; destination?: string } {
  if ('url' in reference) {
    const href = safeUrl(reference.url);
    let destination = reference.url;
    if (href && reference.kind === 'pull_request') {
      const url = new URL(href), match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/);
      if (url.hostname === 'github.com' && match) destination = `${match[1]}/${match[2]} #${match[3]}`;
    }
    return { label: reference.kind === 'pull_request' ? 'Pull request' : 'Result', text: reference.label || destination, href, ...(reference.label && reference.kind === 'pull_request' && reference.label !== destination ? { destination } : {}) };
  }
  const conversation = reference.kind === 'conversation';
  return { label: conversation ? 'Conversation' : 'Message', text: reference.label || (conversation ? 'Open conversation' : 'Open message'), href: null };
}

// Admits one request per generation; set synchronously, so two clicks before React rerenders still send one.
// A newer generation (account, project or refresh change) may start while an older reply is still pending.
export function singleFlight() {
  let owner: number | null = null;
  return {
    start: (generation: number) => owner !== generation && (owner = generation, true),
    end: (generation: number) => owner === generation && (owner = null, true),
  };
}
