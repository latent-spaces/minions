// SQLite change listeners are process-local. Refuse a second API/worker, including an init racing startup.
// A crash or a computer restart leaves this lock behind. Recover only when its recorded process no longer exists.
// Wall-clock timestamps cannot prove a reboot or authorize replacing a possibly live owner. Otherwise refuse and
// name the lock file for inspection; nothing here ever signals or stops a process.
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
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

type LockSnapshot = { dev: number; ino: number; contents: string };
function unchanged(file: string, snapshot: LockSnapshot): boolean {
  assertPrivateDataFile(file);
  const current = lstatSync(file);
  return current.dev === snapshot.dev && current.ino === snapshot.ino && readOwnerFile(file) === snapshot.contents;
}

/** The lock's recorded owner and identity, or null when either cannot be inspected safely. */
function lockOwner(lock: string): (LockSnapshot & { pid: number }) | null {
  try {
    assertPrivateDataFile(lock);
    const stat = lstatSync(lock), contents = readOwnerFile(lock);
    const snapshot = { dev: stat.dev, ino: stat.ino, contents };
    if (!unchanged(lock, snapshot)) return null;
    const value = JSON.parse(contents) as { pid?: unknown };
    return typeof value.pid === 'number' ? { ...snapshot, pid: value.pid } : null;
  } catch { return null; }
}

/** Serialize only stale recovery. An abandoned guard is retained rather than racing another guard's replacement. */
function recoverExclusively(lock: string, recover: () => void): void {
  const guard = `${lock}.recovery`;
  const contents = JSON.stringify({ pid: process.pid, nonce: randomUUID(), createdAt: Date.now() });
  try { createOwnerFile(guard, contents); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`Database lock recovery is already in progress. Wait and retry. If it persists, inspect the recorded PID and confirm no engine is starting or recovering this database before removing only this recovery guard: ${guard}`);
  }
  const stat = lstatSync(guard), snapshot = { dev: stat.dev, ino: stat.ino, contents };
  try { recover(); }
  finally {
    if (!unchanged(guard, snapshot)) throw new Error(`The database recovery guard changed and was preserved for inspection: ${guard}`);
    unlinkWhenFree(guard);
  }
}

/** An unreachable listener does not prove the lock's owner has finished startup or shutdown. */
export function lockedMessage(lock: string): string {
  return `The standalone database has an existing lock. Stop its engine first (minions stop). A starting or stopping engine may not answer; wait and retry. `
    + `Remove this lock only after inspecting its recorded PID and confirming in the system process list that no engine process is using this database: ${lock}`;
}

export function lockSelfHostedStore(file: string, gone: (pid: number) => boolean = processGone) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(file)), basename(file));
  const lock = `${canonical}.lock`, nonce = randomUUID();
  const create = () => createOwnerFile(lock, JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }));
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    recoverExclusively(lock, () => {
      // Read the owner only after taking the recovery guard: a previous recoverer may already have replaced it.
      const owner = lockOwner(lock);
      const stale = owner !== null && owner.pid !== process.pid && gone(owner.pid);
      if (!stale) throw new Error(lockedMessage(lock));
      if (!unchanged(lock, owner)) throw new Error(`The standalone lock changed during recovery and was preserved: ${lock}`);
      unlinkWhenFree(lock);
      try { create(); }
      catch (error) {
        // A normal starter can win the now-empty path without needing recovery.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(lockedMessage(lock));
        throw error;
      }
    });
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
