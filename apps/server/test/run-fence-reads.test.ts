import { randomUUID } from 'node:crypto';
import type { DocumentReference, Query } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db, inProject, isDocumentReference } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { agentByToken } from '../src/store/profiles.js';
import { runs } from '../src/v2/records.js';
import { assertCurrentRun, assertRunCurrent, startRun } from '../src/v2/runs.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
import { DocumentPrototype, QueryPrototype } from './store-prototypes.js';

const at = 9_000_000, now = () => at;
const scope = <T>(work: () => T) => inProject(TEST_PROJECT, work);
// Every document path and query a request reads, in or out of a transaction.
let docs: string[] = [], queries = 0;
beforeEach(async () => {
  await resetEmulator(); docs = []; queries = 0;
  const tx = await db.runTransaction(async t => Object.getPrototypeOf(t), { readOnly: true });
  const txGet = tx.get, docGet = DocumentPrototype.get, queryGet = QueryPrototype.get;
  vi.spyOn(tx, 'get').mockImplementation(function (this: unknown, target: unknown) {
    if (isDocumentReference(target)) docs.push(target.path); else queries++;
    return txGet.call(this, target);
  });
  vi.spyOn(DocumentPrototype, 'get').mockImplementation(function (this: DocumentReference) { docs.push(this.path); return docGet.call(this); });
  vi.spyOn(QueryPrototype, 'get').mockImplementation(function (this: Query) { queries++; return queryGet.call(this); });
});
afterEach(() => vi.restoreAllMocks());

async function running() {
  const f = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }], agents: [{ person: 0, name: 'alice-fox' }] });
  const agent = f.agents[0].agentId;
  const run = await scope(() => startRun(agent, { clientRunId: randomUUID(), runnerVersion: 'test', takeover: false }, now));
  docs = []; queries = 0;
  return { agent, token: f.agents[0].token, runId: run.run_id, person: f.personIds[0] };
}
const reads = (suffix: string) => docs.filter(path => path.endsWith(suffix)).length;

test('the run fence reads the run once and skips the work signal routes discard; the full check reads each source once', async () => {
  const a = await running();
  await scope(() => assertRunCurrent(a.agent, a.runId, now));
  expect(reads(`runs/${a.agent}`)).toBe(1);
  expect(docs.some(path => path.includes('workIntentControl'))).toBe(false);
  expect(queries).toBe(0);
  docs = []; queries = 0;
  expect(await scope(() => assertCurrentRun(a.agent, a.runId, now))).toMatchObject({ revision: expect.any(Number), runnable: expect.any(Boolean) });
  expect(reads(`runs/${a.agent}`)).toBe(1);
  expect(reads('workIntentControl/main')).toBe(1);
});

test('token authentication reads the agent document once, through its lookup, and still refuses revoked agents', async () => {
  const a = await running();
  expect(await scope(() => agentByToken(a.token))).toMatchObject({ id: a.agent });
  expect(reads(`agents/${a.agent}`)).toBe(0);
  expect(queries).toBe(1);
  expect(await scope(() => agentByToken('not-a-token'))).toBeNull();
  await scope(() => db.doc(`projects/${TEST_PROJECT}/agents/${a.agent}`).update({ revokedAt: at }));
  expect(await scope(() => agentByToken(a.token))).toBeNull();
});

test('refusals keep their codes and order: missing run id, then a superseded run before a removed membership', async () => {
  const a = await running();
  for (const check of [assertRunCurrent, assertCurrentRun]) {
    await expect(scope(() => check(a.agent, undefined, now))).rejects.toMatchObject({ code: 'bad_input' });
    await expect(scope(() => check(a.agent, randomUUID(), now))).rejects.toMatchObject({ code: 'run_superseded' });
  }
  await membershipDoc(TEST_PROJECT, a.person).update({ status: 'removed' });
  for (const check of [assertRunCurrent, assertCurrentRun]) {
    await expect(scope(() => check(a.agent, a.runId, now))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(scope(() => check(a.agent, randomUUID(), now))).rejects.toMatchObject({ code: 'run_superseded' });
  }
  await scope(() => runs().doc(a.agent).update({ endedAt: at }));
  await expect(scope(() => assertRunCurrent(a.agent, a.runId, now))).rejects.toMatchObject({ code: 'run_superseded' });
});
