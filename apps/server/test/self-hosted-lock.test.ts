import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { lockSelfHostedStore, unlinkWhenFree } from '../src/self-hosted-lock.js';

test('one canonical database has one process lock, released once after shutdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-lock-')); chmodSync(root, 0o700);
  const file = join(root, 'db.sqlite');
  try {
    const lock = lockSelfHostedStore(file);
    expect(() => lockSelfHostedStore(file)).toThrow('locked');
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
