import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workerCodexProfile, workerPrivatePaths, createProvider } from '../runtime/providers.mjs';

const privatePaths = ['/synthetic/private state', '/synthetic/credentials'];

test('Codex profiles preserve workspace grants and deny every exact private path', () => {
  const profile = workerCodexProfile({ sandbox_workspace_write: { network_access: true, writable_roots: ['/synthetic/shared'], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } }, privatePaths, 'darwin');
  assert.deepEqual(profile, { extends: ':workspace', filesystem: { '/synthetic/private state': 'deny', '/synthetic/credentials': 'deny', ':slash_tmp': 'read', ':tmpdir': 'read' }, network: { enabled: true }, workspace_roots: { '/synthetic/shared': true } });
  assert.deepEqual(workerCodexProfile({ sandbox_workspace_write: null }, privatePaths, 'linux').network, { enabled: false });
  const windows = workerCodexProfile({}, ['C:\\Users\\Person\\.minions', 'D:\\Minions (private)'], 'win32');
  assert.equal(windows.filesystem['D:\\Minions (private)'], 'deny');
  assert.equal(Object.keys(windows.filesystem).some(key => key.startsWith('//')), false);
});

test('ambiguous paths and unrecognized effective permission settings fail closed', () => {
  for (const paths of [[], ['relative'], ['/private/*'], ['/private[1]'], ['/private\nstate']]) assert.throws(() => workerCodexProfile({}, paths, 'darwin'));
  for (const config of [null, [], { sandbox_workspace_write: [] }, { sandbox_workspace_write: { network_access: 'true' } }, { sandbox_workspace_write: { writable_roots: ['relative'] } }, { sandbox_workspace_write: { new_constraint: true } }]) assert.throws(() => workerCodexProfile(config, privatePaths, 'darwin'));
});

test('Codex receives canonical absolute private paths without Claude rule grammar', () => {
  const paths = workerPrivatePaths({ platform: 'win32', userHome: 'C:\\Users\\Person', stateDir: 'D:\\Minions (work)\\connector-service\\agents\\abc', folder: 'C:\\checkout', envSource: { minions_credential_home: 'E:\\credentials' }, realpath: path => path });
  assert.deepEqual(paths, ['C:\\Users\\Person\\.minions', 'D:\\Minions (work)\\connector-service', 'D:\\Minions (work)', 'E:\\credentials']);
});

test('additional writable roots cannot reopen metadata inside denied private state', t => {
  assert.throws(() => workerCodexProfile({ sandbox_workspace_write: { writable_roots: ['/synthetic/private state/nested'] } }, privatePaths, 'darwin'), /overlap/);
  assert.throws(() => workerCodexProfile({ sandbox_workspace_write: { writable_roots: ['c:\\PRIVATE\\nested'] } }, ['C:\\private'], 'win32', path => path), /overlap/);
  if (process.platform === 'win32') return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'minions-codex-write-root-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hidden = join(root, 'hidden'), alias = join(root, 'alias');
  mkdirSync(hidden); symlinkSync(hidden, alias);
  assert.throws(() => workerCodexProfile({ sandbox_workspace_write: { writable_roots: [alias] } }, [hidden]), /overlap/);
});

function collector(t, { resuming = false, nativeRuleLayer } = {}) {
  const profile = 'minions_worker_synthetic', threadId = randomUUID(), sent = [];
  let submitted = 0;
  const startParams = { cwd: '/synthetic/checkout', ...(resuming ? { threadId, excludeTurns: true } : {}) };
  const rpc = { prompt: 'Synthetic prompt', resuming, startParams, permissionProfile: profile, nativeRuleLayer,
    prepareThread: config => ({ ...startParams, permissions: profile, config: { [`permissions.${profile}`]: workerCodexProfile(config, privatePaths, 'darwin') } }) };
  const provider = createProvider('codex', {});
  const stream = provider.collector({ rpc, submitted: () => { submitted++; } });
  stream.attach({ stdin: { destroyed: false, write: line => sent.push(JSON.parse(line)), end() {} }, kill() {} });
  t.after(() => stream.cleanup());
  const reply = (id, result) => stream.line(JSON.stringify({ id, result }));
  const ready = () => { reply(1, {}); reply(4, { config: {}, ...(nativeRuleLayer ? { layers: [{ name: { type: 'project', dotCodexFolder: nativeRuleLayer } }] } : {}) }); };
  const confirmed = { thread: { id: threadId }, modelProvider: 'openai', model: 'synthetic', activePermissionProfile: { id: profile }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' };
  return { stream, sent, reply, ready, confirmed, submissions: () => submitted };
}

for (const resuming of [false, true]) {
  test(`Codex ${resuming ? 'resume' : 'start'} confirms the private profile before submitting a prompt`, t => {
    const f = collector(t, { resuming });
    assert.equal(f.sent[0].params.capabilities.experimentalApi, true);
    f.ready();
    const request = f.sent.find(value => value.id === 2);
    assert.equal(request.method, resuming ? 'thread/resume' : 'thread/start');
    assert.equal(request.params.permissions, f.confirmed.activePermissionProfile.id);
    assert.equal(request.params.sandbox, undefined);
    assert.equal(f.submissions(), 0);
    f.reply(2, f.confirmed);
    assert.equal(f.submissions(), 1);
    assert.equal(f.sent.filter(value => value.method === 'turn/start').length, 1);
  });

  test(`Codex ${resuming ? 'resume' : 'start'} refuses missing, mismatched and downgraded permissions`, t => {
    for (const replacement of [{ activePermissionProfile: null }, { activePermissionProfile: { id: ':workspace' } }, { activePermissionProfile: { id: 1 } }, { approvalPolicy: 'never' }, { approvalsReviewer: 'user' }]) {
      const f = collector(t, { resuming });
      f.ready(); f.reply(2, { ...f.confirmed, ...replacement });
      assert.equal(f.stream.failure.code, 'native_permissions_unavailable');
      assert.equal(f.submissions(), 0);
      assert.equal(f.sent.some(value => value.method === 'turn/start'), false);
    }
  });
}

test('malformed effective config stops before opening any native thread', t => {
  const f = collector(t);
  f.reply(1, {}); f.reply(4, { config: { sandbox_workspace_write: { writable_roots: 'all' } } });
  assert.equal(f.stream.failure.code, 'native_permissions_unavailable');
  assert.equal(f.sent.some(value => value.method === 'thread/start'), false);
});

test('permission setup retains the native merge-rule trust check', t => {
  const f = collector(t, { nativeRuleLayer: '/synthetic/checkout/.codex' });
  f.reply(1, {}); f.reply(4, { config: {}, layers: [{ name: { type: 'project', dotCodexFolder: '/synthetic/checkout/.codex' }, disabledReason: 'untrusted' }] });
  assert.equal(f.stream.failure.code, 'merge_policy_unavailable');
  assert.equal(f.sent.some(value => value.method === 'thread/start'), false);
});
