import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { lockSelfHostedStore } from '../src/self-hosted-lock.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'engine recovery '))); folders.push(folder);
  const file = join(folder, 'engine.sqlite'), lock = `${file}.lock`, recovery = `${lock}.recovery`;
  const stale = JSON.stringify({ pid: process.pid + 1_000_000, nonce: randomUUID(), createdAt: Date.now() });
  writeFileSync(lock, stale, { mode: 0o600 });
  return { file, lock, recovery, stale };
}

test('two stale-lock recoverers cannot both obtain ownership', () => {
  const f = fixture();
  let competitor: ReturnType<typeof lockSelfHostedStore> | undefined, refused: unknown;
  // Interleave a second starter after the first read the stale owner but before it unlinks the lock.
  const owner = lockSelfHostedStore(f.file, () => {
    try { competitor = lockSelfHostedStore(f.file, () => true); } catch (error) { refused = error; }
    return true;
  });
  expect(competitor).toBeUndefined();
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain(f.recovery);
  expect(JSON.parse(readFileSync(f.lock, 'utf8')).pid).toBe(process.pid);
  expect(existsSync(f.recovery)).toBe(false);
  owner.release();
  expect(existsSync(f.lock)).toBe(false);
});

test('recovery preserves a replacement lock instead of unlinking another owner', () => {
  const f = fixture(), replacement = JSON.stringify({ pid: process.pid, nonce: randomUUID(), createdAt: Date.now() });
  expect(() => lockSelfHostedStore(f.file, () => {
    rmSync(f.lock); writeFileSync(f.lock, replacement, { mode: 0o600 });
    return true;
  })).toThrow(/changed/);
  expect(readFileSync(f.lock, 'utf8')).toBe(replacement);
  expect(existsSync(f.recovery)).toBe(false);
});

test('an existing recovery guard is preserved and blocks automatic recovery', () => {
  const f = fixture(), guard = JSON.stringify({ pid: process.pid + 1_000_000, nonce: randomUUID(), createdAt: 1 });
  writeFileSync(f.recovery, guard, { mode: 0o600 });
  expect(() => lockSelfHostedStore(f.file, () => true)).toThrow(f.recovery);
  expect(readFileSync(f.recovery, 'utf8')).toBe(guard);
  expect(readFileSync(f.lock, 'utf8')).toBe(f.stale);
});

test('a live owner is preserved and releases the temporary recovery guard', () => {
  const f = fixture(); rmSync(f.lock);
  const owner = lockSelfHostedStore(f.file), before = readFileSync(f.lock, 'utf8');
  expect(() => lockSelfHostedStore(f.file)).toThrow(/existing lock/);
  expect(readFileSync(f.lock, 'utf8')).toBe(before);
  expect(existsSync(f.recovery)).toBe(false);
  owner.release();
});

test('cleanup preserves a recovery guard that changed ownership', () => {
  const f = fixture(), replacement = JSON.stringify({ pid: process.pid, nonce: randomUUID(), createdAt: Date.now() });
  expect(() => lockSelfHostedStore(f.file, () => {
    rmSync(f.recovery); writeFileSync(f.recovery, replacement, { mode: 0o600 });
    return false;
  })).toThrow(/recovery guard changed/);
  expect(readFileSync(f.recovery, 'utf8')).toBe(replacement);
  expect(readFileSync(f.lock, 'utf8')).toBe(f.stale);
});

test('an old timestamp cannot authorize recovery when the owner may still be alive', () => {
  const f = fixture();
  const original = JSON.stringify({ pid: process.pid + 1_000_000, nonce: randomUUID(), createdAt: 1 });
  writeFileSync(f.lock, original);
  expect(() => lockSelfHostedStore(f.file, () => false)).toThrow(/existing lock/);
  expect(readFileSync(f.lock, 'utf8')).toBe(original);
  expect(existsSync(f.recovery)).toBe(false);
});

test('a legacy lock without a timestamp is recovered when its real owner process has exited', () => {
  const f = fixture(), child = spawnSync(process.execPath, ['-e', '']);
  expect(child.status).toBe(0);
  writeFileSync(f.lock, JSON.stringify({ pid: child.pid, nonce: randomUUID() }));
  const owner = lockSelfHostedStore(f.file);
  expect(JSON.parse(readFileSync(f.lock, 'utf8')).pid).toBe(process.pid);
  owner.release();
  expect(existsSync(f.lock)).toBe(false);
});

test('a forward wall-clock change preserves a real live owner lock', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const original = JSON.stringify({ pid: child.pid, nonce: randomUUID(), createdAt: Date.now() });
    writeFileSync(f.lock, original);
    // Move the inferred boot time beyond the lock timestamp without changing the OS clock.
    clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + uptime() * 1000 + 6 * 60_000);
    expect(() => lockSelfHostedStore(f.file)).toThrow(/existing lock/);
    expect(readFileSync(f.lock, 'utf8')).toBe(original);
    expect(existsSync(f.recovery)).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    clock?.mockRestore();
    child.stdin!.end(); await exited;
  }
});
