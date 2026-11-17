import { AGENT_TASK_DEPTH, closedTask, nativeTaskTitleMatches } from '@minions/contracts';
import { assertNativeTasksEnabled, effectiveNativeTaskSettings } from './native-task-settings.js';
import { createHash } from 'node:crypto';
import { FieldPath, FieldValue, Timestamp, type Transaction } from '../firestore.js';
import { z } from 'zod';
import type { NativeTask, NativeTaskAncestor, NativeTaskSummary, NativeTaskActor, NativeTaskMutationResult, NativeTaskPage, NativeTaskDetail, NativeTaskComment, NativeTaskActivity, NativeTaskReference, NativeTaskPermissions } from '@minions/contracts';
import { agents, currentProjectId, db, projectCollection } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertAgentMembership, assertMembership, assertProjectWritable, currentConnectionEpoch, type ProjectRole } from './access.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { backlog, deliver, readTargets, type Target } from '../v2/inbox.js';
import { LIMITS, V2_LIMITS } from '../config.js';
import { assertNewProgressAction, type ProgressActor } from './progress-authority.js';
import { conversationEntries, type TaskMessage } from './steering.js';
import { projects, runtimeOf } from './records.js';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const STATUS = z.enum(['backlog', 'in_progress', 'done', 'canceled']);
const PRIORITY = z.enum(['low', 'normal', 'high']);
const CONTRIBUTOR = z.object({ kind: z.literal('agent'), id: ID }).strict();
const REFERENCE_LABEL = z.string().trim().min(1).max(120).optional();
const HTTPS_URL = z.string().url().max(2000).refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}, 'Use an HTTPS URL without credentials.').transform(value => new URL(value).href).pipe(z.string().max(2000));
const REFERENCE = z.discriminatedUnion('kind', [
  z.object({ id: ID, kind: z.literal('pull_request'), url: HTTPS_URL.refine(value => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?(?:[?#].*)?$/.test(value), 'Use a GitHub pull request URL.'), label: REFERENCE_LABEL }).strict(),
  z.object({ id: ID, kind: z.literal('result'), url: HTTPS_URL, label: REFERENCE_LABEL }).strict(),
  z.object({ id: ID, kind: z.literal('conversation'), sourceId: ID, label: REFERENCE_LABEL }).strict(),
  z.object({ id: ID, kind: z.literal('message'), sourceId: ID, label: REFERENCE_LABEL }).strict(),
]);
const base = { clientRequestId: z.string().uuid() };
const edit = { ...base, taskId: ID, expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) };
// A person's note to their own agents about a new task, as long as an agent message may be.
const TASK_MESSAGE = z.string().trim().min(1).max(LIMITS.messageMaxChars).optional();
export const NATIVE_TASK_MUTATION = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('create'), title: z.string().trim().min(1).max(300), description: z.string().max(10000).optional(), assignedAgentId: z.null().optional(), priority: PRIORITY.optional(), parentId: ID.optional(), message: TASK_MESSAGE }).strict(),
  z.object({ ...edit, operation: z.literal('update'), title: z.string().trim().min(1).max(300).optional(), description: z.string().max(10000).optional(), status: STATUS.optional(), priority: PRIORITY.optional(), contributors: z.array(CONTRIBUTOR).max(30).optional() }).strict(),
  z.object({ ...edit, operation: z.literal('claim') }).strict(),
  z.object({ ...edit, operation: z.literal('release') }).strict(),
  z.object({ ...edit, operation: z.literal('assign'), assignedAgentId: ID, message: TASK_MESSAGE }).strict(),
  z.object({ ...edit, operation: z.literal('comment'), body: z.string().trim().min(1).max(6000) }).strict(),
  z.object({ ...edit, operation: z.literal('edit_comment'), commentId: ID, body: z.string().trim().min(1).max(6000) }).strict(),
  z.object({ ...edit, operation: z.literal('add_reference'), reference: REFERENCE }).strict(),
  z.object({ ...edit, operation: z.literal('remove_reference'), referenceId: ID }).strict(),
  z.object({ ...edit, operation: z.literal('review_proposal'), accept: z.boolean() }).strict(),
]);
export const NATIVE_TASK_QUERY = z.object({ search: z.string().trim().max(300).optional(), status: STATUS.optional(), assignedAgentId: ID.optional(), unassigned: z.literal('true').optional(), parentId: ID.optional(), cursor: ID.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().refine(input => !(input.unassigned && input.assignedAgentId), 'Choose an agent or unassigned, not both.');
export const NATIVE_TASK_DETAIL_QUERY = z.object({ commentCursor: ID.optional(), activityCursor: ID.optional(), activityId: ID.optional(), activityOrder: z.enum(['asc', 'desc']).default('asc'), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export const nativeTasks = () => projectCollection<NativeTask>('nativeTasks');
// T2: each task write also stores `changedAt`, the commit time Firestore assigns. It is never a process clock, so the
// change feed's cursor means the same on every instance. No API response, activity copy or receipt has it.
const CHANGED_AT = 'changedAt';
function withoutChangedAt(task: NativeTask): NativeTask {
  const { [CHANGED_AT]: _changedAt, ...rest } = task as NativeTask & { [CHANGED_AT]?: unknown };
  return rest;
}
const comments = (taskId: string) => projectCollection<NativeTaskComment>(`nativeTasks/${taskId}/comments`);
const activity = (taskId: string) => projectCollection<NativeTaskActivity>(`nativeTasks/${taskId}/activity`);
const receipts = () => projectCollection<{ actor: NativeTaskActor; fingerprint: string; result: NativeTaskMutationResult }>('nativeTaskReceipts');
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Refusal('bad_input', 'Check task fields, IDs, revision and request ID.');
  return result.data;
};
const actorRef = (actor: ProgressActor): NativeTaskActor => ({ kind: actor.kind, id: actor.kind === 'person' ? actor.person.id : actor.agent.id });
const sameActor = (a: NativeTaskActor, b: NativeTaskActor) => a.kind === b.kind && a.id === b.id;
async function authorize(tx: Transaction, actor: ProgressActor, now: () => number): Promise<ProjectRole> {
  if (actor.kind === 'person') return assertMembership(tx, actor.person.id);
  const role = await assertRunInTransaction(tx, actor.agent.id, actor.runId, now);
  const current = (await tx.get(agents().doc(actor.agent.id))).data();
  if (!current || current.tokenHash !== actor.agent.tokenHash || current.ownerProfileId !== actor.agent.ownerProfileId)
    throw new Refusal('unauthorized', 'This agent connection changed. Reconnect before continuing.');
  return role;
}
async function assignmentTarget(tx: Transaction, id: string) {
  try { await assertAgentMembership(tx, id); } catch (error) {
    if (error instanceof Refusal && error.code === 'unauthorized') throw new Refusal('bad_input', 'Assign a connected agent belonging to a current project member.');
    throw error;
  }
  const target = (await tx.get(agents().doc(id))).data()!;
  if (target.tokenIssuedAt === null) throw new Refusal('bad_input', 'Assign a connected project agent.');
  return target;
}
// People message only their own agents (VISION, “Each person steers their own agents”): a person's task message goes to
// their connected agents in this project, at most as many as one agent message may name.
async function ownAgentIds(tx: Transaction, personId: string): Promise<string[]> {
  const epoch = await currentConnectionEpoch(tx, personId);
  const rows = await tx.get(agents().where('ownerProfileId', '==', personId).where('revokedAt', '==', null)
    .where('connectionEpoch', '==', epoch).limit(V2_LIMITS.recipientsMax));
  return rows.docs.filter(row => row.data().tokenIssuedAt !== null).map(row => row.id);
}
// The same inbox limit as an agent message: a full inbox refuses the whole change, so nothing is saved.
function assertInboxRoom(targets: Target[]) {
  for (const target of targets) if (backlog(target.inbox) >= V2_LIMITS.backlogMax)
    throw new Refusal('recipient_backlog', `Agent ${target.agentId} has ${backlog(target.inbox)} messages it hasn’t handled yet, so it can’t take more right now. Nothing was saved. Try again later, or leave out the message.`, 60);
}
async function mayControl(tx: Transaction, actor: ProgressActor, task: NativeTask, role: ProjectRole) {
  if (actor.kind === 'agent') {
    if (actor.agent.id === task.assignedAgentId) return;
    throw new Refusal('forbidden', 'Agents can control only their own task. Claim unassigned work for yourself.');
  }
  if (role === 'owner') return;
  if (!task.assignedAgentId) throw new Refusal('forbidden', 'An agent must claim this task, or an owner/admin can assign it.');
  const assigned = (await tx.get(agents().doc(task.assignedAgentId))).data();
  if (actor.kind === 'person' && assigned?.ownerProfileId === actor.person.id) return;
  throw new Refusal('forbidden', 'Only the assigned agent, its person or a project owner/admin can change responsibility or status.');
}
async function taskPermissions(tx: Transaction, actor: ProgressActor, task: NativeTask, role: ProjectRole): Promise<NativeTaskPermissions> {
  const record = (await tx.get(projects.doc(currentProjectId()))).data();
  const runtime = runtimeOf(record);
  const edit = (await effectiveNativeTaskSettings(tx)).enabled && record?.execution.completedAt == null
    && (actor.kind !== 'agent' || !!runtime?.started && !runtime.paused);
  const assigned = task.assignedAgentId ? (await tx.get(agents().doc(task.assignedAgentId))).data() : null;
  const control = edit && (actor.kind === 'agent' ? task.assignedAgentId === actor.agent.id
    : role === 'owner' || !!assigned && assigned.ownerProfileId === actor.person.id);
  const assign = !edit || task.status === 'canceled' || actor.kind === 'agent' ? 'none' : control ? 'any' : !task.assignedAgentId ? 'own' : 'none';
  // A proposed subtask waits for an owner's yes: no one can claim, assign or start it before that.
  const proposed = task.proposed === true;
  return { edit, editDescription: edit && (task.status !== 'done' || control), control: control && !proposed, assign: proposed ? 'none' : assign,
    review: edit && proposed && actor.kind === 'person' && role === 'owner' };
}
// Leave headroom below the approved-computer client's 256 KiB cap. Pages are bounded by bytes as well as row count.
const PAGE_BYTES = 160 * 1024;
const TASK_BYTES = 96 * 1024;
function bytePage<T>(rows: T[], budget: number): T[] {
  const page: T[] = []; let bytes = 0;
  for (const row of rows) { const size = Buffer.byteLength(JSON.stringify(row)) + 1; if (bytes + size > budget) break; page.push(row); bytes += size; }
  if (rows.length && !page.length) throw new Refusal('bad_input', 'This record exceeds the readable task size limit.');
  return page;
}
async function visibleReference(tx: Transaction, reference: NativeTaskReference): Promise<boolean> {
  if (!('sourceId' in reference)) return true;
  // This index contains only shared project Conversations, never private human chats or native logs.
  const row = (await tx.get(conversationEntries().doc(reference.sourceId))).data();
  return row !== undefined && (reference.kind !== 'conversation' || row.threadId === reference.sourceId);
}
async function visibleTask(tx: Transaction, stored: NativeTask): Promise<NativeTask> {
  const task = withoutChangedAt(stored);
  const permitted = await Promise.all(task.references.map(reference => visibleReference(tx, reference)));
  const references = task.references.filter((_, index) => permitted[index]);
  return { ...task, contributors: task.contributors.filter(contributor => contributor.kind === 'agent'), references, ...(task.referenceAuthors ? { referenceAuthors: Object.fromEntries(references.filter(ref => task.referenceAuthors?.[ref.id]).map(ref => [ref.id, task.referenceAuthors![ref.id]])) } : {}) };
}

// Both readers use the same authorization, filters, ordering and cursors. Bound bytes
// after shaping entries, so long descriptions do not shrink compact discovery pages.
async function readNativeTaskPage<T extends { id: string }>(actor: ProgressActor, query: unknown, now: () => number,
  shape: (tx: Transaction, task: NativeTask) => Promise<T>, fields?: readonly string[]): Promise<{ tasks: T[]; nextCursor: string | null }> {
  const input = parse(NATIVE_TASK_QUERY, query);
  return db.runTransaction(async tx => {
    await authorize(tx, actor, now);
    // Title search follows the existing bounded message-search pattern: sparse
    // matches may return an empty page with a cursor, never an unbounded refill.
    const scanLimit = input.search ? 200 : input.limit;
    let q = nativeTasks().orderBy(FieldPath.documentId()).limit(scanLimit + 1);
    if (input.status) q = q.where('status', '==', input.status);
    if (input.unassigned) q = q.where('assignedAgentId', '==', null);
    else if (input.assignedAgentId) q = q.where('assignedAgentId', '==', input.assignedAgentId);
    if (input.parentId) q = q.where('parentId', '==', input.parentId);
    if (input.cursor) q = q.startAfter(input.cursor);
    // A projection reads only the fields its shape uses, not each task's description and references.
    // The shape reads only the selected fields, so the narrowed row type is safe here.
    if (fields) q = q.select(...fields) as typeof q;
    const rows = await tx.get(q), tasks: T[] = [];
    let bytes = 0, consumed = 0, last: string | null = null;
    for (const row of rows.docs.slice(0, scanLimit)) {
      const task = row.data();
      if (input.search && !nativeTaskTitleMatches(task.title, input.search)) {
        consumed++; last = row.id; continue;
      }
      const entry = await shape(tx, task), size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes + size > PAGE_BYTES) {
        if (!tasks.length) throw new Refusal('bad_input', 'This record exceeds the readable task size limit.');
        break; // Retry this matching record on the next page; do not consume it.
      }
      tasks.push(entry); bytes += size; consumed++; last = row.id;
      if (tasks.length === input.limit) break;
    }
    return { tasks, nextCursor: rows.size > consumed ? last : null };
  });
}
export function listNativeTasks(actor: ProgressActor, query: unknown = {}, now: () => number = Date.now): Promise<NativeTaskPage> {
  return readNativeTaskPage(actor, query, now, async (tx, task) => ({
    ...await visibleTask(tx, task), subtaskProgress: await subtaskProgressOf(tx, task.id),
  }));
}

// Attribution stays internal to the MCP adapter; descriptions and references never
// enter compact pages, avoiding per-reference visibility reads.
type AuthoredTaskSummary = NativeTaskSummary & Pick<NativeTask, 'titleAuthor' | 'createdBy'>;
const SUMMARY_FIELDS = ['id', 'title', 'status', 'assignedAgentId', 'priority', 'revision', 'parentId', 'proposed', 'titleAuthor', 'createdBy'] as const;
const subtaskFields = (task: Pick<NativeTask, 'parentId' | 'proposed'>) => ({ ...(task.parentId ? { parentId: task.parentId } : {}), ...(task.proposed ? { proposed: true } : {}) });
export function listNativeTaskSummaries(actor: ProgressActor, query: unknown = {}, now: () => number = Date.now) {
  return readNativeTaskPage<AuthoredTaskSummary>(actor, query, now, async (tx, task) => ({
    id: task.id, title: task.title, status: task.status, assignedAgentId: task.assignedAgentId,
    priority: task.priority, revision: task.revision, ...subtaskFields(task), titleAuthor: task.titleAuthor, createdBy: task.createdBy,
    subtaskProgress: await subtaskProgressOf(tx, task.id),
  }), SUMMARY_FIELDS);
}

// T2 change feed. A client takes a cursor first (no `since`), lists tasks as today, then polls with the cursor and
// receives the tasks written since it, oldest first. The cursor is a Firestore time, never a process clock, so it
// means the same on every instance. On the emulator a stored stamp can precede the moment the write becomes visible,
// so a write can be invisible to a read whose time is after its stamp; in production the stamp may equal the commit
// time (gap possibly zero, unmeasured). Each poll therefore re-reads FEED_OVERLAP_MS before the cursor as a margin: a
// task can arrive more than once, and the client keeps the higher revision.
// Loss condition: a write that becomes visible more than FEED_OVERLAP_MS after its stamp is missed, and nothing in the
// response signals it. No cloud bound is proved, so this is a bounded-lookback hint, not an event log or a replacement
// for list refreshes: views re-list periodically and actions read the task itself (its revision is authoritative).
// It coalesces current state: a task changed several times between polls appears once, at its latest revision.
// Paging keeps the read time of the drain's first page as the floor (`floor~lastAt~taskId`), so a write that lands
// behind a later page is caught by the next poll. There is no upper fence: under sustained writes a drain can keep
// finding newer rows. Unfiltered on purpose: a filtered feed cannot tell a client that a task left its filter. Tasks
// are never deleted. Tasks last written before this field existed appear only after their next write.
// Locally (emulator) stamps trailed visibility by at most ≈17 ms; the cloud gap is unmeasured. A drain reads about
// 4 per page (3 for a person's authorization) + the distinct tasks written in (poll interval + overlap) + one
// conversation entry per conversation/message link on those tasks, so this margin is traded against reads.
// The stamp stays out of API responses but is included in the person's own data export.
// The single-field index on changedAt serves every feed query; no composite index is needed.
export const FEED_OVERLAP_MS = 10_000;
const FEED_TIME = /^(\d{1,12})\.(\d{9})$/;
// Firestore Timestamps end at 9999-12-31T23:59:59Z; a later cursor time is refused as bad input, before authorization.
const FEED_MAX_SECONDS = 253_402_300_799;
const feedTimeInRange = (since: string) => since.split('~').filter(part => FEED_TIME.test(part))
  .every(part => Number(part.split('.')[0]) <= FEED_MAX_SECONDS);
export const NATIVE_TASK_CHANGES_QUERY = z.object({
  since: z.string().regex(/^\d{1,12}\.\d{9}(?:~\d{1,12}\.\d{9}~[A-Za-z0-9_-]{1,200})?$/).refine(feedTimeInRange).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export type NativeTaskChanges<T> = { tasks: T[]; cursor: string; more: boolean };
const feedTime = (time: Timestamp) => `${time.seconds}.${String(time.nanoseconds).padStart(9, '0')}`;
const parseFeedTime = (text: string) => { const [, s, n] = FEED_TIME.exec(text)!; return new Timestamp(Number(s), Number(n)); };
async function readNativeTaskChanges<T extends { id: string }>(actor: ProgressActor, query: unknown, now: () => number,
  shape: (tx: Transaction, task: NativeTask) => Promise<T>, fields?: readonly string[]): Promise<NativeTaskChanges<T>> {
  const input = parse(NATIVE_TASK_CHANGES_QUERY, query);
  return db.runTransaction(async tx => {
    await authorize(tx, actor, now);
    if (!input.since) {
      // One index entry read; its read time is the starting cursor.
      const probe = await tx.get(nativeTasks().orderBy(CHANGED_AT, 'desc').limit(1).select());
      return { tasks: [], cursor: feedTime(probe.readTime), more: false };
    }
    const [floorText, lastAt, lastId] = input.since.split('~');
    let q = nativeTasks().orderBy(CHANGED_AT).orderBy(FieldPath.documentId()).limit(input.limit + 1);
    q = lastId ? q.startAfter(parseFeedTime(lastAt), lastId)
      : q.where(CHANGED_AT, '>', Timestamp.fromMillis(parseFeedTime(floorText).toMillis() - FEED_OVERLAP_MS));
    if (fields) q = q.select(...fields, CHANGED_AT) as typeof q;
    const rows = await tx.get(q), tasks: T[] = [];
    let bytes = 0, last: { at: Timestamp; id: string } | null = null;
    for (const row of rows.docs.slice(0, input.limit)) {
      const entry = await shape(tx, row.data()), size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes + size > PAGE_BYTES) {
        if (!tasks.length) throw new Refusal('bad_input', 'This record exceeds the readable task size limit.');
        break;
      }
      tasks.push(entry); bytes += size; last = { at: row.get(CHANGED_AT) as Timestamp, id: row.id };
    }
    const more = rows.size > tasks.length;
    // The floor is the first page's read time; a partial answer continues after its last row.
    const floor = lastId ? floorText : feedTime(rows.readTime);
    return { tasks, cursor: more && last ? `${floor}~${feedTime(last.at)}~${last.id}` : floor, more };
  }, { readOnly: true });
}
export function listNativeTaskChanges(actor: ProgressActor, query: unknown = {}, now: () => number = Date.now) {
  return readNativeTaskChanges(actor, query, now, visibleTask);
}
export function listNativeTaskSummaryChanges(actor: ProgressActor, query: unknown = {}, now: () => number = Date.now) {
  return readNativeTaskChanges<NativeTaskSummary>(actor, query, now, async (_tx, task) => ({
    id: task.id, title: task.title, status: task.status, assignedAgentId: task.assignedAgentId, priority: task.priority, revision: task.revision, ...subtaskFields(task),
  }), ['id', 'title', 'status', 'assignedAgentId', 'priority', 'revision', 'parentId', 'proposed']);
}

// People may nest without a fixed limit; this bounds the parent walk against corrupt cycles.
const MAX_TASK_DEPTH = 50;
const SUBTASK_LIMIT = 100;
async function subtaskProgressOf(tx: Transaction, taskId: string) {
  // No list filters or child-page limit: a ring describes all direct accepted children.
  // Project only these two fields, keeping descriptions and references out of count reads.
  const children = await tx.get(nativeTasks().where('parentId', '==', taskId).select('status', 'proposed'));
  let done = 0, total = 0;
  for (const row of children.docs) {
    const child = row.data() as Pick<NativeTask, 'status' | 'proposed'>;
    if (child.proposed) continue;
    total++;
    if (closedTask(child)) done++;
  }
  return { done, total };
}
async function ancestorsOf(tx: Transaction, task: Pick<NativeTask, 'parentId'>): Promise<NativeTask[]> {
  const chain: NativeTask[] = [];
  for (let id = task.parentId; id; ) {
    if (chain.length >= MAX_TASK_DEPTH || chain.some(row => row.id === id)) throw new Refusal('bad_input', 'This task is nested too deeply.');
    const parent = (await tx.get(nativeTasks().doc(id))).data();
    if (!parent) break;
    chain.unshift(parent); id = parent.parentId;
  }
  return chain;
}
async function subtasksOf(tx: Transaction, taskId: string): Promise<NativeTask[]> {
  const rows = await tx.get(nativeTasks().where('parentId', '==', taskId).orderBy('createdAt').orderBy(FieldPath.documentId()).limit(SUBTASK_LIMIT));
  return rows.docs.map(row => row.data());
}
const summaryOf = (task: NativeTask): NativeTaskSummary => ({ id: task.id, title: task.title, status: task.status, assignedAgentId: task.assignedAgentId, priority: task.priority, revision: task.revision, ...subtaskFields(task) });

export async function getNativeTask(actor: ProgressActor, taskId: string, query: unknown = {}, now: () => number = Date.now): Promise<NativeTaskDetail> {
  parse(ID, taskId); const input = parse(NATIVE_TASK_DETAIL_QUERY, query);
  return db.runTransaction(async tx => {
    const role = await authorize(tx, actor, now);
    const task = (await tx.get(nativeTasks().doc(taskId))).data();
    if (!task) throw new Refusal('not_found', 'This task is unavailable in this project.');
    const permissions = await taskPermissions(tx, actor, task, role);
    if (input.activityId) {
      const event = (await tx.get(activity(taskId).doc(input.activityId))).data();
      if (!event) throw new Refusal('not_found', 'This saved task version is unavailable.');
      return { task: await visibleTask(tx, task), permissions, comments: [], activity: [{ ...event, ...(event.task ? { task: await visibleTask(tx, event.task) } : {}) }], nextCommentCursor: null, nextActivityCursor: null };
    }
    let cq = comments(taskId).orderBy('createdAt', 'desc').limit(input.limit + 1);
    let aq = activity(taskId).orderBy('revision', input.activityOrder).limit(input.limit + 1);
    if (input.commentCursor) {
      const after = await tx.get(comments(taskId).doc(input.commentCursor));
      if (!after.exists) throw new Refusal('bad_input', 'Use this task comments’ returned cursor.');
      cq = cq.startAfter(after);
    }
    if (input.activityCursor) {
      const after = await tx.get(activity(taskId).doc(input.activityCursor));
      if (!after.exists) throw new Refusal('bad_input', 'Use this task history’s returned cursor.');
      aq = aq.startAfter(after);
    }
    const [cr, ar, chain, children, progress] = await Promise.all([tx.get(cq), tx.get(aq), ancestorsOf(tx, task), subtasksOf(tx, taskId), subtaskProgressOf(tx, taskId)]);
    const ancestors: NativeTaskAncestor[] = chain.map(row => ({ id: row.id, title: row.title }));
    const commentPage = bytePage(cr.docs.slice(0, input.limit).map(row => row.data()), 40 * 1024);
    const events = bytePage(ar.docs.slice(0, input.limit).map(row => { const { task: _task, comment: _comment, ...event } = row.data(); return event; }), 24 * 1024);
    return { task: { ...await visibleTask(tx, task), subtaskProgress: progress }, permissions, comments: [...commentPage].reverse(), activity: events,
      nextCommentCursor: cr.size > commentPage.length ? commentPage.at(-1)!.id : null, nextActivityCursor: ar.size > events.length ? events.at(-1)!.id : null,
      ancestors, subtasks: children.map(summaryOf) };
  });
}

export async function mutateNativeTask(actor: ProgressActor, value: unknown, now: () => number = Date.now): Promise<NativeTaskMutationResult> {
  const input = parse(NATIVE_TASK_MUTATION, value), author = actorRef(actor);
  const key = createHash('sha256').update(JSON.stringify([author, input.clientRequestId])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db.runTransaction(async tx => {
    const role = await authorize(tx, actor, now);
    if (actor.kind === 'agent' && input.operation === 'assign')
      throw new Refusal('forbidden', 'Agents create unassigned tasks, claim for themselves and release only their own tasks.');
    // Only people's new tasks carry a message; agents talk with send_message.
    const message = input.operation === 'create' || input.operation === 'assign' ? input.message : undefined;
    if (actor.kind === 'agent' && message !== undefined) throw new Refusal('forbidden', 'Agents send messages with send_message, not with tasks.');
    await assertNativeTasksEnabled(tx);
    const receipt = (await tx.get(receipts().doc(key))).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was used with different task details. Use a new ID.');
      return { ...receipt.result, task: await visibleTask(tx, receipt.result.task), replayed: true };
    }
    if (actor.kind === 'agent') await assertNewProgressAction(tx, actor);
    else await assertProjectWritable(tx);
    const at = now();
    let task: NativeTask, before: NativeTask | undefined, comment: NativeTaskComment | undefined, notice: Target[] = [];
    let closedParent: NativeTask | undefined, closedNotice: Target[] = [], created: Target[] = [];
    // The person's message as Conversations shows it: who it reached and which task it is about.
    let shown: { id: string; to: string[]; agentName: string } | undefined;
    if (input.operation === 'create') {
      let parentId: string | undefined;
      if (input.parentId) {
        const parent = (await tx.get(nativeTasks().doc(input.parentId))).data();
        if (!parent) throw new Refusal('not_found', 'This parent task is unavailable in this project.');
        if (parent.proposed) throw new Refusal('bad_input', 'Wait for an owner to accept the proposed parent task before adding subtasks to it.');
        const chain = [...await ancestorsOf(tx, parent), parent];
        // Agents nest two levels (a task and its subtasks): a deeper agent request is attached under the deepest allowed level.
        parentId = actor.kind === 'agent' && chain.length >= AGENT_TASK_DEPTH ? chain[AGENT_TASK_DEPTH - 2]!.id : parent.id;
      }
      task = { id: `task_${key}`, projectId: currentProjectId(), title: input.title, description: input.description ?? '', status: 'backlog', assignedAgentId: null,
        contributors: [], priority: input.priority ?? 'normal', references: [], createdBy: author, titleAuthor: author, descriptionAuthor: author, referenceAuthors: {}, createdAt: at, updatedAt: at, revision: 1,
        // An agent's subtask is a proposal until an owner accepts it.
        ...(parentId ? { parentId, ...(actor.kind === 'agent' ? { proposed: true } : {}) } : {}) };
      // A person's message about a new task reaches their own agents in the same commit, and stays as its first comment.
      if (message !== undefined && actor.kind === 'person') {
        created = await readTargets(tx, await ownAgentIds(tx, actor.person.id), `task-created-${task.id}`);
        assertInboxRoom(created);
        if (created.length) shown = { id: `task-created-${task.id}`, to: created.map(target => target.agentId),
          agentName: (await tx.get(agents().doc(created[0]!.agentId))).data()!.name };
        comment = { id: `comment_${String(task.revision).padStart(16, '0')}_${key}`, taskId: task.id, author, body: message, createdAt: at, updatedAt: at };
      }
    } else {
      const stored = (await tx.get(nativeTasks().doc(input.taskId))).data();
      if (!stored) throw new Refusal('not_found', 'This task is unavailable in this project.');
      const saved = withoutChangedAt(stored);
      if (saved.revision !== input.expectedRevision) throw new Refusal('intent_conflict', `Task changed (current revision ${saved.revision}). Reload it before saving.`);
      before = saved;
      task = { ...saved, updatedAt: at, revision: saved.revision + 1 };
      if (saved.proposed && (input.operation === 'claim' || input.operation === 'assign' || input.operation === 'release'
        || (input.operation === 'update' && input.status !== undefined && input.status !== 'backlog')))
        throw new Refusal('bad_input', 'This subtask is a proposal. An owner must accept it before anyone takes or starts it.');
      if (input.operation === 'review_proposal') {
        if (actor.kind !== 'person' || role !== 'owner') throw new Refusal('forbidden', 'Only a project owner can accept or decline a proposed subtask.');
        if (!saved.proposed) throw new Refusal('intent_conflict', 'This subtask is no longer a proposal. Reload the task.');
        delete task.proposed;
        if (!input.accept) task.status = 'canceled';
      } else if (input.operation === 'claim') {
        if (actor.kind !== 'agent') throw new Refusal('forbidden', 'Only a working agent can claim for itself.');
        if (task.assignedAgentId !== null || task.status !== 'backlog') throw new Refusal('intent_conflict', 'Only an unassigned Backlog task can be claimed. Reload the task.');
        await assignmentTarget(tx, actor.agent.id);
        task.assignedAgentId = actor.agent.id; task.status = 'in_progress';
      } else if (input.operation === 'release') {
        if (task.status === 'canceled') throw new Refusal('bad_input', 'Reopen the canceled task to Backlog before changing assignment.');
        await mayControl(tx, actor, task, role); task.assignedAgentId = null; task.status = 'backlog';
      } else if (input.operation === 'assign') {
        if (task.status === 'canceled') throw new Refusal('bad_input', 'Reopen the canceled task to Backlog before changing assignment.');
        const target = await assignmentTarget(tx, input.assignedAgentId);
        if (task.assignedAgentId) await mayControl(tx, actor, task, role);
        else if (role !== 'owner' && !(actor.kind === 'person' && actor.person.id === target.ownerProfileId))
          throw new Refusal('forbidden', 'Only the agent’s person or an owner/admin can assign unclaimed work.');
        if (message !== undefined && !(actor.kind === 'person' && actor.person.id === target.ownerProfileId))
          throw new Refusal('forbidden', 'People message only their own agents. Assign this agent without a message.');
        if (task.assignedAgentId !== input.assignedAgentId) {
          task.status = 'backlog';
          // A person's assignment reaches the agent's inbox; it does not start or extend the agent.
          if (actor.kind === 'person') notice = await readTargets(tx, [input.assignedAgentId], `task-assigned-${task.id}-${task.revision}`);
          if (message !== undefined) {
            assertInboxRoom(notice);
            shown = { id: `task-assigned-${task.id}-${task.revision}`, to: [input.assignedAgentId], agentName: target.name };
            comment = { id: `comment_${String(task.revision).padStart(16, '0')}_${key}`, taskId: task.id, author, body: message, createdAt: at, updatedAt: at };
          }
        }
        task.assignedAgentId = input.assignedAgentId;
      } else if (input.operation === 'update') {
        if (input.status !== undefined && input.status !== task.status) {
          await mayControl(tx, actor, task, role);
          if (task.status === 'canceled' && input.status !== 'backlog') throw new Refusal('bad_input', 'Reopen the canceled task to Backlog before starting or completing it.');
          if (input.status !== 'backlog' && input.status !== 'canceled' && !task.assignedAgentId) throw new Refusal('bad_input', 'Assign an agent before moving a task out of Backlog.');
          if (input.status !== 'backlog' && input.status !== 'canceled' && task.assignedAgentId) await assignmentTarget(tx, task.assignedAgentId);
          task.status = input.status;
        }
        if (input.title !== undefined) { task.title = input.title; task.titleAuthor = author; }
        if (input.description !== undefined) { task.description = input.description; task.descriptionAuthor = author; }
        if (saved.status === 'done' && input.status !== 'canceled' && input.description !== undefined && input.description !== saved.description) {
          // The generic control refusal tells agents to claim work, which is impossible for a Done task.
          await mayControl(tx, actor, saved, role).catch(error => {
            if (error instanceof Refusal && error.code === 'forbidden')
              throw new Refusal('forbidden', 'Changing a Done task’s description reopens it, so only its assigned agent, that agent’s person or an owner/admin can do it. Add a comment instead.');
            throw error;
          });
          task.status = 'backlog';
        }
        if (input.priority !== undefined) task.priority = input.priority;
        if (input.contributors) {
          const seen = new Set<string>();
          for (const contributor of input.contributors) {
            const k = `${contributor.kind}:${contributor.id}`;
            if (seen.has(k)) throw new Refusal('bad_input', 'Choose each contributor once.'); seen.add(k);
            await assignmentTarget(tx, contributor.id);
          }
          task.contributors = input.contributors;
        }
      } else if (input.operation === 'comment') {
        comment = { id: `comment_${String(task.revision).padStart(16, '0')}_${key}`, taskId: task.id, author, body: input.body, createdAt: at, updatedAt: at };
      } else if (input.operation === 'edit_comment') {
        const savedComment = (await tx.get(comments(task.id).doc(input.commentId))).data();
        if (!savedComment || !sameActor(savedComment.author, author)) throw new Refusal('forbidden', 'Only the comment author can edit it.');
        comment = { ...savedComment, body: input.body, updatedAt: at };
      } else if (input.operation === 'add_reference') {
        if (task.references.length >= 30) throw new Refusal('bad_input', 'A task supports up to 30 links.');
        if (task.references.some(ref => ref.id === input.reference.id)) throw new Refusal('intent_conflict', 'This link ID is already present.');
        if (!await visibleReference(tx, input.reference)) throw new Refusal('not_found', 'This source is unavailable in this project.');
        task.references = [...task.references, input.reference];
        task.referenceAuthors = { ...task.referenceAuthors, [input.reference.id]: author };
      } else if (input.operation === 'remove_reference') {
        if (!task.references.some(ref => ref.id === input.referenceId)) throw new Refusal('not_found', 'This link is unavailable.');
        task.references = task.references.filter(ref => ref.id !== input.referenceId);
        task.referenceAuthors = { ...task.referenceAuthors }; delete task.referenceAuthors[input.referenceId];
      }
    }
    // When the last open subtask closes, its parent's assigned agent hears once. The parent's own status is never computed.
    if (task.parentId && before && !before.proposed && !closedTask(before) && closedTask(task)) {
      const parent = (await tx.get(nativeTasks().doc(task.parentId))).data();
      if (parent?.assignedAgentId) {
        // The current child is still open in storage. Count every accepted child, independently
        // of the detail page's limit: this change must close the only remaining open child.
        const progress = await subtaskProgressOf(tx, parent.id);
        if (progress.total - progress.done === 1) { closedParent = parent; closedNotice = await readTargets(tx, [parent.assignedAgentId], `task-children-closed-${parent.id}-${task.id}-${task.revision}`); }
      }
    }
    const result: NativeTaskMutationResult = { task, ...(comment ? { comment } : {}), replayed: false };
    if (Buffer.byteLength(JSON.stringify(task)) > TASK_BYTES) throw new Refusal('bad_input', 'This task is too large. Shorten its description or move supporting material to result links.');
    const visibleResult = { ...result, task: await visibleTask(tx, task) };
    // Every read/permission check precedes every write. Receipt, state and audit commit atomically.
    tx.set(nativeTasks().doc(task.id), { ...task, [CHANGED_AT]: FieldValue.serverTimestamp() } as unknown as NativeTask);
    if (comment) tx.set(comments(task.id).doc(comment.id), comment);
    const eventId = `${String(task.revision).padStart(12, '0')}_${key}`;
    const fields = (['title','description','status','assignedAgentId','priority','contributors','references','proposed'] as const).filter(field => !before || JSON.stringify(before[field]) !== JSON.stringify(task[field]));
    tx.create(activity(task.id).doc(eventId), { id: eventId, taskId: task.id, actor: author, action: input.operation, revision: task.revision, at, fields, task, ...(comment ? { comment } : {}) });
    tx.create(receipts().doc(key), { actor: author, fingerprint, result });
    if (shown && message !== undefined && actor.kind === 'person') tx.set(conversationEntries().doc(shown.id), { id: shown.id, threadId: shown.id, kind: 'task',
      agentId: shown.to[0]!, agentName: shown.agentName, actorProfileId: actor.person.id, actorName: actor.person.name, taskId: task.id, taskTitle: task.title,
      body: message, to: shown.to, audience: 'direct', createdAt: at, protocol: 2 } satisfies TaskMessage);
    deliver(tx, notice, { sourceId: `task-assigned-${task.id}-${task.revision}`, kind: 'task_assigned', messageId: null,
      payload: { type: 'task_assigned', taskId: task.id, title: task.title, titleAuthor: task.titleAuthor, assignedBy: author, revision: task.revision, ...(message !== undefined ? { message } : {}) } }, at);
    deliver(tx, created, { sourceId: `task-created-${task.id}`, kind: 'task_created', messageId: null,
      payload: { type: 'task_created', taskId: task.id, title: task.title, titleAuthor: task.titleAuthor, createdBy: author, message, revision: task.revision } }, at);
    if (closedParent) deliver(tx, closedNotice, { sourceId: `task-children-closed-${closedParent.id}-${task.id}-${task.revision}`, kind: 'task_children_closed', messageId: null,
      payload: { type: 'task_children_closed', taskId: closedParent.id, title: closedParent.title, titleAuthor: closedParent.titleAuthor, revision: closedParent.revision } }, at);
    return visibleResult;
  });
}
