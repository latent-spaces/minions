import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { lockSelfHostedStore, processGone, unlinkWhenFree } from '../src/self-hosted-lock.js';

test('one canonical database has one process lock, released once after shutdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-lock-')); chmodSync(root, 0o700);
  const file = join(root, 'db.sqlite');
  try {
    const lock = lockSelfHostedStore(file);
    expect(() => lockSelfHostedStore(file)).toThrow('locked by a running engine');
    expect(JSON.parse(readFileSync(`${file}.lock`, 'utf8')).pid).toBe(process.pid);
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
