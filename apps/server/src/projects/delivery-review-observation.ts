import type { DeliveryReviewCandidate, DeliveryReviewObservation, DeliveryReviewRequiredCheck } from '@minions/contracts';
import { z } from 'zod';

export const OBSERVATION_TTL_MS = 5 * 60_000;
// Leave time for the surrounding transactions before the worker bridge times out.
const OBSERVATION_TIMEOUT_MS = 20_000;

type Candidate = Pick<DeliveryReviewCandidate, 'repository' | 'pullRequest' | 'headSha'>;
type Check = DeliveryReviewObservation['checks'][number];
export type DeliveryReviewObserver = (
  candidate: Candidate,
  requiredChecks: readonly DeliveryReviewRequiredCheck[],
  options: { signal: AbortSignal; now: () => number },
) => Promise<unknown>;

const checkStatus = z.enum(['verified', 'pending', 'failed', 'unavailable']);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const rawObservation = z.object({
  status: z.union([checkStatus, z.literal('stale')]),
  observedAt: z.number().finite().nonnegative(),
  actualHeadSha: sha.nullable(),
  staleReason: z.enum(['closed', 'head_changed']).optional(),
  checks: z.array(z.unknown()),
});
const namedCheck = z.object({ name: z.string() });
const evidenceId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();
const observedCheck = namedCheck.extend({
  status: checkStatus,
  runId: evidenceId,
  runAttempt: evidenceId,
  jobId: evidenceId,
  checkRunId: evidenceId,
}).refine(({ status, runId, runAttempt, jobId, checkRunId }) => {
  const run = runId !== undefined && runAttempt !== undefined;
  const job = jobId !== undefined && checkRunId !== undefined;
  if (status === 'verified' || status === 'failed') return run && job;
  return (run || (runId === undefined && runAttempt === undefined))
    && (job ? run : jobId === undefined && checkRunId === undefined);
});

function unavailableCheck(name: string): Check {
  return { name, status: 'unavailable' };
}

function unavailableObservation(observedAt: number, names: readonly string[]): DeliveryReviewObservation {
  return { status: 'unavailable', observedAt, actualHeadSha: null, checks: names.map(unavailableCheck) };
}

function checkOutcome(checks: readonly Check[]): Check['status'] {
  if (checks.some(check => check.status === 'failed')) return 'failed';
  if (!checks.length || checks.some(check => check.status === 'unavailable')) return 'unavailable';
  if (checks.some(check => check.status === 'pending')) return 'pending';
  return 'verified';
}

function normalizeObservation(result: unknown, headSha: string, names: readonly string[], now: number): DeliveryReviewObservation {
  const parsed = rawObservation.safeParse(result);
  if (!parsed.success) return unavailableObservation(now, names);
  const { status, observedAt, actualHeadSha, staleReason } = parsed.data;
  if (observedAt > now || now - observedAt >= OBSERVATION_TTL_MS) return unavailableObservation(now, names);
  if (status === 'stale') {
    if (actualHeadSha && (staleReason === 'closed' || (staleReason === 'head_changed' && actualHeadSha !== headSha)))
      return { status, observedAt, actualHeadSha, staleReason, checks: names.map(unavailableCheck) };
    return unavailableObservation(now, names);
  }
  if (staleReason || actualHeadSha !== headSha) return unavailableObservation(now, names);

  const configured = new Set(names);
  const rows = new Map<string, unknown>();
  let complete = true;
  for (const row of parsed.data.checks) {
    const named = namedCheck.safeParse(row);
    if (!named.success || !configured.has(named.data.name)) {
      complete = false;
      continue;
    }
    const { name } = named.data;
    rows.set(name, rows.has(name) ? undefined : row);
  }
  const checks = names.map(name => {
    const check = observedCheck.safeParse(rows.get(name));
    if (check.success) return check.data;
    complete = false;
    return unavailableCheck(name);
  });
  const outcome = checkOutcome(checks);
  if (complete && status === outcome) return { status, observedAt, actualHeadSha, checks };

  // Positive evidence must agree with the aggregate before it can clear a named failure.
  // A distinct, valid failed check still carries evidence when other checks are inconclusive.
  const inconclusive = !complete || status === 'unavailable' || status === 'failed';
  const trustedChecks = checks.map(check => check.status === 'verified' || (inconclusive && check.status === 'pending')
    ? unavailableCheck(check.name) : check);
  return { status: checkOutcome(trustedChecks), observedAt, actualHeadSha, checks: trustedChecks };
}

export async function observeDeliveryCandidate(
  observer: DeliveryReviewObserver | undefined,
  candidate: Candidate,
  requiredChecks: readonly DeliveryReviewRequiredCheck[],
  now: () => number,
): Promise<DeliveryReviewObservation> {
  const names = [...new Set(requiredChecks.map(check => check.name))];
  if (!observer || names.length !== requiredChecks.length) return unavailableObservation(now(), names);
  const { repository, pullRequest, headSha } = candidate;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      resolve(null);
      controller.abort();
    }, OBSERVATION_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      deadline,
      observer({ repository, pullRequest, headSha }, requiredChecks, { signal: controller.signal, now }),
    ]);
    return normalizeObservation(result, headSha, names, now());
  } catch {
    return unavailableObservation(now(), names);
  } finally {
    clearTimeout(timer);
  }
}
