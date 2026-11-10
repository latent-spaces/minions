// Disposable launchers own only the child they spawn and that child's process tree.
// POSIX children get a new process group. Windows taskkill targets the spawned PID,
// never an image name, port, executable search or another session's processes.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const TREE_MEMBER = 'MLSWARM_DISPOSABLE_TREE_MEMBER';
export function windowsTaskkillPath(env = process.env, exists = existsSync) {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (typeof root !== 'string' || !win32.isAbsolute(root)) throw new Error('Owned Windows process cleanup requires an absolute SystemRoot.');
  const executable = win32.join(root, 'System32', 'taskkill.exe');
  if (!exists(executable)) throw new Error('Owned Windows process cleanup requires System32/taskkill.exe.');
  return executable;
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await pause(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function taskkill(executable, pid, force, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned Windows process cleanup timed out.')); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
}

/** Spawn one shell-free command and forward interruption to its owned tree.
 * Windows taskkill must run while the root is alive: it cannot reclaim arbitrary
 * orphaned descendants after an unrelated root crash (that requires Job Objects).
 * POSIX also cleans surviving group members after a normal/nonzero root exit.
 * Nested disposable launchers stay inside that root's group, so force escalation
 * at the outer Firebase owner also contains the bridge and test descendants.
 * Detached descendants deliberately leaving a POSIX group are outside this contract.
 */
export async function runOwnedProcess(command, args, options = {}, { graceMs = 2000, forceMs = 2000 } = {}) {
  if (![graceMs, forceMs].every(value => Number.isInteger(value) && value > 0 && value <= 10_000)) throw new Error('Owned process shutdown deadlines must be bounded.');
  const { signal, shell, detached, ...settings } = options;
  if (shell || detached) throw new Error('Disposable commands must use the owned shell-free process tree.');
  if (signal?.aborted) return 130;
  const windows = process.platform === 'win32';
  const cleanupExecutable = windows ? windowsTaskkillPath(settings.env ?? process.env) : null;
  if (!windows && typeof process.kill !== 'function') throw new Error('Owned POSIX process cleanup requires process-group signals.');
  const ownsGroup = !windows && process.env[TREE_MEMBER] !== '1';
  const child = spawn(command, args, { stdio: 'inherit', ...settings,
    env: { ...(settings.env ?? process.env), [TREE_MEMBER]: '1' }, shell: false, detached: ownsGroup });
  let stopping, interrupted;
  const running = () => child.exitCode === null && child.signalCode === null;
  const groupExists = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const groupSignal = value => {
    try { process.kill(-child.pid, value); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const cleanup = async (first = 'SIGTERM') => {
    if (!child.pid) return;
    if (windows) {
      if (!running()) return;
      // Keep the root alive until taskkill has enumerated its descendants. Do not
      // kill the root with ChildProcess.kill before /T can inspect the tree.
      // A refused/timed-out graceful request still gets one bounded force attempt.
      try { await taskkill(cleanupExecutable, child.pid, false, forceMs); } catch { /* escalate below */ }
      if (await until(() => !running(), graceMs)) return;
      await taskkill(cleanupExecutable, child.pid, true, forceMs);
      if (!await until(() => !running(), forceMs)) throw new Error('Owned Windows process tree did not stop.');
      return;
    }
    if (!ownsGroup) {
      // The enclosing disposable owner signals the entire group. A nested owner
      // may signal its own child, but must never signal a group containing itself.
      if (!running()) return;
      child.kill(first);
      if (await until(() => !running(), graceMs)) return;
      child.kill('SIGKILL');
      if (!await until(() => !running(), forceMs)) throw new Error('Owned nested process did not stop.');
      return;
    }
    if (!groupExists()) return;
    groupSignal(first);
    if (await until(() => !groupExists(), graceMs)) return;
    groupSignal('SIGKILL');
    // A successful group SIGKILL targets every remaining member. Wait for our
    // child to be reaped; do not keep probing a group after killing its leader
    // (on macOS an exiting group can briefly answer kill(-pgid, 0) with EPERM).
    // Permission failures from either actual signal remain hard errors.
    if (!await until(() => !running(), forceMs)) throw new Error('Owned POSIX process did not stop.');
  };
  let rejectStop;
  const stopFailed = new Promise((_resolve, reject) => { rejectStop = reject; });
  const stop = code => {
    interrupted ??= code;
    stopping ??= cleanup('SIGINT');
    // Attach immediately while the child exit and cleanup are awaited together.
    stopping.catch(rejectStop);
  };
  const interrupt = () => stop(130), terminate = () => stop(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  signal?.addEventListener('abort', interrupt, { once: true });
  try {
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, termination) => resolve(code ?? (termination === 'SIGINT' ? 130 : 1)));
      if (signal?.aborted) interrupt();
    });
    const result = await Promise.race([exited, stopFailed]);
    await (stopping ?? cleanup());
    return interrupted ?? result;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    signal?.removeEventListener('abort', interrupt);
  }
}
