// SQLite change listeners are process-local. Refuse a second API/worker, including an init racing startup.
// A crash or a computer restart leaves this lock behind. When the process it names no longer exists, or the computer
// has restarted since the lock was written, no engine can be using the store, so the next start replaces it (owner,
// 13 November 2026). Otherwise it refuses and names the lock file; nothing here ever signals or stops a process.
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOwnerFile, readOwnerFile, assertPrivateDataFile } from './self-hosted-files.js';

/**
 * Windows refuses to delete a file another process briefly holds open (antivirus, the indexer). Retry for about 0.6 s
 * there, so a clean stop does not leave a lock that needs manual recovery. Other platforms and errors fail at once.
 */
export function unlinkWhenFree(file: string, platform: NodeJS.Platform = process.platform, unlink: (file: string) => void = unlinkSync): void {
  for (let attempt = 0; ; attempt++) {
    try { return unlink(file); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt);
    }
  }
}

/** True only when no process has this ID. A permission refusal (EPERM) means one exists that this user cannot signal. */
export function processGone(pid: number, probe: (pid: number, signal: 0) => void = process.kill): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { probe(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** When this computer last started, in wall-clock milliseconds. */
export const bootTime = (): number => Date.now() - uptime() * 1_000;

/**
 * A restart since the lock was written. After a restart the lock's PID often belongs to an unrelated process, so the
 * PID check alone would refuse forever. The margin keeps a wall-clock adjustment from passing for a restart; a restart
 * within it is still refused, with the lock file named.
 */
const RESTART_MARGIN_MS = 5 * 60_000;
export const restartedSince = (createdAt: number, boot: number): boolean => boot > createdAt + RESTART_MARGIN_MS;

/** The lock's recorded owner, or null when the file cannot be read as one (left for the operator). */
function lockOwner(lock: string): { pid: number; createdAt: number | null } | null {
  try {
    assertPrivateDataFile(lock);
    const value = JSON.parse(readOwnerFile(lock)) as { pid?: unknown; createdAt?: unknown };
    return typeof value.pid === 'number' ? { pid: value.pid, createdAt: typeof value.createdAt === 'number' ? value.createdAt : null } : null;
  } catch { return null; }
}

/** The refusal names the lock file, so a lock no engine holds (one minions stop cannot find) can be removed by hand. */
export function lockedMessage(lock: string): string {
  return `The standalone database is locked by a running engine. Stop it first (minions stop). If minions stop finds no engine, `
    + `the lock is left over from an earlier run and is safe to delete: ${lock}`;
}

export function lockSelfHostedStore(file: string, gone: (pid: number) => boolean = processGone, boot: () => number = bootTime) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(file)), basename(file));
  const lock = `${canonical}.lock`, nonce = randomUUID();
  const create = () => createOwnerFile(lock, JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }));
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = lockOwner(lock);
    const stale = owner !== null && owner.pid !== process.pid
      && (gone(owner.pid) || (owner.createdAt !== null && restartedSince(owner.createdAt, boot())));
    if (!stale) throw new Error(lockedMessage(lock));
    // Recovery is not guarded against two starters replacing the same stale lock at once; setup starts one engine.
    unlinkWhenFree(lock); create();
  }
  const stat = lstatSync(lock);
  let released = false;
  return { file: canonical, release() {
    if (released) return;
    assertPrivateDataFile(lock);
    const current = lstatSync(lock);
    if (current.dev !== stat.dev || current.ino !== stat.ino || JSON.parse(readOwnerFile(lock)).nonce !== nonce) {
      throw new Error('The standalone lock changed; it was preserved for operator inspection.');
    }
    unlinkWhenFree(lock); released = true;
  } };
}
