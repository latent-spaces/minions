// D5/D6 dispatcher contract, model-free: an in-memory job record and a stubbed runFanout. It checks only
// which hints dispatchFanoutJob admits, which generation fences the run, how outcomes map for older
// hints and how failures are recorded. Exactly-once delivery stays covered by the emulator suites.
import { beforeEach, expect, test, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const run = vi.hoisted(() => vi.fn());
vi.mock('../src/config.js', () => ({ V2_LIMITS: { fanoutLeaseSeconds: 30 } }));
vi.mock('../src/firestore.js', () => {
  const read = (path: string) => ({ data: () => store.get(path) && { ...store.get(path) } });
  const doc = (path: string) => ({ id: path.split('/').at(-1)!, path, get: async () => read(path) });
  return {
    collection: (name: string) => ({ doc: (id: string) => doc(`${name}/${id}`) }),
    currentProjectId: () => 'p'.repeat(64),
    inProject: (_id: string, work: () => unknown) => work(),
    db: { runTransaction: async (work: (tx: unknown) => unknown) => work({
      get: async (ref: { path: string }) => read(ref.path),
      update: (ref: { path: string }, patch: Record<string, unknown>) => store.set(ref.path, { ...store.get(ref.path), ...patch }),
    }) },
  };
});
vi.mock('../src/v2/fanout.js', () => ({ runFanout: run }));
import { dispatchFanoutJob, fanoutJobId } from '../src/v2/fanout-jobs.js';

const projectId = 'a'.repeat(64);
const sourceId = 'source-1';
const jobId = fanoutJobId(projectId, sourceId);
const path = `fanoutJobs/${jobId}`;
const at = 1_000_000;
const job = () => store.get(path)!;
const seed = (patch: Record<string, unknown> = {}) => store.set(path, {
  projectId, sourceId, createdAt: 0, updatedAt: 0, status: 'pending', readyAt: at + 30_000, generation: 3,
  delivered: 0, failure: null, ...patch,
});

beforeEach(() => { store.clear(); run.mockReset(); seed(); });

test('an older hint for a pending job runs under the job\'s current generation', async () => {
  run.mockResolvedValue('done');
  expect(await dispatchFanoutJob({ jobId, generation: 1 }, () => at)).toBe('done');
  expect(run).toHaveBeenCalledWith(sourceId, expect.any(Function), 3);
});

test('a hint newer than a pending job is stale and starts no run', async () => {
  expect(await dispatchFanoutJob({ jobId, generation: 4 }, () => at)).toBe('stale');
  expect(run).not.toHaveBeenCalled();
  expect(job()).toMatchObject({ status: 'pending', generation: 3, readyAt: at + 30_000 });
});

test.each(['done', 'blocked'])('any hint for a %s job is stale and starts no run', async status => {
  seed({ status });
  for (const generation of [1, 3]) expect(await dispatchFanoutJob({ jobId, generation }, () => at)).toBe('stale');
  expect(run).not.toHaveBeenCalled();
});

test.each([
  ['leased', 'stale', 'leased'], ['lost_lease', 'stale', 'lost_lease'],
  ['pending', 'pending', 'pending'], ['done', 'done', 'done'], ['stale', 'stale', 'stale'],
])('a run outcome %s maps to %s for an older hint and %s for the current one', async (outcome, older, current) => {
  run.mockResolvedValue(outcome);
  expect(await dispatchFanoutJob({ jobId, generation: 2 }, () => at)).toBe(older);
  expect(await dispatchFanoutJob({ jobId, generation: 3 }, () => at)).toBe(current);
});

// codex-1's defensive point: strict equality refused a malformed stored generation; `>` must not admit it.
test.each([['5'], [Infinity], [Number.NaN], [0], [1.5]])('a malformed stored generation %s starts no run', async generation => {
  seed({ generation });
  expect(await dispatchFanoutJob({ jobId, generation: 1 }, () => at)).toBe('stale');
  expect(run).not.toHaveBeenCalled();
});

test('the current hint\'s failure is recorded against its generation and asks the queue to retry', async () => {
  run.mockRejectedValue(new Error('synthetic page failure'));
  await expect(dispatchFanoutJob({ jobId, generation: 3 }, () => at)).rejects.toThrow('synthetic page failure');
  expect(job()).toMatchObject({ status: 'pending', generation: 3, consecutiveFailures: 1, failure: 'delivery_error' });
  expect(job().olderFailureGeneration).toBeUndefined();
});

test('eight failing current hints block a poison job, as before D5', async () => {
  run.mockRejectedValue(new Error('synthetic poison'));
  const outcomes: string[] = [];
  for (let hint = 0; hint < 8; hint++) outcomes.push(await dispatchFanoutJob({ jobId, generation: 3 }, () => at).catch(() => 'retry'));
  expect(outcomes).toEqual([...Array(7).fill('retry'), 'blocked']);
  expect(job()).toMatchObject({ status: 'blocked', consecutiveFailures: 8, failure: 'delivery_error' });
});

// D6: queued older hints each get their own queue retries, so counting all their failures could block a job within
// seconds of one fault. Each reservation generation counts at most one older-hint failure, and an older hint never
// asks for a retry. A persistent fault still blocks the job when only older hints ever run (a slow queue).
const quietly = <T>(work: () => Promise<T>) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return work().finally(() => log.mockRestore());
};

test('an older hint\'s failure counts once, marks its generation, logs and asks for no retry', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  run.mockRejectedValue(new Error('synthetic claim failure'));
  expect(await dispatchFanoutJob({ jobId, generation: 1 }, () => at)).toBe('stale');
  expect(job()).toMatchObject({ status: 'pending', generation: 3, consecutiveFailures: 1, olderFailureGeneration: 3, failure: 'delivery_error' });
  expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ event: 'fanout_older_hint_failed', jobId, generation: 1, current: 3, recorded: 'retry', errorName: 'Error' });
  log.mockRestore();
});

test('the older-hint log names the error class only, never its message', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  run.mockRejectedValueOnce(new TypeError('secret detail')).mockRejectedValueOnce('not an error');
  await dispatchFanoutJob({ jobId, generation: 1 }, () => at);
  await dispatchFanoutJob({ jobId, generation: 2 }, () => at);
  expect(log.mock.calls.map(call => JSON.parse(call[0] as string))).toMatchObject([
    { errorName: 'TypeError', recorded: 'retry' }, { errorName: 'unknown', recorded: 'counted' }]);
  expect(log.mock.calls.join(' ')).not.toContain('secret detail');
  log.mockRestore();
});

test('ten failing older hints in one generation spend one failure', async () => {
  run.mockRejectedValue(new Error('synthetic claim failure'));
  await quietly(async () => {
    for (let hint = 0; hint < 10; hint++) expect(await dispatchFanoutJob({ jobId, generation: 1 + (hint % 2) }, () => at)).toBe('stale');
  });
  expect(job()).toMatchObject({ status: 'pending', consecutiveFailures: 1, olderFailureGeneration: 3 });
});

test('a poison job reached only by older hints blocks after eight generations', async () => {
  run.mockRejectedValue(new Error('synthetic poison'));
  const outcomes: string[] = [];
  await quietly(async () => {
    for (let generation = 3; generation <= 10; generation++) {
      seed({ ...job(), generation }); // the selector re-reserves; the job's failure record carries over
      for (let copy = 0; copy < 2; copy++) outcomes.push(await dispatchFanoutJob({ jobId, generation: generation - 1 }, () => at));
    }
  });
  expect(outcomes).toEqual([...Array(14).fill('stale'), 'blocked', 'stale']);
  expect(job()).toMatchObject({ status: 'blocked', consecutiveFailures: 8, olderFailureGeneration: 10 });
});

test('the current hint still counts after an older failure in the same generation', async () => {
  run.mockRejectedValue(new Error('synthetic failure'));
  await quietly(() => dispatchFanoutJob({ jobId, generation: 2 }, () => at));
  await expect(dispatchFanoutJob({ jobId, generation: 3 }, () => at)).rejects.toThrow('synthetic failure');
  expect(job()).toMatchObject({ consecutiveFailures: 2, olderFailureGeneration: 3 });
});

test.each([[2], [3]])('a failure of a generation-%s hint after a newer reservation is not counted', async generation => {
  run.mockImplementation(async () => { seed({ generation: 4 }); throw new Error('synthetic failure'); });
  expect(await quietly(() => dispatchFanoutJob({ jobId, generation }, () => at))).toBe('stale');
  expect(job().consecutiveFailures).toBeUndefined();
  expect(job().olderFailureGeneration).toBeUndefined();
});
