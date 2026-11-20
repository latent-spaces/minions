import type { DeliveryReviewRequiredCheck } from '@minions/contracts';
import { expect, test, vi } from 'vitest';
import { OBSERVATION_TTL_MS, observeDeliveryCandidate } from '../src/projects/delivery-review-observation.js';

const now = () => 1_000_000;
const headSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const candidate = { repository: 'example/repo', pullRequest: 7, headSha };
const tests: DeliveryReviewRequiredCheck = {
  name: 'Unit tests',
  workflowId: 42,
  workflowPath: '.github/workflows/test.yml',
  workflowBlobSha: 'c'.repeat(40),
};
const lint = { ...tests, name: 'Lint' };
const policy = [tests, lint];
const identity = { runId: 1, runAttempt: 2, jobId: 3, checkRunId: 4 };
const verified = { name: tests.name, status: 'verified', ...identity };
const failed = { ...verified, status: 'failed' };
const pending = { name: lint.name, status: 'pending', runId: 1, runAttempt: 2 };
const unavailable = { name: tests.name, status: 'unavailable' };
const unavailableLint = { ...unavailable, name: lint.name };
const result = { status: 'verified', observedAt: now(), actualHeadSha: headSha, checks: [verified] };
const observe = (value: unknown, requiredChecks = [tests]) => observeDeliveryCandidate(async () => value, candidate, requiredChecks, now);

test('delivers exact-head outcomes in configured order and discards unknown fields', async () => {
  const lintVerified = { ...verified, name: lint.name };
  const received = { ...result, secret: 'irrelevant', checks: [lintVerified, { ...verified, secret: 'irrelevant' }] };
  expect(await observe(received, policy)).toEqual({ ...result, checks: [verified, lintVerified] });
  expect(await observe({ ...result, status: 'pending', checks: [pending, verified] }, policy))
    .toMatchObject({ status: 'pending', checks: [verified, pending] });
  expect(await observe({ ...result, status: 'unavailable', checks: [unavailableLint, verified] }, policy))
    .toMatchObject({ status: 'unavailable', checks: [verified, unavailableLint] });
});

test('verification requires all configured checks, agreed status and complete evidence', async () => {
  const lintVerified = { ...verified, name: lint.name };
  const attempts = [
    result,
    { ...result, checks: [verified, lintVerified, verified] },
    { ...result, checks: [verified, lintVerified, { ...verified, name: ' unit tests ' }] },
    { ...result, checks: [verified, { ...lintVerified, jobId: undefined }] },
    { ...result, checks: [verified, { ...lintVerified, runAttempt: 0 }] },
    { ...result, checks: [verified, { ...lintVerified, checkRunId: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...result, status: 'unavailable', checks: [verified, lintVerified] },
    { ...result, status: 'pending', checks: [verified, lintVerified] },
    { ...result, status: 'failed', checks: [verified, lintVerified] },
  ];
  for (const attempt of attempts) {
    expect(await observe(attempt, policy)).toMatchObject({ status: 'unavailable', checks: [unavailable, unavailableLint] });
  }
  expect(await observe({ ...result, checks: [] }, [])).toMatchObject({ status: 'unavailable', checks: [] });
  expect(await observe(result, [tests, tests])).toMatchObject({ status: 'unavailable', checks: [unavailable] });
});

test('retains an identified failed check when other check evidence is inconclusive', async () => {
  const report = { ...result, status: 'unavailable', checks: [failed, pending, unavailableLint] };
  expect(await observe(report, policy)).toMatchObject({ status: 'failed', checks: [failed, unavailableLint] });
  expect(await observe({ ...report, checks: [failed, { ...failed, jobId: 8 }, pending] }, policy))
    .toMatchObject({ status: 'unavailable', checks: [unavailable, unavailableLint] });
});

test('rejects malformed and mistimed observations and limits stale outcomes to confirmed PR state', async () => {
  for (const value of [
    false,
    { ...result, status: 'unknown' },
    { ...result, observedAt: Number.NaN },
    { ...result, observedAt: Number.POSITIVE_INFINITY },
    { ...result, observedAt: now() + 1 },
    { ...result, observedAt: now() - OBSERVATION_TTL_MS },
    { ...result, actualHeadSha: otherSha },
    { ...result, status: 'stale', staleReason: 'head_changed' },
    { ...result, status: 'stale', staleReason: 'closed', actualHeadSha: null },
    { ...result, status: 'stale', staleReason: 'closed', actualHeadSha: 'not a sha' },
    { ...result, status: 'stale', actualHeadSha: otherSha },
  ]) {
    expect(await observe(value)).toEqual({ status: 'unavailable', observedAt: now(), actualHeadSha: null, checks: [unavailable] });
  }
  for (const [staleReason, actualHeadSha] of [['closed', headSha], ['head_changed', otherSha]] as const) {
    expect(await observe({ ...result, status: 'stale', staleReason, actualHeadSha, checks: [failed] }))
      .toEqual({ status: 'stale', observedAt: now(), staleReason, actualHeadSha, checks: [unavailable] });
  }
});

test('bounds the provider attempt, aborts it, and clears timers on completion and rejection', async () => {
  vi.useFakeTimers();
  try {
    const fallback = { status: 'unavailable', observedAt: now(), actualHeadSha: null, checks: [unavailable] };
    expect(await observeDeliveryCandidate(undefined, candidate, [tests], now)).toEqual(fallback);
    expect(await observeDeliveryCandidate(async () => { throw new Error('provider failed'); }, candidate, [tests], now)).toEqual(fallback);
    expect(vi.getTimerCount()).toBe(0);
    expect(await observe(result)).toEqual(result);
    expect(vi.getTimerCount()).toBe(0);

    let providerSignal: AbortSignal | undefined;
    const observation = observeDeliveryCandidate((_candidate, _policy, { signal }) => {
      providerSignal = signal;
      return new Promise(() => {});
    }, candidate, [tests], now);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(providerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(await observation).toEqual(fallback);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
