// Human operational recovery, separate from worker identity and participant model execution.
import { FieldPath } from '../firestore.js';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { cursorAfter, nextCursor } from '../community/pagination.js';
import { Refusal } from '../errors.js';
import { db, inProject, projectCollection, type Profile, type WithId } from '../firestore.js';
import { assertMembership, validProjectId } from '../projects/access.js';
import { fanoutJobId, fanoutJobs, fanoutProjects, type FanoutJob } from './fanout-jobs.js';
import { fanouts } from './records.js';

export const DELIVERY_QUERY = z.object({ status: z.enum(['pending', 'blocked', 'done']).default('blocked'), cursor: z.string().max(500).optional() }).strict();
export const DELIVERY_RETRY = z.object({
  client_request_id: z.string().regex(/^[\w-]{1,64}$/), expected_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 2),
  reason: z.string().trim().min(10).max(500),
}).strict();
const idString = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const SOURCE = z.object({
  kind: z.enum(['message', 'announcement', 'project_started', 'paused', 'resumed', 'card_changed']),
  payload: z.record(z.string(), z.unknown()), messageId: idString.nullable(), senderId: idString.nullable(),
  createdAt: z.number().int().nonnegative(), audienceBefore: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(), cursor: z.string().regex(/^[A-Za-z0-9_-]{0,128}$/),
  status: z.enum(['pending', 'done']), protocol: z.literal(2),
});
function validScope(id: string) {
  if (!validProjectId(id)) throw new Refusal('bad_input', 'Choose a project.');
}
async function authorize(tx: Parameters<typeof assertMembership>[0], operatorId: string) {
  const role = await assertMembership(tx, operatorId);
  if (role !== 'owner') throw new Refusal('forbidden', 'Only the owner can do this.');
}
const knownFailure = new Set(['delivery_error', 'invalid_generation', 'invalid_context', 'missing_source']);
const numberOrUnknown = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
function metadata(jobId: string, job: FanoutJob, at: number) {
  const created = numberOrUnknown(job.createdAt), ready = numberOrUnknown(job.readyAt);
  return { jobId, status: job.status, generation: numberOrUnknown(job.generation), delivered: numberOrUnknown(job.delivered),
    consecutiveFailures: numberOrUnknown(job.consecutiveFailures ?? 0),
    failure: job.failure === null ? null : knownFailure.has(job.failure) ? job.failure : 'unknown',
    createdAt: created, updatedAt: numberOrUnknown(job.updatedAt), readyAt: ready,
    sourceAgeSeconds: created === null ? null : Math.max(0, Math.floor((at - created) / 1000)),
    overdueSeconds: job.status !== 'pending' || ready === null ? null : Math.max(0, Math.floor((at - ready) / 1000)) };
}
export async function listDeliveryJobs(operator: WithId<Profile>, id: string, query: z.infer<typeof DELIVERY_QUERY>, now: () => number) {
  validScope(id);
  const scope = `delivery:${operator.id}:${id}:${query.status}`, after = cursorAfter(query.cursor, scope);
  return inProject(id, () => db.runTransaction(async tx => {
    await authorize(tx, operator.id);
    let request = fanoutJobs.where('projectId', '==', id).where('status', '==', query.status).orderBy(FieldPath.documentId()).limit(21);
    if (after) request = request.startAfter(after);
    const found = await tx.get(request), page = found.docs.slice(0, 20), at = now();
    return { jobs: page.map(d => metadata(d.id, d.data(), at)), generatedAt: at,
      next: found.size > 20 ? nextCursor(scope, page.at(-1)!.id) : null };
  }));
}
export async function retryDeliveryJob(operator: WithId<Profile>, id: string, jobId: string,
  input: z.infer<typeof DELIVERY_RETRY>, now: () => number) {
  validScope(id);
  if (!/^[a-f0-9]{64}$/.test(jobId) || !DELIVERY_RETRY.safeParse(input).success) throw new Refusal('bad_input', 'Give the job ID, its generation and a reason for the retry.');
  input = DELIVERY_RETRY.parse(input);
  return inProject(id, () => db.runTransaction(async tx => {
    await authorize(tx, operator.id);
    const receiptId = hashToken(`${operator.id}:${input.client_request_id}`);
    const receiptRef = projectCollection<{ fingerprint: string; result: { jobId: string; generation: number; status: string } }>('deliveryOperations').doc(receiptId);
    const fingerprint = hashToken(JSON.stringify({ id, jobId, input }));
    const [receipt, found] = await Promise.all([tx.get(receiptRef), tx.get(fanoutJobs.doc(jobId))]);
    // Role is checked on every replay. A lost response never gives a removed admin authority.
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { ...receipt.data()!.result, replayed: true };
    }
    const job = found.data();
    if (!job || job.projectId !== id || !idString.safeParse(job.sourceId).success || fanoutJobId(id, job.sourceId) !== jobId) {
      throw new Refusal('not_found', 'No delivery job in this project has that ID.');
    }
    if (job.generation !== input.expected_generation) throw new Refusal('delivery_conflict', 'This delivery changed. Reload, then try again.');
    if (job.status !== 'blocked') throw new Refusal('bad_input', 'Only blocked deliveries can be retried.');
    const sourceRef = fanouts().doc(job.sourceId), source = await tx.get(sourceRef);
    const parsed = SOURCE.safeParse(source.data());
    if (!parsed.success || parsed.data.status !== 'pending') throw new Refusal('bad_input', 'This delivery can’t be retried: its source is missing, already done or needs repair.');
    const at = now(), generation = job.generation + 1;
    // Fence old workers without resetting cursor/source markers; resume from committed progress.
    tx.update(sourceRef, { leaseOwner: null, leaseUntil: 0 });
    tx.update(found.ref, { status: 'pending', generation, readyAt: at, updatedAt: at,
      consecutiveFailures: 0, failure: null, delivered: parsed.data.delivered });
    tx.set(fanoutProjects.doc(id), { projectId: id });
    const result = { jobId, generation, status: 'pending' };
    tx.create(receiptRef, { fingerprint, result });
    tx.create(projectCollection('deliveryHistory').doc(receiptId), {
      at, operatorId: operator.id, jobId, reason: input.reason, before: metadata(jobId, job, at), result,
    });
    return { ...result, replayed: false };
  }));
}
