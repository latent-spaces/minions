import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeferredSends } from '../runtime/project-operations.mjs';

const send = { to: ['agent-1'], body: 'hello', client_message_id: 'msg-1' };

test('deferred send journal saves on Windows, where a directory cannot be opened for fsync', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-deferred-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const openSync = fs.openSync;
  t.after(async () => {
    Object.defineProperty(process, 'platform', platform);
    fs.openSync = openSync; syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fs.openSync = (path, ...rest) => {
    if (fs.statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), { code: 'EPERM' });
    return openSync(path, ...rest);
  };
  syncBuiltinESMExports();
  const file = join(root, 'deferred.json');
  const journal = new DeferredSends(file, 'identity');
  const { entry } = journal.add(send);
  journal.complete(entry, 'delivered', 'accepted');
  assert.deepEqual(new DeferredSends(file, 'identity').data.pending, []);
  assert.deepEqual(fs.readdirSync(root), ['deferred.json']);
});

test('deferred send journal retries a rename briefly blocked on Windows', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-deferred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A fresh process sees win32 before state.mjs reads the platform at import.
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { renameSync, openSync } = fs; let blocked = 2;
    fs.renameSync = (...args) => { if (blocked-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return renameSync(...args); };
    fs.openSync = (path, ...rest) => { if (fs.statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return openSync(path, ...rest); };
    syncBuiltinESMExports();
    const { DeferredSends } = await import(${JSON.stringify(new URL('../runtime/project-operations.mjs', import.meta.url).href)});
    new DeferredSends(process.argv[1], 'identity').add(${JSON.stringify(send)});
    if (blocked !== -1) throw new Error('rename was not retried');`;
  const file = join(root, 'deferred.json');
  execFileSync(process.execPath, ['--input-type=module', '-e', script, file], { stdio: 'pipe' });
  assert.equal(new DeferredSends(file, 'identity').data.pending[0].id, 'msg-1');
});

test('deferred send journal survives a restart with its pending send', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-deferred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'deferred.json');
  new DeferredSends(file, 'identity').add(send);
  const [entry] = new DeferredSends(file, 'identity').data.pending;
  assert.equal(entry.id, 'msg-1');
  assert.equal(entry.deferred, true);
});


test('steering replies preserve empty recipients and full thread IDs across retries and restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-steering-send-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'deferred.json');
  const thread_id = `steer_${'a'.repeat(64)}_12345678-1234-4123-8123-123456789012`;
  assert.equal(thread_id.length, 107);
  const reply = { to: [], thread_id, body: 'Applied the steering change.', client_message_id: 'steering-reply' };
  const journal = new DeferredSends(file, 'identity');
  assert.deepEqual(journal.add(reply).entry.args, reply);
  assert.equal(journal.add(reply).existing, true);
  assert.throws(() => journal.add({ ...reply, body: 'Different reply' }), /different content/);
  const reopened = new DeferredSends(file, 'identity');
  assert.deepEqual(reopened.data.pending[0].args, reply);
  assert.equal(reopened.data.pending[0].deferred, true);
  assert.equal(reopened.add({ ...reply, thread_id: 't'.repeat(200), client_message_id: 'max-thread' }).existing, false);
  for (const invalid of [{ to: [], body: 'No thread', client_message_id: 'missing' },
    { ...reply, thread_id: 't'.repeat(201), client_message_id: 'long' },
    { ...reply, thread_id: 'thread/other', client_message_id: 'path' }]) {
    assert.throws(() => reopened.add(invalid), /Invalid deferred send arguments/);
  }
});
