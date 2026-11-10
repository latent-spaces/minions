// SQLite change listeners are process-local. Refuse a second API/worker, including an init racing startup.
// A crash leaves this lock in place; recovery is an explicit operator action after proving no engine runs.
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

export function lockSelfHostedStore(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(file)), basename(file));
  const lock = `${canonical}.lock`, nonce = randomUUID();
  try { createOwnerFile(lock, JSON.stringify({ pid: process.pid, nonce })); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The standalone database is locked. Stop its engine first. After a crash, confirm no engine is running before removing its .lock file.');
    throw error;
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
