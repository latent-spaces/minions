// Self-hosted delivery transport characterization. Durable delivery and the periodic reconcilers
// are stubbed; no emulator, Google API, network listener or model is used.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(), dispatch: vi.fn(), reserve: vi.fn(), backlog: vi.fn(), scheduled: vi.fn(),
  hosting: vi.fn(), cleanup: vi.fn(), sessions: vi.fn(),
}));
vi.mock('../src/identity/server-sessions.js', () => ({ deleteExpiredSessions: mocks.sessions }));
vi.mock('../src/v2/fanout-jobs.js', () => ({
  dispatchFanoutJob: mocks.dispatch, reserveFanoutRound: mocks.reserve, fanoutBacklog: mocks.backlog,
}));
vi.mock('../src/analytics/projection.js', () => ({ reconcileUsageMetrics: mocks.metrics }));
vi.mock('../src/projects/scheduled-start.js', () => ({ reconcileScheduledStarts: mocks.scheduled }));
vi.mock('../src/hosting/service.js', () => ({ reconcileHostingOperations: mocks.hosting }));
vi.mock('../src/hosting/cleanup.js', () => ({ reconcileHostingCleanup: mocks.cleanup }));
import { LOCAL_QUEUE, localScheduler, localTaskQueue, startLocalWorker } from '../src/v2/local-fanout.js';

const hint = (n: number, generation = 1) => ({ jobId: n.toString(16).padStart(64, '0'), generation });
const ok = { status: 200 as const, body: {} };
const busy = { status: 503 as const, body: { error: 'lease_busy' } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: 1_000_000_000_000 });
  mocks.dispatch.mockResolvedValue('done');
  mocks.reserve.mockResolvedValue({ dispatches: [], oldestDueSeconds: null });
  mocks.backlog.mockResolvedValue({ globalOldestDueSeconds: null, backlogProjects: 0 });
  mocks.scheduled.mockResolvedValue({ failed: 0 });
  mocks.sessions.mockResolvedValue({ deleted: 0, more: false });
  mocks.metrics.mockResolvedValue({ failed: 0 });
  mocks.hosting.mockResolvedValue({ failed: 0 });
  mocks.cleanup.mockResolvedValue({ failed: 0 });
});
afterEach(() => { vi.useRealTimers(); });

test('task names deduplicate while queued and for the tombstone window, like Cloud Tasks', async () => {
  const handle = vi.fn().mockResolvedValue(ok);
  const queue = localTaskQueue(handle);
  expect(await queue.enqueue(hint(1))).toBe('created');
  expect(await queue.enqueue(hint(1))).toBe('already_exists');
  expect(await queue.enqueue(hint(1, 2))).toBe('created');
  await vi.advanceTimersByTimeAsync(0);
  expect(handle).toHaveBeenCalledTimes(2);
  expect(await queue.enqueue(hint(1))).toBe('already_exists');
  await vi.advanceTimersByTimeAsync(LOCAL_QUEUE.tombstoneMs);
  expect(await queue.enqueue(hint(1))).toBe('created');
  await expect(queue.enqueue({ jobId: 'not-a-job', generation: 1 })).rejects.toThrow('Invalid task dispatch.');
  await expect(queue.enqueue(hint(2, 0))).rejects.toThrow('Invalid task dispatch.');
});

test('retryable results follow the hosted backoff and stop only after both attempt and duration limits', async () => {
  const attemptsAt: number[] = [];
  const handle = vi.fn(async () => { attemptsAt.push(Date.now()); return busy; });
  const queue = localTaskQueue(handle);
  await queue.enqueue(hint(3));
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  const gaps = attemptsAt.slice(1).map((at, i) => (at - attemptsAt[i]) / 1000);
  // 8 attempts end at 255 s; Cloud Tasks keeps retrying until max retry duration (300 s) also passes.
  expect(gaps).toEqual([5, 10, 20, 40, 60, 60, 60, 60]);
  expect(queue.pending()).toBe(0);
  expect(await queue.enqueue(hint(3))).toBe('already_exists');
});

test('a thrown handler is retried and a later success settles the hint', async () => {
  const handle = vi.fn().mockRejectedValueOnce(new Error('synthetic')).mockResolvedValueOnce(ok);
  const queue = localTaskQueue(handle);
  await queue.enqueue(hint(4));
  await vi.advanceTimersByTimeAsync(LOCAL_QUEUE.minBackoffMs);
  expect(handle).toHaveBeenCalledTimes(2);
  expect(queue.pending()).toBe(0);
});

test('at most four hints run at once', async () => {
  let running = 0, peak = 0;
  const handle = vi.fn(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 1000));
    running--; return ok;
  });
  const queue = localTaskQueue(handle);
  for (let n = 1; n <= 10; n++) await queue.enqueue(hint(n));
  await vi.advanceTimersByTimeAsync(5000);
  expect(handle).toHaveBeenCalledTimes(10);
  expect(peak).toBe(LOCAL_QUEUE.maxConcurrent);
});

test('closing drops waiting hints, refuses new ones and lets drained resolve', async () => {
  const handle = vi.fn().mockResolvedValue(busy);
  const queue = localTaskQueue(handle);
  await queue.enqueue(hint(5));
  await vi.advanceTimersByTimeAsync(0);
  expect(queue.pending()).toBe(1);
  queue.close();
  await queue.drained();
  expect(queue.pending()).toBe(0);
  await vi.advanceTimersByTimeAsync(LOCAL_QUEUE.maxRetryDurationMs);
  expect(handle).toHaveBeenCalledTimes(1);
  await expect(queue.enqueue(hint(6))).rejects.toThrow('closed');
});

test('the scheduler never overlaps reconcile rounds', async () => {
  let release!: () => void;
  const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const scheduler = localScheduler(run, 1000);
  await vi.advanceTimersByTimeAsync(3500);
  expect(run).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(2);
  // Stopping waits for the running reconcile, so it never enqueues into a closed queue.
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(stopped).toBe(false);
  expect(run).toHaveBeenCalledTimes(2);
  release();
  await stopping;
});

test('the local worker reserves, dispatches and retries a busy lease through the shared handlers', async () => {
  mocks.reserve.mockResolvedValueOnce({ dispatches: [hint(7, 1)], oldestDueSeconds: 0 });
  mocks.dispatch.mockResolvedValueOnce('leased').mockResolvedValueOnce('done');
  const worker = startLocalWorker(Date.now, 60_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(mocks.dispatch).toHaveBeenLastCalledWith(hint(7, 1), Date.now);
  // lease_busy is retryable: the same hint runs again after the minimum backoff.
  await vi.advanceTimersByTimeAsync(LOCAL_QUEUE.minBackoffMs);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  // A settled hint drives another fair round, as the hosted /deliver handler does.
  expect(mocks.reserve.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mocks.scheduled).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.scheduled).toHaveBeenCalledTimes(2);
  // Each reconcile round also reclaims expired self-hosted sign-in sessions.
  expect(mocks.sessions).toHaveBeenCalledTimes(2);
  await worker.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.scheduled).toHaveBeenCalledTimes(2);
});

test('a failed session sweep is logged without failing or delaying the reconcile round', async () => {
  mocks.sessions.mockRejectedValue(new Error('store down'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const worker = startLocalWorker(Date.now, 60_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.scheduled).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'local_session_sweep_failed' }));
  expect(error.mock.calls.flat().join(' ')).not.toContain('store down');
  await worker.stop();
  error.mockRestore();
});
