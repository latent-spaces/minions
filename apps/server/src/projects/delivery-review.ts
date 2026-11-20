import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalGithubRepo, type DeliveryReviewCandidate, type DeliveryReviewDetail, type DeliveryReviewEvent, type DeliveryReviewMutationResult, type DeliveryReviewObservation, type DeliveryReviewState, type NativeTask, type NativeTaskActor } from '@minions/contracts';
import { Refusal } from '../errors.js';
import { db, FieldPath, projectCollection, projectDoc, type Transaction } from '../firestore.js';
import { agentMembership, assertProjectWritable } from './access.js';
import { authorizeNativeTask } from './native-task-authority.js';
import { assertNativeTasksEnabled } from './native-task-settings.js';
import { assertNewProgressAction, type ProgressActor } from './progress-authority.js';
import { observeDeliveryCandidate, OBSERVATION_TTL_MS, type DeliveryReviewObserver } from './delivery-review-observation.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repository = (value: string | null | undefined) => value
  ? canonicalGithubRepo(value.includes('://') ? value : `https://github.com/${value}`)?.slice('https://github.com/'.length) ?? null
  : null;
const reportedTest = z.object({
  path: z.string().min(1).max(240).refine(value => !/[\\:\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..')),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).transform(value => value.toLowerCase()),
}).strict();
const base = { taskId: id, clientRequestId: id };
const check = z.object({
  name: z.string().trim().min(1).max(150),
  workflowId: number,
  workflowPath: z.string().max(240).regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  workflowBlobSha: sha,
}).strict();
export const DELIVERY_REVIEW_MUTATION = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('configure'), enabled: z.boolean(), expectedGeneration: generation,
    reviewerAgentId: id.nullable().optional(), requiredChecks: z.array(check).max(10).optional(), reason: z.string().trim().min(1).max(1000).optional() }).strict(),
  z.object({ ...base, operation: z.literal('submit'), expectedGeneration: generation,
    repository: z.string().trim().max(300).transform(repository).pipe(z.string()), pullRequest: number, headSha: sha,
    manifest: z.string().trim().min(1).max(3000), reportedTests: z.array(reportedTest).max(20).optional() }).strict(),
  z.object({ ...base, operation: z.literal('verdict'), generation, verdict: z.enum(['approved', 'changes_requested']),
    note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ ...base, operation: z.literal('refresh'), generation }).strict(),
]);
const eventId = z.string().regex(/^\d{16}$/);
const querySchema = z.object({ cursor: eventId.optional(), limit: z.coerce.number().int().min(1).max(20).default(10) }).strict();
type Mutation = z.infer<typeof DELIVERY_REVIEW_MUTATION>;
type Refresh = Extract<Mutation, { operation: 'refresh' }>;
type StoredState = DeliveryReviewState & {
  sequence: number;
  repositoryRevision: number | null;
  refreshRequest?: string | null;
  refreshOrder?: number;
  checkDecisionOrders?: number[];
};
type Receipt = { fingerprint: string; event?: DeliveryReviewEvent; refreshOrder?: number };
const initial: StoredState = { enabled: false, reviewerAgentId: null, requiredChecks: [], generation: 0,
  current: null, verdict: null, observation: null, failedCheckNames: [], repositoryRevision: null, sequence: 0 };
const reviews = () => projectCollection<StoredState>('nativeTaskDeliveryReviews');
const events = (taskId: string) => projectCollection<DeliveryReviewEvent>(`nativeTaskDeliveryReviews/${taskId}/events`);
const receipts = () => projectCollection<Receipt>('nativeTaskDeliveryReviewReceipts');
const tasks = () => projectCollection<NativeTask>('nativeTasks');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authorOf = (actor: ProgressActor): NativeTaskActor => ({ kind: actor.kind, id: actor.kind === 'person' ? actor.person.id : actor.agent.id });
const eventMeta = (state: StoredState, at: number) => ({ id: String(state.sequence + 1).padStart(16, '0'), generation: state.generation, at });
const nextGeneration = (state: StoredState): StoredState => ({ ...state, generation: state.generation + 1,
  current: null, verdict: null, observation: null, refreshRequest: null, repositoryRevision: null,
  refreshOrder: 0, checkDecisionOrders: [] });

let observer: DeliveryReviewObserver | undefined;
const inFlightRefreshes = new Map<string, { callers: number; observation?: Promise<DeliveryReviewObservation> }>();
// Wired by the engine host. The request surface accepts only generation and request ID.
export function setDeliveryReviewObserver(provider: DeliveryReviewObserver) { observer = provider; }

async function repositoryBinding(tx: Transaction) {
  const setup = (await tx.get(projectDoc())).data()?.setup;
  return { name: repository(setup?.repoUrl), revision: setup?.repositoryRevision ?? 0 };
}

async function visibleState(tx: Transaction, state: StoredState, now: () => number): Promise<DeliveryReviewState> {
  const { sequence: _sequence, refreshRequest: _refreshRequest, refreshOrder: _refreshOrder,
    checkDecisionOrders: _checkDecisionOrders, repositoryRevision, ...review } = state;
  if (review.current) {
    const binding = await repositoryBinding(tx);
    if (binding.name !== review.current.repository || binding.revision !== repositoryRevision)
      return { ...review, current: null, verdict: null, observation: null };
  }
  if (review.observation && review.observation.status !== 'stale' && now() - review.observation.observedAt >= OBSERVATION_TTL_MS)
    return { ...review, observation: null };
  return review;
}

export async function readDeliveryReviewState(tx: Transaction, taskId: string, now: () => number) {
  const state = (await tx.get(reviews().doc(taskId))).data();
  return state && visibleState(tx, state, now);
}

async function readTask(tx: Transaction, taskId: string) {
  const task = (await tx.get(tasks().doc(taskId))).data();
  if (!task) throw new Refusal('not_found', 'This task is unavailable in this project.');
  return task;
}

export async function getDeliveryReview(actor: ProgressActor, taskId: string, query: unknown = {}, now: () => number = Date.now): Promise<DeliveryReviewDetail> {
  const parsed = querySchema.safeParse(query);
  if (!id.safeParse(taskId).success || !parsed.success) throw new Refusal('bad_input', 'Use a task ID and its returned review cursor.');
  const { cursor, limit } = parsed.data;
  return db.runTransaction(async tx => {
    await authorizeNativeTask(tx, actor, now);
    await readTask(tx, taskId);
    let page = events(taskId).orderBy(FieldPath.documentId(), 'desc').limit(limit + 1);
    if (cursor) {
      if (!(await tx.get(events(taskId).doc(cursor))).exists) throw new Refusal('bad_input', 'Use this task’s returned review cursor.');
      page = page.startAfter(cursor);
    }
    const [state, rows] = await Promise.all([tx.get(reviews().doc(taskId)), tx.get(page)]);
    const history: DeliveryReviewEvent[] = [];
    let bytes = 0;
    for (const row of rows.docs.slice(0, limit)) {
      const event = row.data();
      bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
      if (history.length && bytes > 48 * 1024) break;
      history.push(event);
    }
    return { ...await visibleState(tx, state.data() ?? initial, now), events: history,
      nextCursor: rows.size > history.length ? history.at(-1)!.id : null };
  });
}

function saveEvent(tx: Transaction, taskId: string, state: StoredState, event: DeliveryReviewEvent) {
  tx.set(reviews().doc(taskId), { ...state, sequence: state.sequence + 1 });
  tx.create(events(taskId).doc(event.id), event);
}

export async function invalidateDeliveryReview(tx: Transaction, before: NativeTask, after: NativeTask, actor: NativeTaskActor, at: number) {
  const reason = before.description !== after.description ? 'task_requirements_changed'
    : before.assignedAgentId !== after.assignedAgentId ? 'task_assignment_changed' : null;
  if (!reason) return;
  const previous = (await tx.get(reviews().doc(after.id))).data();
  if (!previous?.enabled) return;
  const state = nextGeneration(previous);
  saveEvent(tx, after.id, state, { ...eventMeta(state, at), kind: 'invalidated', actor, reason });
}

async function assertWritable(tx: Transaction, actor: ProgressActor, task: NativeTask) {
  if (actor.kind === 'agent') await assertNewProgressAction(tx, actor);
  else await assertProjectWritable(tx);
  if (task.proposed || task.status === 'canceled')
    throw new Refusal('forbidden', 'Delivery review requires an accepted, non-canceled task.');
}

async function assertRepository(tx: Transaction, expected: string, revision?: number | null) {
  const binding = await repositoryBinding(tx);
  if (binding.name !== expected || (revision !== undefined && binding.revision !== revision))
    throw new Refusal('forbidden', 'The delivery pull request must belong to this project’s current GitHub repository.');
  return binding.revision;
}

function assertCurrent(state: StoredState, requestedGeneration: number): DeliveryReviewCandidate {
  if (!state.enabled || !state.current || state.generation !== requestedGeneration || state.observation?.status === 'stale')
    throw new Refusal('intent_conflict', 'The delivery candidate changed. Read the review and use its current generation.');
  return state.current;
}

function receiptOf(actor: ProgressActor, input: Mutation) {
  const fingerprint = hash(input);
  const ref = receipts().doc(hash([authorOf(actor), input.clientRequestId]));
  return {
    id: ref.id,
    path: ref.path,
    async read(tx: Transaction): Promise<Receipt | undefined> {
      const saved = (await tx.get(ref)).data();
      if (saved && saved.fingerprint !== fingerprint)
        throw new Refusal('intent_conflict', 'This request ID already has a different delivery review operation.');
      return saved;
    },
    reserve(tx: Transaction, refreshOrder: number) { tx.set(ref, { fingerprint, refreshOrder }); },
    commit(tx: Transaction, state: StoredState, event: DeliveryReviewEvent): DeliveryReviewMutationResult {
      saveEvent(tx, input.taskId, state, event);
      tx.set(ref, { fingerprint, event });
      return { event, replayed: false };
    },
  };
}

function reconcileObservation(state: StoredState, order: number, observation: DeliveryReviewObservation): StoredState {
  const failed = new Set(state.failedCheckNames);
  const checkDecisionOrders = state.requiredChecks.map((pin, index) => {
    // A newer inconclusive result does not supersede a conclusive result for this pin.
    const previousOrder = state.checkDecisionOrders?.[index] ?? -1;
    if (order <= previousOrder) return previousOrder;
    const status = observation.checks.find(check => check.name === pin.name)?.status;
    if (status === 'failed') failed.add(pin.name);
    else if (status === 'verified') failed.delete(pin.name);
    else return previousOrder;
    return order;
  });
  const latest = order === (state.refreshOrder ?? 0);
  // A confirmed closed or moved PR invalidates this generation until another submission.
  const currentObservation = state.observation?.status === 'stale' || (!latest && observation.status !== 'stale')
    ? state.observation : observation;
  return { ...state, checkDecisionOrders, failedCheckNames: [...failed], observation: currentObservation,
    ...(latest ? { refreshRequest: null } : {}) };
}

async function refresh(actor: ProgressActor, input: Refresh, now: () => number): Promise<DeliveryReviewMutationResult> {
  const receipt = receiptOf(actor, input);
  const prepare = async (tx: Transaction) => {
    await authorizeNativeTask(tx, actor, now);
    await assertNativeTasksEnabled(tx);
    const task = await readTask(tx, input.taskId);
    const saved = await receipt.read(tx);
    if (saved?.event) return { event: saved.event };
    await assertWritable(tx, actor, task);
    return { state: (await tx.get(reviews().doc(task.id))).data() ?? initial, saved };
  };
  // Retain the shared provider result until every caller finishes its own authorization and commit.
  let active = inFlightRefreshes.get(receipt.path);
  if (!active) {
    active = { callers: 0 };
    inFlightRefreshes.set(receipt.path, active);
  }
  active.callers++;
  try {
    const prepared = await db.runTransaction(async tx => {
      const loaded = await prepare(tx);
      if (loaded.event) return { event: loaded.event };
      const { state, saved } = loaded;
      const candidate = assertCurrent(state, input.generation);
      await assertRepository(tx, candidate.repository, state.repositoryRevision);
      // Old reservations only recorded the latest ID. Earlier legacy attempts have no known order.
      if (saved) return { state, candidate, order: saved.refreshOrder ?? (state.refreshRequest === receipt.id ? 0 : null) };
      const order = (state.refreshOrder ?? 0) + 1;
      receipt.reserve(tx, order);
      tx.set(reviews().doc(input.taskId), { ...state, refreshOrder: order, refreshRequest: null });
      return { state, candidate, order };
    });
    if (prepared.event) return { event: prepared.event, replayed: true };
    const { state, candidate, order } = prepared;
    const observation = await (active.observation ??= observeDeliveryCandidate(observer, candidate, state.requiredChecks, now));
    const at = now();
    return await db.runTransaction(async tx => {
      const current = await prepare(tx);
      if (current.event) return { event: current.event, replayed: true };
      const binding = await repositoryBinding(tx);
      const previous = current.state;
      const applies = order !== null && previous.generation === input.generation
        && binding.name === candidate.repository && binding.revision === state.repositoryRevision;
      const event: DeliveryReviewEvent = { ...eventMeta(previous, at), generation: input.generation, kind: 'observed', observation };
      return receipt.commit(tx, applies ? reconcileObservation(previous, order, observation) : previous, event);
    });
  } finally {
    if (--active.callers === 0) inFlightRefreshes.delete(receipt.path);
  }
}

export async function mutateDeliveryReview(actor: ProgressActor, value: unknown, now: () => number = Date.now): Promise<DeliveryReviewMutationResult> {
  const parsed = DELIVERY_REVIEW_MUTATION.safeParse(value);
  if (!parsed.success) throw new Refusal('bad_input', 'Check the delivery review fields, generation and request ID.');
  const input = parsed.data;
  if (input.operation === 'refresh') return refresh(actor, input, now);
  const receipt = receiptOf(actor, input), author = authorOf(actor);
  return db.runTransaction(async tx => {
    const role = await authorizeNativeTask(tx, actor, now);
    await assertNativeTasksEnabled(tx);
    const task = await readTask(tx, input.taskId);
    const saved = await receipt.read(tx);
    if (saved?.event) return { event: saved.event, replayed: true };
    await assertWritable(tx, actor, task);
    let state = (await tx.get(reviews().doc(task.id))).data() ?? initial;
    if ('expectedGeneration' in input && input.expectedGeneration !== state.generation)
      throw new Refusal('intent_conflict', 'The delivery review changed. Read it before applying this update.');
    const at = now();
    let event: DeliveryReviewEvent;
    if (input.operation === 'configure') {
      if (actor.kind !== 'person' || role !== 'owner') throw new Refusal('forbidden', 'Only the project owner can configure delivery review.');
      const reviewerAgentId = input.reviewerAgentId === undefined ? state.reviewerAgentId : input.reviewerAgentId;
      const requiredChecks = [...(input.requiredChecks ?? state.requiredChecks)].sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
      if (new Set(requiredChecks.map(check => check.name)).size !== requiredChecks.length)
        throw new Refusal('bad_input', 'Each required GitHub check must have a distinct name.');
      if (input.enabled && reviewerAgentId) {
        if (reviewerAgentId === task.assignedAgentId) throw new Refusal('bad_input', 'Choose a reviewer other than the task’s assigned agent.');
        if ((await agentMembership(tx, reviewerAgentId)).agent.tokenIssuedAt === null)
          throw new Refusal('bad_input', 'Choose a connected project agent as reviewer.');
      }
      if (state.enabled === input.enabled && reviewerAgentId === state.reviewerAgentId && hash(requiredChecks) === hash(state.requiredChecks))
        throw new Refusal('intent_conflict', 'The delivery review already has these settings.');
      const unchangedChecks = new Set(requiredChecks.filter(check => state.requiredChecks.some(previous => hash(check) === hash(previous))).map(check => check.name));
      const failedCheckNames = state.failedCheckNames.filter(name => unchangedChecks.has(name));
      if (!input.reason && ((state.failedCheckNames.length > 0 && !input.enabled) || failedCheckNames.length < state.failedCheckNames.length))
        throw new Refusal('bad_input', 'Explain why the review is being disabled or the required check replaced while a failure is unresolved.');
      state = { ...nextGeneration(state), enabled: input.enabled, reviewerAgentId, requiredChecks, failedCheckNames };
      event = { ...eventMeta(state, at), kind: 'configured', actor: author, enabled: state.enabled, reviewerAgentId, requiredChecks,
        ...(input.reason === undefined ? {} : { reason: input.reason }) };
      if (input.enabled) tx.update(projectDoc(), { hasDeliveryReviews: true });
    } else if (input.operation === 'submit') {
      if (!state.enabled) throw new Refusal('forbidden', 'The project owner must enable delivery review for this task.');
      if (actor.kind !== 'agent' || actor.agent.id !== task.assignedAgentId)
        throw new Refusal('forbidden', 'Only the task’s assigned agent can submit a delivery candidate.');
      if (actor.agent.id === state.reviewerAgentId)
        throw new Refusal('forbidden', 'The task’s owner must choose a different reviewer before submission.');
      const repositoryRevision = await assertRepository(tx, input.repository);
      const { reportedTests } = input;
      if (reportedTests && new Set(reportedTests.map(test => test.path)).size !== reportedTests.length)
        throw new Refusal('bad_input', 'Report each test path once.');
      const previous = state.current;
      if (previous && state.repositoryRevision === repositoryRevision && previous.repository === input.repository && previous.pullRequest === input.pullRequest
        && previous.headSha === input.headSha && previous.manifest === input.manifest
        && hash(previous.reportedTests ?? []) === hash(reportedTests ?? []) && state.observation?.status !== 'stale')
        throw new Refusal('intent_conflict', 'This delivery candidate is already current.');
      state = nextGeneration(state);
      const candidate: DeliveryReviewCandidate = { repository: input.repository, pullRequest: input.pullRequest,
        headSha: input.headSha, manifest: input.manifest, generation: state.generation, submittedBy: author, submittedAt: at,
        ...(reportedTests === undefined ? {} : { reportedTests }) };
      state.current = candidate;
      state.repositoryRevision = repositoryRevision;
      event = { ...eventMeta(state, at), kind: 'submitted', candidate };
    } else {
      const candidate = assertCurrent(state, input.generation);
      if (actor.kind !== 'agent' || actor.agent.id === candidate.submittedBy.id || actor.agent.id === task.assignedAgentId
        || (state.reviewerAgentId !== null && actor.agent.id !== state.reviewerAgentId))
        throw new Refusal('forbidden', 'A distinct eligible project agent must review this delivery candidate.');
      await assertRepository(tx, candidate.repository, state.repositoryRevision);
      if (state.verdict) throw new Refusal('intent_conflict', 'This generation already has a peer verdict.');
      const verdict = { verdict: input.verdict, note: input.note, actor: author, at };
      state = { ...state, verdict };
      event = { ...eventMeta(state, at), kind: 'verdict', verdict };
    }
    return receipt.commit(tx, state, event);
  });
}
