import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withOperationLock } from '../src/operation-lock.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'minions-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
// A process that has already exited: its PID answers ESRCH.
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const gone = path => access(path).then(() => false, () => true);

test('a lock left by an exited operation is recovered, and the new one is removed afterwards', async t => {
  const dir = await directory(t), lock = join(dir, 'operation.lock');
  for (const kind of ['minions-browser-operation-1', 'mlswarm-browser-operation-1']) {
    await writeFile(lock, JSON.stringify({ kind, pid: exitedPid(), nonce: 'n' }), { mode: 0o600 });
    const held = await withOperationLock(dir, async () => JSON.parse(await readFile(lock, 'utf8')));
    assert.equal(held.pid, process.pid, kind);
    assert.equal(await gone(lock), true);
    assert.equal(await gone(join(dir, 'browser-recovery.lock')), true);
  }
});

test('a live holder, or a lock of unknown shape, is never taken over', async t => {
  const dir = await directory(t), lock = join(dir, 'operation.lock');
  await writeFile(lock, JSON.stringify({ kind: 'minions-browser-operation-1', pid: process.pid, nonce: 'n' }), { mode: 0o600 });
  await assert.rejects(async () => withOperationLock(dir, () => {}), /Another operation holds this connection/);
  await writeFile(lock, `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(async () => withOperationLock(dir, () => {}), /already connected in another conversation/);
  await writeFile(lock, JSON.stringify({ kind: 'other', pid: exitedPid(), nonce: 'n' }), { mode: 0o600 });
  await assert.rejects(async () => withOperationLock(dir, () => {}), /Another operation holds this connection/);
  assert.equal(await gone(lock), false);
  assert.equal(await gone(join(dir, 'browser-recovery.lock')), true);
});

test('the lock is released when the action fails', async t => {
  const dir = await directory(t);
  await assert.rejects(async () => withOperationLock(dir, () => { throw new Error('boom'); }), /boom/);
  assert.equal(await gone(join(dir, 'operation.lock')), true);
  assert.equal(await withOperationLock(dir, () => 'again'), 'again');
});
