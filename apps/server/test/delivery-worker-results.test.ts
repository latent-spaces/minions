// Worker result characterization: durable delivery, selector and repair are stubbed.
// The in-process queue retries a 503 result and settles a 200 result.
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(), dispatch: vi.fn(), reserve: vi.fn(), backlog: vi.fn(), scheduled: vi.fn(),
}));
vi.mock('../src/v2/fanout-jobs.js', () => ({
  dispatchFanoutJob: mocks.dispatch, reserveFanoutRound: mocks.reserve, fanoutBacklog: mocks.backlog,
}));
vi.mock('../src/analytics/projection.js', () => ({ reconcileUsageMetrics: mocks.metrics }));
vi.mock('../src/projects/scheduled-start.js', () => ({ reconcileScheduledStarts: mocks.scheduled }));
import { deliverHint, reconcileFanouts, reconcileWorker } from '../src/v2/fanout-worker.js';

const at = 1_000_000_000_000;
const now = () => at;
const hint = { jobId: 'a'.repeat(64), generation: 1 };
const nextHint = { jobId: 'b'.repeat(64), generation: 2 };
const enqueue = vi.fn();
const round = () => reconcileFanouts(enqueue, now);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.dispatch.mockResolvedValue('stale');
  mocks.reserve.mockResolvedValue({ dispatches: [], oldestDueSeconds: null });
  mocks.backlog.mockResolvedValue({ globalOldestDueSeconds: null, backlogProjects: 0 });
  mocks.scheduled.mockResolvedValue({ failed: 0, started: 0 });
  mocks.metrics.mockResolvedValue({ selected: 0, applied: 0, failed: 0 });
  enqueue.mockResolvedValue('created');
});

async function post(path = '/deliver') {
  const result = path === '/reconcile' ? await reconcileWorker(round, now) : await deliverHint(hint, round, now);
  return { status: result.status, json: async () => result.body };
}

test('a stale hint settles only when its following fair round succeeds', async () => {
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: 'stale', selected: 0, refused: 0 });
  expect(mocks.dispatch).toHaveBeenCalledWith(hint, expect.any(Function));
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
  expect(enqueue).not.toHaveBeenCalled();
});

test('unrelated enqueue refusal asks to retry a stale hint, including a repeated request', async () => {
  mocks.reserve.mockResolvedValue({ dispatches: [nextHint], oldestDueSeconds: 9 });
  enqueue.mockRejectedValue(new Error('synthetic queue refusal'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ outcome: 'stale', selected: 1, refused: 1 });
  }
  expect(enqueue.mock.calls[0][0]).toEqual(nextHint);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  // Durable idempotence belongs to dispatchFanoutJob, which this HTTP-only test stubs.
});

test('a completed source can return 503 because its follow-on enqueue failed', async () => {
  mocks.dispatch.mockResolvedValueOnce('done').mockResolvedValue('stale');
  mocks.reserve.mockResolvedValue({ dispatches: [nextHint], oldestDueSeconds: 0 });
  enqueue.mockRejectedValueOnce(new Error('synthetic queue refusal')).mockResolvedValue('created');
  const first = await post();
  expect(first.status).toBe(503);
  expect(await first.json()).toMatchObject({ outcome: 'done', refused: 1 });
  const repeat = await post();
  expect(repeat.status).toBe(200);
  expect(await repeat.json()).toMatchObject({ outcome: 'stale', refused: 0 });
});

test('selector failure also asks to retry a stale hint without enqueue', async () => {
  mocks.reserve.mockRejectedValue(new Error('synthetic selector failure'));
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'retryable_failure' });
  expect(enqueue).not.toHaveBeenCalled();
});

test.each(['leased', 'lost_lease'])('a %s outcome retries immediately and does not select another round', async outcome => {
  mocks.dispatch.mockResolvedValue(outcome);
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'lease_busy' });
  expect(mocks.reserve).not.toHaveBeenCalled();
});

test('a failed repair component preserves successful reconciliation evidence and asks for retry', async () => {
  mocks.metrics.mockRejectedValue(new Error('synthetic repair failure'));
  mocks.scheduled.mockResolvedValue({ failed: 0, started: 3 });
  const response = await post('/reconcile');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ selected: 0, refused: 0,
    scheduledStarts: { started: 3 }, failedComponents: ['usageMetrics'] });
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

test('failed backlog observation alone does not retry successful reconciliation work', async () => {
  mocks.backlog.mockRejectedValue(new Error('synthetic metrics failure'));
  const response = await post('/reconcile');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ selected: 0, refused: 0, backlog: null });
});


test('analytics failure requests a retry without suppressing successful delivery work',async()=>{
  mocks.metrics.mockRejectedValue(new Error('Synthetic projection fault'));
  const response=await post('/reconcile');
  expect(response.status).toBe(503);
  expect((await response.json()).failedComponents).toContain('usageMetrics');
  expect(mocks.reserve).toHaveBeenCalled();expect(mocks.scheduled).toHaveBeenCalled();
});
