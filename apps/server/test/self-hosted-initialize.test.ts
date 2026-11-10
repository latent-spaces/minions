import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createOwnerFile } from '../src/self-hosted-files.js';
import { ENGINE_INITIALIZATION, initializeSelfHostedStore, readOwnerConfiguration, type InitialRow } from '../src/self-hosted-initialize.js';
import { CURRENT_STATE_CUTOVER_RECEIPT } from '../src/storage/schema.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'self-hosted-init-')); chmodSync(directory, 0o700); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const options = () => ({ signIn: 'local-owner' as const, sqlitePath: join(directory, 'engine.sqlite'), ownerFile: join(directory, 'owner.json'),
  sourceRevision: 'a'.repeat(40), owner: { name: 'Ada', email: 'ada@example.test' }, now: () => 1_800_000_000_000 });

test('explicit fresh initialization creates one normal profile and real schema evidence without returning a secret', async () => {
  const input = options();
  let rows: InitialRow[] = [], closed = 0;
  const result = await initializeSelfHostedStore(input, async file => {
    expect(file).toBe(input.sqlitePath);
    expect(readFileSync(file).length).toBe(0);
    return { createRows: async initial => { rows = initial; }, close: () => { closed++; } };
  });
  const configuration = readOwnerConfiguration(input.ownerFile);
  expect(closed).toBe(1);
  expect(result).toEqual({ profileId: configuration.profileId, initializedAt: input.now() });
  expect(JSON.stringify(result)).not.toContain(configuration.signingSecret);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toEqual({ path: `profiles/${result.profileId}`, data: { name: 'Ada', email: 'ada@example.test', removedAt: null } });
  const evidence = rows.find(row => row.path === ENGINE_INITIALIZATION)!.data;
  const receipt = rows.find(row => row.path === CURRENT_STATE_CUTOVER_RECEIPT)!.data;
  expect(evidence).toMatchObject({ kind: 'empty-self-hosted-store', initializedAt: input.now(), writerSource: input.sourceRevision,
    ownerSubject: configuration.owner.subject, ownerProfileId: result.profileId });
  expect(receipt).toMatchObject({ schema: 2, epoch: 'sequence-v1', usageEpoch: 'usage-sequence-v1', writerSource: input.sourceRevision,
    evidenceSha256: evidence.evidenceSha256, initialization: 'empty-self-hosted-store' });
  expect(evidence.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(rows)).not.toMatch(/signingSecret|adminAuthenticated|reviewerEmails|platformSettings\/ownership/);
});

test('an existing database is preserved and is never opened or initialized', async () => {
  const input = options();
  createOwnerFile(input.sqlitePath, 'existing database bytes');
  let opened = false;
  await expect(initializeSelfHostedStore(input, async () => { opened = true; throw new Error('must not open'); })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(opened).toBe(false);
  expect(readFileSync(input.sqlitePath, 'utf8')).toBe('existing database bytes');
  expect(existsSync(input.ownerFile)).toBe(false);
});

test('initialization never replaces an existing owner file', async () => {
  const input = options();
  createOwnerFile(input.ownerFile, 'existing owner bytes');
  let opened = false;
  await expect(initializeSelfHostedStore(input, async () => { opened = true; throw new Error('must not open'); })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(opened).toBe(false);
  expect(readFileSync(input.ownerFile, 'utf8')).toBe('existing owner bytes');
});

test('invalid identity or source evidence is refused before any file is created', async () => {
  const input = options();
  for (const patch of [{ sourceRevision: 'unknown' }, { owner: { name: 'Ada', email: 'invalid' } }, { owner: { name: '', email: 'ada@example.test' } }]) {
    await expect(initializeSelfHostedStore({ ...input, ...patch }, async () => { throw new Error('must not open'); })).rejects.toThrow();
    expect(existsSync(input.sqlitePath)).toBe(false);
    expect(existsSync(input.ownerFile)).toBe(false);
  }
});

test('failed initialization closes its store and reports failure without claiming completion', async () => {
  let closed = false;
  await expect(initializeSelfHostedStore(options(), async () => ({ createRows: async () => { throw new Error('transaction failed'); },
    close: () => { closed = true; } }))).rejects.toThrow('transaction failed');
  expect(closed).toBe(true);
});


test('GitHub initialization creates an invited profile without a local signing credential', async () => {
  const { ownerFile, ...input } = options();
  let rows: InitialRow[] = [];
  const result = await initializeSelfHostedStore({ ...input, signIn: 'github' }, async () => ({
    createRows: async initial => { rows = initial; }, close: () => {},
  }));
  expect(existsSync(ownerFile)).toBe(false);
  expect(rows[0].path).toBe(`profiles/${result.profileId}`);
  expect(rows[1].data).toMatchObject({ signIn: 'github', ownerSubject: null });
  expect(JSON.stringify(rows)).not.toContain('signingSecret');
});


test('fresh initialization commits into the actual persistent SQLite adapter and can be reopened', async () => {
  const { SqliteFirestore } = await import('../src/storage/sqlite-firestore.js');
  const { initializationEvidenceHash } = await import('../src/self-hosted-initialize.js');
  const input = options();
  const result = await initializeSelfHostedStore(input, async file => {
    const store = new SqliteFirestore(file);
    return { createRows: async rows => { const batch = store.batch(); for (const row of rows) batch.create(store.doc(row.path), row.data); await batch.commit(); }, close: () => store.close() };
  });
  const reopened = new SqliteFirestore(input.sqlitePath);
  try {
    const evidence = (await reopened.doc(ENGINE_INITIALIZATION).get()).data()!;
    const { evidenceSha256, ...record } = evidence;
    expect(initializationEvidenceHash(record)).toBe(evidenceSha256);
    expect((await reopened.doc(CURRENT_STATE_CUTOVER_RECEIPT).get()).data()!.evidenceSha256).toBe(evidenceSha256);
    expect((await reopened.doc(`profiles/${result.profileId}`).get()).data()).toEqual({ name: 'Ada', email: 'ada@example.test', removedAt: null });
  } finally { reopened.close(); }
});
