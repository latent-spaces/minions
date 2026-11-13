import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { lockSelfHostedStore, processGone, restartedSince, unlinkWhenFree } from '../src/self-hosted-lock.js';

test('one canonical database has one process lock, released once after shutdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-lock-')); chmodSync(root, 0o700);
  const file = join(root, 'db.sqlite');
  try {
    const lock = lockSelfHostedStore(file);
    expect(() => lockSelfHostedStore(file)).toThrow('locked by a running engine');
    expect(JSON.parse(readFileSync(`${file}.lock`, 'utf8'))).toMatchObject({ pid: process.pid, createdAt: expect.any(Number) });
    lock.release(); lock.release(); expect(existsSync(`${file}.lock`)).toBe(false);
    lockSelfHostedStore(file).release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releasing on Windows retries while another process briefly holds the lock open, then gives up', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });
  let calls = 0;
  unlinkWhenFree('db.sqlite.lock', 'win32', () => { if (++calls < 3) throw busy('EBUSY'); });
  expect(calls).toBe(3);
  calls = 0;
  expect(() => unlinkWhenFree('db.sqlite.lock', 'win32', () => { calls++; throw busy('EPERM'); })).toThrow('EPERM');
  expect(calls).toBe(6);
  // Other platforms and other errors are not retried.
  for (const [platform, code] of [['darwin', 'EBUSY'], ['win32', 'ENOENT']] as const) {
    calls = 0;
    expect(() => unlinkWhenFree('db.sqlite.lock', platform, () => { calls++; throw busy(code); })).toThrow(code);
    expect(calls).toBe(1);
  }
});

test('a lock left by a process that no longer exists is replaced; a living or unreadable owner still refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-lock-')); chmodSync(root, 0o700);
  const file = join(root, 'db.sqlite');
  try {
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999_999, nonce: 'crashed' }), { mode: 0o600 });
    expect(() => lockSelfHostedStore(file, () => false)).toThrow('locked by a running engine');
    const lock = lockSelfHostedStore(file, pid => pid === 999_999);
    expect(JSON.parse(readFileSync(`${file}.lock`, 'utf8')).pid).toBe(process.pid);
    lock.release();
    writeFileSync(`${file}.lock`, 'not json', { mode: 0o600 });
    expect(() => lockSelfHostedStore(file, () => true)).toThrow('locked by a running engine');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only "no such process" counts as gone; a permission refusal means the process exists', () => {
  const failing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  expect(processGone(42, failing('ESRCH'))).toBe(true);
  expect(processGone(42, failing('EPERM'))).toBe(false);
  expect(processGone(42, () => {})).toBe(false);
  expect(processGone(0, failing('ESRCH'))).toBe(false);
  expect(processGone(process.pid)).toBe(false);
});

test('a lock written before the computer last started is replaced even when its process ID is in use again', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-lock-')); chmodSync(root, 0o700);
  const file = join(root, 'db.sqlite'), lockFile = `${file}.lock`;
  const written = Date.now() - 3_600_000, reused = () => false;
  try {
    // The computer started after the lock was written: its PID now names an unrelated process, which is left alone.
    writeFileSync(lockFile, JSON.stringify({ pid: 999_999, nonce: 'before-restart', createdAt: written }), { mode: 0o600 });
    const lock = lockSelfHostedStore(file, reused, () => written + 600_000);
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).nonce).not.toBe('before-restart');
    lock.release();
    // No restart since, a restart within the margin, or an older lock without a time: refused, naming the lock file.
    for (const [content, booted] of [[{ createdAt: written }, written - 3_600_000], [{ createdAt: written }, written + 60_000], [{}, written + 600_000]] as const) {
      writeFileSync(lockFile, JSON.stringify({ pid: 999_999, nonce: 'live', ...content }), { mode: 0o600 });
      expect(() => lockSelfHostedStore(file, reused, () => booted)).toThrow(`safe to delete: ${join(realpathSync(root), 'db.sqlite.lock')}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only a start well after the lock was written counts as a restart', () => {
  expect(restartedSince(1_000_000, 1_000_000 + 5 * 60_000 + 1)).toBe(true);
  expect(restartedSince(1_000_000, 1_000_000 + 5 * 60_000)).toBe(false);
  expect(restartedSince(1_000_000, 900_000)).toBe(false);
});
