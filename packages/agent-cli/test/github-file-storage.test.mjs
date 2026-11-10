import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { EventEmitter } from 'node:events';
import { assertGitHubFileStorage, keepGitHubLoginInFile } from '../src/service/repository-access.mjs';
import { githubSignInOf } from '../src/service/web-agent-starts.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mlswarm private gh ')));
  const directory = join(root, 'gh'); fs.mkdirSync(directory, { mode: 0o700 });
  const file = join(directory, 'hosts.yml'); fs.writeFileSync(file, 'synthetic marker, never a real credential', { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, file, storage: { envSource: { GH_CONFIG_DIR: directory } } };
}
const entry = tokenSource => ({ state: 'success', active: true, host: 'github.com', login: 'synthetic-user', tokenSource });
const status = value => JSON.stringify({ hosts: { 'github.com': [value] } });

test('GitHub private storage uses official config precedence and can prepare a private empty config directory', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  assert.equal(assertGitHubFileStorage({ ...f.storage, requireFile: true }), f.file);
  const options = { envSource: { HOME: f.root, XDG_CONFIG_HOME: join(f.root, 'xdg') }, create: true };
  assert.equal(assertGitHubFileStorage(options), join(f.root, 'xdg', 'gh', 'hosts.yml'));
  assert.equal(fs.statSync(join(f.root, 'xdg', 'gh')).mode & 0o777, 0o700);
  assert.throws(() => assertGitHubFileStorage({ envSource: { GH_CONFIG_DIR: 'relative' } }), /private/);
});

test('POSIX rejects exposed/foreign/multilink files and symlink storage without changing them', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.chmodSync(f.file, 0o644);
  assert.throws(() => assertGitHubFileStorage(f.storage), /private/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o644);
  assert.throws(() => assertGitHubFileStorage({ ...f.storage, uid: null }), /private/, 'Missing getuid cannot relax file mode checks.');
  fs.chmodSync(f.file, 0o600);
  assert.equal(assertGitHubFileStorage({ ...f.storage, uid: null, userInfoImpl: () => ({ homedir: f.root, uid: userInfo().uid }) }), f.file);
  assert.throws(() => assertGitHubFileStorage({ ...f.storage, uid: null, userInfoImpl: () => ({ homedir: f.root, uid: userInfo().uid + 1 }) }), /private/);
  if (process.getuid) assert.throws(() => assertGitHubFileStorage({ ...f.storage, uid: () => process.getuid() + 1 }), /private/);
  const link = join(f.root, 'linked-hosts'); fs.linkSync(f.file, link);
  assert.throws(() => assertGitHubFileStorage(f.storage), /private/); fs.unlinkSync(link);
  const alias = join(f.root, 'alias'); fs.symlinkSync(f.directory, alias);
  assert.throws(() => assertGitHubFileStorage({ envSource: { GH_CONFIG_DIR: alias } }), /private/);
  fs.chmodSync(f.directory, 0o777); assert.throws(() => assertGitHubFileStorage(f.storage), /private/);
});

test('missing POSIX getuid uses native identity and missing both capabilities fails before token access or persistence', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), calls = [];
  const run = async args => { calls.push(args); return status(entry('keyring')); };
  await assert.rejects(keepGitHubLoginInFile(run, { ...f.storage, uid: null, userInfoImpl: () => { throw Error('native API missing'); } }), /ownership/);
  assert.ok(calls.every(args => args.includes('--json')));
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'synthetic marker, never a real credential');
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');process.getuid=undefined;
    import(${JSON.stringify(new URL('../src/service/repository-access.mjs', import.meta.url).href)}).then(({assertGitHubFileStorage})=>{
      try { parentPort.postMessage({path:assertGitHubFileStorage(${JSON.stringify(f.storage)})}); }
      catch(error){ parentPort.postMessage({error:error.message}); }
    });`, { eval: true });
  const answer = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  await worker.terminate();
  assert.deepEqual(answer, { path: f.file });
});

test('storage in a checkout and missing POSIX no-follow capability fail before creating or reading credential files', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), repo = join(f.root, 'repo'); fs.mkdirSync(repo, { mode: 0o700 });
  fs.writeFileSync(join(repo, '.git'), 'gitdir: synthetic-only');
  const directory = join(repo, 'gh');
  assert.throws(() => assertGitHubFileStorage({ envSource: { GH_CONFIG_DIR: directory }, create: true }), /private/);
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => assertGitHubFileStorage({ ...f.storage, fs: { ...fs, constants: { ...fs.constants, O_NOFOLLOW: undefined } } }), /private/);
  const publicParent = join(f.root, 'public'); fs.mkdirSync(publicParent, { mode: 0o777 }); fs.chmodSync(publicParent, 0o777);
  assert.throws(() => assertGitHubFileStorage({ envSource: { GH_CONFIG_DIR: join(publicParent, 'gh') }, create: true }), /private/);
  assert.equal(fs.existsSync(join(publicParent, 'gh')), false);
});

function windowsFilesystem({ alias = false, native = true } = {}) {
  const directory = 'C:\\Users\\Me\\AppData\\Roaming\\GitHub CLI', file = win32.join(directory, 'hosts.yml');
  const regular = { mode: 0o666, nlink: 1, dev: 1, ino: 2, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  const physical = value => win32.normalize(value); if (native) physical.native = physical;
  return { directory, file, fs: { constants: { O_RDONLY: 0 }, realpathSync: physical,
    lstatSync(value) {
      if (win32.basename(value) === '.git') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      if (value.toLowerCase() === file.toLowerCase()) return regular;
      return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => alias && value === directory };
    }, openSync: () => 7, fstatSync: () => regular, closeSync() {} } };
}
test('simulated Windows uses physical user-profile containment, rejects reparse/custom paths, and never substitutes POSIX mode bits', () => {
  const w = windowsFilesystem(), options = { platform: 'win32', homeDir: 'C:\\Users\\Me', envSource: { AppData: 'C:\\Users\\Me\\AppData\\Roaming' }, fs: w.fs };
  assert.equal(assertGitHubFileStorage(options), w.file, 'Native Windows files report mode666; verified profile policy is used.');
  assert.throws(() => assertGitHubFileStorage({ ...options, envSource: { GH_CONFIG_DIR: 'C:\\Shared\\gh' } }), /private/);
  assert.throws(() => assertGitHubFileStorage({ ...options, fs: windowsFilesystem({ alias: true }).fs }), /private/);
  assert.throws(() => assertGitHubFileStorage({ ...options, fs: windowsFilesystem({ native: false }).fs }), /private/);
});

test('keyring migration is account-bound, stdin-only, private and confirmed file-backed after login', async t => {
  const f = fixture(t), calls = []; let migrated = false;
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args.includes('--json')) return status(entry(migrated ? f.file : 'keyring'));
    if (args[1] === 'token') { assert.deepEqual(args.slice(-2), ['--user', 'synthetic-user']); return 'synthetic-private-token\n'; }
    if (args.includes('--with-token')) { migrated = true; return ''; }
    assert.fail('Unexpected gh call');
  };
  await keepGitHubLoginInFile(run, f.storage);
  assert.equal(calls.find(call => call.args.includes('--with-token')).input, 'synthetic-private-token');
  assert.ok(calls.every(call => !call.args.join(' ').includes('synthetic-private-token')));
  assert.equal(calls.filter(call => call.args.includes('--json')).length, 2);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('synthetic-private-token'), false);
});

test('invalid JSON status, error/timeout states, wrong account and keyring persistence never become ready', async t => {
  const f = fixture(t);
  for (const value of [{ ...entry(f.file), state: 'error' }, { ...entry(f.file), state: 'timeout' }, { ...entry(f.file), active: false }, {}]) {
    await assert.rejects(keepGitHubLoginInFile(async () => status(value), f.storage), /could not be verified/);
  }
  for (const after of [entry('keyring'), { ...entry(f.file), login: 'another-user' }]) {
    let count = 0;
    await assert.rejects(keepGitHubLoginInFile(async args => args.includes('--json') ? status(count++ ? after : entry('keyring'))
      : args[1] === 'token' ? 'synthetic-token' : '', f.storage), /could not be verified/);
  }
  await assert.rejects(keepGitHubLoginInFile(async () => 'malformed synthetic-secret', f.storage), error => !error.message.includes('synthetic-secret'));
});

test('ephemeral environment credentials remain supported without persisting them or migrating files', async () => {
  for (const source of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    let calls = 0;
    await keepGitHubLoginInFile(async args => { calls++; assert.ok(args.includes('--json')); return status(entry(source)); }, { envSource: { GH_CONFIG_DIR: '/not-safe-for-persistence' } });
    assert.equal(calls, 1);
  }
});

test('empty/multiline tokens never overwrite an existing sign-in', async t => {
  const f = fixture(t);
  for (const token of ['', 'first\nsecond', 'x'.repeat(4097)]) {
    let writes = 0;
    await assert.rejects(keepGitHubLoginInFile(async args => {
      if (args.includes('--json')) return status(entry('keyring'));
      if (args.includes('--with-token')) writes++;
      return token;
    }, f.storage), /could not be verified/);
    assert.equal(writes, 0);
  }
});

test('readiness handles an early gh stdin EPIPE without an unhandled stream error or a false ready claim', async t => {
  const f = fixture(t), calls = [];
  const executeImpl = (_command, args, options, callback) => {
    calls.push(args); assert.equal(options.env.GH_CONFIG_DIR, f.directory);
    const stdin = new EventEmitter();
    stdin.end = input => queueMicrotask(() => {
      if (args.includes('--with-token')) { assert.equal(input, 'synthetic-token'); stdin.emit('error', Object.assign(new Error('synthetic secret'), { code: 'EPIPE' })); }
      else callback(null, args.includes('--json') ? status(entry('keyring')) : 'synthetic-token');
    });
    return { stdin };
  };
  assert.equal(await githubSignInOf(undefined, { executeImpl, envSource: f.storage.envSource }), 'signed_out');
  assert.ok(calls.every(args => !args.includes('synthetic-token')));
  assert.equal(await githubSignInOf(undefined, { executeImpl: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), 'missing');
});
