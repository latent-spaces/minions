// One disposable session owner for tests and explicitly selected local studies: a fresh folder holding the
// session's SQLite store and media, deleted by nothing but the OS temp cleaner, and no saved-state import/export.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwnedProcess } from './owned-process-tree.mjs';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const serverRequire = createRequire(join(repository, 'apps/server/package.json'));
export const executable = (packageName, name) => {
  const manifest = serverRequire.resolve(`${packageName}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
  return resolve(dirname(manifest), typeof bin === 'string' ? bin : bin[name]);
};
export const runProcess = runOwnedProcess;

const SESSION = /^minions-(tests|benchmarks)-[a-f0-9]{12}$/;

/** Shared interlock for destructive test resets: only a disposable test session's own store may be cleared. */
export function disposableTarget(env = process.env) {
  const session = env.MINIONS_TEST_SESSION;
  if (env.NODE_ENV !== 'test' || !SESSION.test(session ?? '') || env.MINIONS_ENGINE !== undefined)
    throw new Error('Test resets require an explicitly selected disposable test session.');
  const store = env.MINIONS_TEST_SQLITE_PATH ?? ':memory:';
  if (store !== ':memory:' && !isAbsolute(store)) throw new Error('Test resets require an absolute session store path.');
  return { session, store };
}

export function testEnvironment(source = process.env) {
  // Tests need OS/runtime discovery, never inherited cloud/provider/GitHub credentials.
  const keys = ['PATH', 'HOME', 'USER', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'TERM', 'NODE_EXTRA_CA_CERTS',
    // Explicit local browser selection is test configuration, never a credential.
    'MINIONS_TEST_BROWSER_EXECUTABLE', 'MINIONS_TEST_BROWSER', 'MINIONS_HOSTING_FIXTURES_FILE'];
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

/**
 * Runs `command` (argv from the callback) in a fresh session folder. The session's processes share one SQLite
 * file there, and media under it, so a test and the API process it starts see the same documents.
 */
export async function withDisposableSession(command, { kind = 'tests', envPatch = {}, cwd } = {}) {
  if (!['tests', 'benchmarks'].includes(kind)) throw new Error('Unknown disposable study kind.');
  const env = { ...testEnvironment(), ...envPatch };
  const session = `minions-${kind}-${randomBytes(6).toString('hex')}`;
  const folder = await mkdtemp(join(tmpdir(), `minions-${kind}-`));
  Object.assign(env, { MINIONS_TEST_SESSION: session, NODE_ENV: 'test', HOST: '127.0.0.1',
    MINIONS_TEST_SQLITE_PATH: join(folder, 'test-store.sqlite'), MINIONS_BLOB_DIR: join(folder, 'media') });
  disposableTarget(env);
  const args = await command({ session, folder, env });
  env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}`;
  console.info(`Disposable ${kind}: ${session}; diagnostics: ${folder}. No models or saved-state import/export.`);
  return runProcess(args[0], args.slice(1), { cwd: cwd ?? folder, env });
}
