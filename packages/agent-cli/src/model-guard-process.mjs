// Internal process entry point. Only its private parent IPC can authorize a launch.
// It does not obtain credentials, discover work, or start another turn. The native
// client's existing allowlisted environment is preserved, without additional keys.
// A turn's guard deadline is a safety stop for one hung turn, never a job limit: at most 24 hours away,
// the same bound windows-job.cs checks.
const MAX_TURN_GUARD_MS = 24 * 60 * 60000;
import { spawn } from 'node:child_process';

let child, launched = false, stopping = false, closed = false, finishing = false, exitCode = 1, announcingNative = false, announcingClose = false;
let deadlineTimer, escalationTimer, reapTimer, deadlineAt;
const groupAlive = () => {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
const signalGroup = signal => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') exitCode = 1; }
};
function finishWhenReaped() {
  if (finishing || !closed || groupAlive() || announcingNative || announcingClose) return;
  finishing = true;
  clearTimeout(deadlineTimer); clearTimeout(escalationTimer); clearInterval(reapTimer);
  // Native close means its streams ended, not that the relayed bytes have drained.
  // Flush the final result before exiting; a disconnected/unresponsive reader must
  // not keep a guard alive forever after the native group has already been reaped.
  const flushTimeout = setTimeout(() => process.exit(1), 1000);
  process.stdout.write('', () => process.stderr.write('', () => {
    const exit = () => { clearTimeout(flushTimeout); process.exit(exitCode); };
    // The controller cannot infer descendant cleanup from an exit code: the
    // guard itself could crash. This proof is sent only after groupAlive is false.
    if (process.connected) process.send({ cleanupConfirmed: true }, exit); else exit();
  }));
}
function stop(signal = 'SIGTERM', reason = 'stopped') {
  if (stopping) return;
  stopping = true; exitCode = 1;
  if (process.connected) process.send({ guardStop: reason }, () => {});
  if (!launched) { closed = true; clearTimeout(startupTimer); finishWhenReaped(); return; }
  signalGroup(signal);
  // Independent of the controller's timers: retain ownership until the group is
  // gone, including tools that ignore graceful termination. Never kill by a saved
  // PID from a previous launch or scan/terminate unrelated processes.
  escalationTimer = setTimeout(() => signalGroup('SIGKILL'), 8000);
  reapTimer = setInterval(finishWhenReaped, 25);
  finishWhenReaped();
}
process.on('disconnect', () => stop());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));
process.stdout.on('error', () => stop()); process.stderr.on('error', () => stop());
const startupTimer = setTimeout(() => stop(), 10000);
process.on('message', message => {
  if (launched) {
    if (message?.action === 'force-stop') { stop(); signalGroup('SIGKILL'); }
    return;
  }
  clearTimeout(startupTimer);
  if (!process.connected || stopping || !message || typeof message.command !== 'string' || !message.command
      || !Array.isArray(message.args) || !message.args.every(value => typeof value === 'string')
      || !Number.isSafeInteger(message.deadline) || message.deadline <= Date.now()
      || message.deadline - Date.now() > MAX_TURN_GUARD_MS || typeof message.rpc !== 'boolean') { stop(); return; }
  launched = true;
  try {
    child = spawn(message.command, message.args, { cwd: process.cwd(), env: process.env, detached: true,
      stdio: [message.rpc ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch { closed = true; stop(); return; }
  child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
  if (message.rpc) { child.stdin.on('error', () => {}); process.stdin.pipe(child.stdin); }
  child.once('error', () => { closed = true; stop(); });
  child.once('spawn', () => {
    if (!process.connected || stopping) { stop(); return; }
    // Ownership records the guard PID; this separate observation confirms a native process exists.
    announcingNative = true;
    process.send({ nativeStarted: child.pid }, error => {
      announcingNative = false;
      if (error) stop();
      finishWhenReaped();
    });
  });
  child.once('close', (code, signal) => {
    closed = true;
    if (!stopping) exitCode = Number.isInteger(code) ? code : 1;
    // Preserve the native exit separately from the guard's cleanup outcome. This
    // private IPC contains scalar process evidence only, never stderr or config.
    if (process.connected) {
      announcingClose = true;
      process.send({ nativeClosed: { exitCode: code, signal } }, () => { announcingClose = false; finishWhenReaped(); });
    }
    // A successful client exit is not permission to leave its subprocesses alive.
    if (groupAlive()) stop();
    finishWhenReaped();
  });
  deadlineAt = message.deadline;
  deadlineTimer = setTimeout(() => stop('SIGTERM', 'deadline'), Math.max(0, deadlineAt - Date.now()));
});
