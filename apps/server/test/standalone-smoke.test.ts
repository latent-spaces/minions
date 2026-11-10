// Standalone engine smoke test, storage and delivery slice: with MLSWARM_ENGINE=self-hosted the server keeps its
// data in one SQLite file, and the in-process delivery worker delivers an agent message, all while the
// loopback-only guard refuses any outside connection. The launcher slice (sign-in, HTTP, restart through the CLI)
// builds on this once the standalone entry point lands. No model or outside network is used.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { installLoopbackOnlyNetwork } from '../../../tests/support/loopback-only-network.mjs';

// The guard and the environment come first: firestore.ts chooses its store when it is imported.
const guard = installLoopbackOnlyNetwork();
const dir = mkdtempSync(join(tmpdir(), 'mlswarm-standalone-'));
const file = join(dir, 'engine.sqlite');
delete process.env.MLSWARM_TEST_SESSION;
Object.assign(process.env, { MLSWARM_ENGINE: 'self-hosted', MLSWARM_SQLITE_PATH: file });

const { db, agents, inProject, profiles } = await import('../src/firestore.js');
const { deploymentKind } = await import('../src/deployment.js');
const { fixtureProjectRecords } = await import('../scripts/project-fixture.js');
const { createFanout } = await import('../src/v2/fanout.js');
const { inboxItems } = await import('../src/v2/records.js');
const { startLocalWorker } = await import('../src/v2/local-fanout.js');
const { SqliteFirestore } = await import('../src/storage/sqlite-firestore.js');

afterAll(() => { guard.uninstall(); rmSync(dir, { recursive: true, force: true }); });

const PROJECT = 'c'.repeat(64), OWNER = 'standalone-owner', RECIPIENTS = ['agent-a', 'agent-b', 'agent-c'];

test('a self-hosted engine stores in SQLite and delivers an agent message with no outside connection', async () => {
  expect(deploymentKind()).toBe('self-hosted');
  expect(db).toBeInstanceOf(SqliteFirestore);

  // Delivery reaches agents whose operator is an active person.
  await profiles.doc(OWNER).set({ name: 'Standalone owner', email: 'owner@example.test', removedAt: null } as never);
  const batch = db.batch();
  for (const { path, body } of fixtureProjectRecords(PROJECT, { ownerProfileId: OWNER,
    definition: { title: 'Standalone smoke', goal: 'Delivery without Google', beneficiaries: 'Tests', output: 'Proof',
      scope: 'Isolated', acceptanceCriteria: 'Delivered', sources: null, resources: null, mergeApproval: 'humans' },
    runtime: { revision: 1, configuredAt: 1, configuredBy: OWNER, setupFinalizedAt: 1,
      repoUrl: 'https://github.com/example/standalone', startsAt: 0, started: true, paused: false },
  })) batch.set(db.doc(path), body);
  await batch.commit();

  const sent = Date.now();
  await inProject(PROJECT, async () => {
    for (const name of RECIPIENTS) await agents().doc(name).set({ ownerProfileId: OWNER, connectionEpoch: 0, name,
      tokenHash: 'unused', tokenIssuedAt: 1, createdAt: 1, revokedAt: null } as never);
    await db.runTransaction(async tx => createFanout(tx, 'announcement', { body: 'Hello from a standalone engine' }, sent));
  });

  // The worker's first reconcile reserves the durable fanout job and its queue delivers it in process.
  const worker = startLocalWorker();
  const delivered = async () => inProject(PROJECT, async () =>
    Promise.all(RECIPIENTS.map(async name => (await inboxItems(name).get()).size)));
  try {
    for (let waited = 0; (await delivered()).some(size => size === 0) && waited < 20_000; waited += 100) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { await worker.stop(); await worker.queue.drained(); }
  expect(await delivered()).toEqual([1, 1, 1]);
  const item = await inProject(PROJECT, async () => (await inboxItems('agent-a').get()).docs[0].data());
  expect(JSON.stringify(item)).toContain('Hello from a standalone engine');

  // The data is in the file, not in memory: a fresh store on the same path reads the delivered item back.
  const inboxPath = await inProject(PROJECT, async () => (await inboxItems('agent-b').get()).docs[0].ref.path);
  (db as unknown as { close(): void }).close();
  const reopened = new SqliteFirestore(file);
  try { expect((await reopened.doc(inboxPath).get()).exists).toBe(true); } finally { reopened.close(); }

  expect(guard.refused).toEqual([]);
}, 60_000);
