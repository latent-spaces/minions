import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { lstatExists, readPrivate } from './state.mjs';

// Guards one connection or account directory while it is changed. Only a lock this guard wrote, whose
// process is confirmed gone, is recovered automatically; a connected agent's own lock is never touched.
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export function withOperationLock(dir, action) {
  const path = join(dir, 'operation.lock'), guard = join(dir, 'browser-recovery.lock');
  const create = () => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ kind: 'mlswarm-browser-operation-1', pid: process.pid, nonce: randomUUID() })); }
    finally { closeSync(fd); }
    return lstatSync(path);
  };
  let owned;
  try { owned = create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let guardFd;
    try { guardFd = openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error('Another operation is checking this connection. Retry shortly; no process was stopped.'); }
    try {
      writeFileSync(guardFd, `${process.pid}\n`);
      const before = lstatSync(path), raw = readPrivate(path);
      let holder;
      try { holder = JSON.parse(raw); } catch {}
      // A connected agent holds this lock with its bare process ID for as long as its conversation keeps it connected.
      const session = /^\d+\n?$/.test(raw) ? Number(raw) : null;
      if (session && processAlive(session)) throw new Error(`This project agent is already connected in another conversation on this computer (process ${session}). Ask that conversation to disconnect it, or close it, then retry. To work in two conversations at once, add another agent in My agents. No process was stopped.`);
      if (holder?.kind !== 'mlswarm-browser-operation-1' || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || typeof holder.nonce !== 'string' || processAlive(holder.pid)) {
        throw new Error('Another operation holds this connection. Finish or cancel its setup, or disconnect its active MCP entry, before retrying. No process was stopped.');
      }
      // Guard serializes recovery attempts; reread inode/content before touching the confirmed-dead lock.
      const current = lstatSync(path);
      if (current.dev !== before.dev || current.ino !== before.ino || readPrivate(path) !== raw) throw new Error('The connection lock changed. Retry setup; no process was stopped.');
      unlinkSync(path);
      owned = create();
    } finally { closeSync(guardFd); unlinkSync(guard); }
  }
  return Promise.resolve().then(action).finally(() => {
    if (!lstatExists(path)) return;
    const current = lstatSync(path);
    if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
  });
}
