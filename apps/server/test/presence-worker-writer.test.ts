// Gate 2, option (a) of the current-state contract, rollout stage W1: every worker-session sync also writes its status
// summary as the status document's `worker` group (presence/{agent}.worker), replaced whole and run-tagged, beside the
// unchanged pointer summary. Freshness is the worker's own (codex-1's disconnect tail); readers are unchanged until R2.
import { randomUUID } from 'node:crypto';
import { Transaction, type DocumentReference } from 'firebase-admin/firestore';
import { beforeEach, expect, test } from 'vitest';
import { V2_LIMITS } from '../src/config.js';
import { inProject } from '../src/firestore.js';
import { syncWorkerSession, workerPointer } from '../src/projects/worker-sessions.js';
import { reportPhase, startRun } from '../src/v2/runs.js';
import { presence } from '../src/v2/records.js';
import { communicationAgents } from '../src/view/communication-agents.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import { TransactionPrototype } from './store-prototypes.js';

let clock = 2_000_000_000_000;
const now = () => clock;
const scope = <T>(fn: () => T) => inProject(TEST_PROJECT, fn);
beforeEach(async () => { await resetEmulator(); clock += 3_600_000; writes.length = 0; });

// Document writes, by path, counted at the transaction.
const writes: string[] = [];
for (const name of ['set', 'update', 'create'] as const) {
  const original = TransactionPrototype[name] as (...args: unknown[]) => Transaction;
  Object.defineProperty(TransactionPrototype, name, { configurable: true, writable: true,
    value: function (this: Transaction, ...args: unknown[]) { writes.push((args[0] as DocumentReference).path); return original.apply(this, args); } });
}
const kind = (path: string) => path.includes('/presence/') ? 'presence' : /\/workerSessions\/[^/]+$/.test(path) ? 'pointer'
  : path.includes('/runs/') && path.includes('/workerSessions/') ? 'session' : 'other';

async function started() {
  const f = await seed({ profiles: [{ name: 'Worker person', email: 'worker@example.test' }], agents: [{ person: 0, name: 'Worker group' }] });
  const id = f.agents[0].agentId, reader = f.personIds[0];
  const run = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: false }, now));
  const session = { run_id: run.run_id, missionId: randomUUID(), generation: 1, startedAt: clock, deadlineAt: clock + 3 * 3_600_000, remainingSlots: 0, phase: 'working' as string, projectPauseRevision: undefined as number | undefined };
  return { id, reader, runId: run.run_id, session };
}
const sync = (id: string, session: Record<string, unknown>) =>
  scope(() => syncWorkerSession(id, Object.fromEntries(Object.entries(session).filter(([, v]) => v !== undefined)), now));
type Doc = { worker?: Record<string, unknown>; lastContactAt?: number };
const statusDoc = async (id: string) => ((await scope(() => presence().doc(id).get())).data() ?? {}) as Doc;
const pointerDoc = async (id: string) => (await scope(() => workerPointer(id).get())).data();

test('each sync writes the canonical worker group, authority pointer and session', async () => {
  const { id, runId, session } = await started();
  writes.length = 0;
  for (let i = 0; i < 3; i++) { clock += 20_000; await sync(id, session); }
  expect(writes.map(kind).filter(k => k !== 'other').sort())
    .toEqual(['pointer', 'pointer', 'pointer', 'presence', 'presence', 'presence', 'session', 'session', 'session']);
  const summary = { runId, phase: 'working', lastContactAt: clock, deadlineAt: session.deadlineAt };
  expect((await statusDoc(id)).worker).toEqual(summary);
  // The pointer is exactly what the previous writer stored, so readers and writers of every older version still agree.
  expect(await pointerDoc(id)).toEqual({ missionId: session.missionId });
});

test('the hard cutover reads the canonical worker group and ignores an old conflicting pointer', async () => {
  const { id, reader, session } = await started();
  await sync(id, session);
  const read = () => scope(() => communicationAgents({ ids: id }, reader, clock)).then(page => page.agents[0]);
  const before = await read();
  // A frozen or wrong worker group (an instance rolled back to before W1 keeps syncing the pointer only) changes nothing.
  await scope(() => presence().doc(id).set({ worker: { runId: session.run_id, phase: 'stopped', lastContactAt: clock - 600_000,
    deadlineAt: clock - 1 } } as never, { mergeFields: ['worker'] }));
  expect(await read()).toMatchObject({ state: 'stopped' });
  expect(before.state).toBe('working');
});

test('the group is replaced whole: a sync without a pause confirmation keeps none from before', async () => {
  const { id, session } = await started();
  await sync(id, { ...session, phase: 'paused' });  // no project pause pending: not a confirmation
  expect((await statusDoc(id)).worker).not.toHaveProperty('projectPauseRevision');
  await scope(() => presence().doc(id).set({ worker: { projectPauseRevision: 7 } } as never, { merge: true }));
  clock += 20_000;
  await sync(id, session);
  expect((await statusDoc(id)).worker).not.toHaveProperty('projectPauseRevision');
});

test('codex-1 disconnect tail: syncs at 20/40/60/80 s, read at 155 s: the worker contact is 80 s, online until 170 s', async () => {
  const { id, reader, session } = await started();
  const startAt = clock;
  for (const t of [20_000, 40_000, 60_000, 80_000]) { clock = startAt + t; await sync(id, session); }
  expect((await statusDoc(id)).worker?.lastContactAt).toBe(startAt + 80_000);
  const read = async (t: number) => scope(() => communicationAgents({ ids: id }, reader, startAt + t)).then(page => page.agents[0]);
  // The real map read (today's sources) agrees: still working at 155 s, and lapsed only after 80 + 90 s.
  expect((await read(155_000)).state).toBe('working');
  expect(startAt + 80_000 + V2_LIMITS.runActiveSeconds * 1000).toBe(startAt + 170_000);
  expect((await read(171_000)).state).not.toBe('working');
});

test('a terminal phase report with its worker session writes the run group and the worker group in one transaction', async () => {
  const { id, runId, session: base } = await started();
  const session = { ...base, missionId: runId };  // a final worker contact names its run as the mission
  await sync(id, session);
  clock += 1_000;
  await scope(() => reportPhase(id, runId, { phase: 'stopping', reason: 'operator',
    workerSession: { ...session, phase: 'stopped', remainingSlots: 0 } as never }, now));
  const stored = await statusDoc(id) as Doc & { phase?: string };
  expect(stored.phase).toBe('stopping');
  expect(stored.worker).toMatchObject({ runId, phase: 'stopped', lastContactAt: clock });
});

test('a takeover starts a new run group and leaves the previous run\'s worker group, tagged with its own run', async () => {
  const { id, runId, session } = await started();
  await sync(id, session);
  clock += 1_000;
  const next = await scope(() => startRun(id, { clientRunId: randomUUID(), runnerVersion: 'synthetic-no-model', takeover: true }, now));
  const stored = await statusDoc(id) as Doc & { runId?: string };
  // A reader of the group (R2) must ignore a worker group whose runId is not the current run's (contract v2.3).
  expect(stored.runId).toBe(next.run_id);
  expect(stored.worker?.runId).toBe(runId);
  expect(stored.worker?.runId).not.toBe(stored.runId);
});
