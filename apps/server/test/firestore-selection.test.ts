// Which document store firestore.ts opens: the engine's SQLite file, or a disposable test session's store.
// Any other process refuses to start rather than guess a database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { db, isDocumentReference, openDatabase } from '../src/firestore.js';
import { SqliteFirestore } from '../src/storage/sqlite-firestore.js';

const folder = mkdtempSync(join(tmpdir(), 'mlswarm-store-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const close = (store: unknown) => (store as InstanceType<typeof SqliteFirestore>).close();

test('a self-hosted engine opens its SQLite file', async () => {
  const store = await openDatabase({ MLSWARM_ENGINE: 'self-hosted', MLSWARM_SQLITE_PATH: join(folder, 'engine.sqlite') });
  try {
    expect(store).toBeInstanceOf(SqliteFirestore);
    await store.doc('probe/a').set({ n: 1 });
    expect((await store.doc('probe/a').get()).data()).toEqual({ n: 1 });
  } finally { close(store); }
});

test('a self-hosted engine without an absolute database path refuses to start', async () => {
  for (const MLSWARM_SQLITE_PATH of [undefined, '', 'engine.sqlite', './data/engine.sqlite'])
    await expect(openDatabase({ MLSWARM_ENGINE: 'self-hosted', MLSWARM_SQLITE_PATH })).rejects.toThrow(/MLSWARM_SQLITE_PATH/);
});

test('a process that is neither the engine nor a test session opens no database', async () => {
  const file = join(folder, 'never.sqlite');
  for (const env of [
    {}, { MLSWARM_ENGINE: 'selfhosted', MLSWARM_SQLITE_PATH: file }, { MLSWARM_ENGINE: '', MLSWARM_SQLITE_PATH: file },
    { GCLOUD_PROJECT: 'karma42-beta' }, { GCLOUD_PROJECT: 'demo-x', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
  ]) await expect(openDatabase(env)).rejects.toThrow(/MLSWARM_ENGINE=self-hosted/);
});

test('a disposable test session opens its own store, shared through an absolute file when named', async () => {
  const session = { NODE_ENV: 'test', MLSWARM_TEST_SESSION: 'mlswarm-tests-0123456789ab' };
  const memory = await openDatabase(session);
  try { expect(memory).toBeInstanceOf(SqliteFirestore); } finally { close(memory); }
  await expect(openDatabase({ ...session, MLSWARM_TEST_SQLITE_PATH: 'store.sqlite' })).rejects.toThrow(/MLSWARM_TEST_SQLITE_PATH/);
  const file = join(folder, 'test-store.sqlite');
  const [first, second] = [await openDatabase({ ...session, MLSWARM_TEST_SQLITE_PATH: file }), await openDatabase({ ...session, MLSWARM_TEST_SQLITE_PATH: file })];
  try {
    await first.doc('probe/shared').set({ n: 2 });
    expect((await second.doc('probe/shared').get()).data()).toEqual({ n: 2 });
  } finally { close(first); close(second); }
});

test('stored references are recognized', () => {
  const store = new SqliteFirestore();
  try {
    expect(isDocumentReference(db.doc('a/b'))).toBe(true);
    expect(isDocumentReference(store.doc('a/b'))).toBe(true);
    expect(isDocumentReference({ path: 'a/b' })).toBe(false);
  } finally { store.close(); }
});
