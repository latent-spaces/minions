import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveWindowsCommand, windowsPowerShell, hostToolEnvironment, windowsHelperEnvironment } from './windows-command.mjs';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./windows-job.ps1', import.meta.url));
const jobName = mark => {
  if (!/^[a-f0-9]{32}$/.test(mark)) throw new Error('Invalid Windows mission identity.');
  return `Local\\Mlswarm-${mark}`;
};
const invocation = (mode, mark, env, pipe) => ({ command: windowsPowerShell(env), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-Mode', mode, '-JobName', jobName(mark), ...(pipe ? ['-PipeName', pipe] : [])] });

async function inspect(mode, mark, env, signal) {
  const { command, args } = invocation(mode, mark, env);
  const { stdout } = await execute(command, args, { env: windowsHelperEnvironment(hostToolEnvironment(env)), signal, windowsHide: true, timeout: 45000, maxBuffer: 8192 });
  return JSON.parse(stdout.trim());
}
// Probe the actual helper and kernel capability, not just the OS name. No model
// is launched. Do not cache a failure: installing required OS features may fix it.
const probes = new Map();
export async function probeWindowsSupervision({ env = process.env, signal } = {}) {
  signal?.throwIfAborted();
  const executable = windowsPowerShell(env);
  if (!probes.has(executable)) probes.set(executable, inspect('Probe', randomBytes(16).toString('hex'), env).then(value => {
    if (value.supported !== true) throw new Error('Windows job supervision is unavailable.');
  }).catch(error => { probes.delete(executable); throw error; }));
  await probes.get(executable);
  signal?.throwIfAborted();
}
export async function stopWindowsMission(mark, { env = process.env, signal } = {}) {
  const value = await inspect('Cleanup', mark, env, signal);
  if (value.cleanupConfirmed !== true) throw new Error('Windows mission cleanup is unconfirmed.');
  return { cleanupConfirmed: true };
}

// Match the POSIX guard's ChildProcess surface. The helper owns the job; its
// authenticated same-user named pipe carries only launch/control and scalar
// lifecycle receipts. Native stdout/stdin remain byte streams, including RPC.
export function prepareWindowsModel(options) {
  const mark = options.env?.MLSWARM_MISSION_MARK ?? randomBytes(16).toString('hex');
  const pipe = `mlswarm-${randomBytes(16).toString('hex')}`;
  const { command, args } = invocation('Run', mark, options.env, pipe);
  const child = spawn(command, args, { cwd: options.cwd, env: windowsHelperEnvironment(options.env), windowsHide: true, stdio: options.stdio });
  const guard = new EventEmitter();
  for (const name of ['pid', 'exitCode', 'signalCode', 'stdin', 'stdout', 'stderr']) Object.defineProperty(guard, name, { get: () => child[name] });
  let socket, connected = false, authorized = false, stopping = false, closed = false, retry, hardStop, pendingLaunch;
  const startedAt = Date.now();
  function send(value) { if (!socket || !connected || socket.destroyed) throw new Error('Windows worker control is unavailable.'); socket.write(JSON.stringify(value) + '\n'); }
  function stop() {
    if (closed) return false;
    stopping = true; pendingLaunch = null;
    if (connected) { try { send({ action: 'stop' }); } catch { /* fail closed through the helper's pipe EOF */ socket?.destroy(); } }
    hardStop ??= setTimeout(() => { socket?.destroy(); child.kill('SIGKILL'); }, 12000);
    return true;
  }
  guard.kill = () => stop();
  guard.authorize = (executable, argv) => {
    if (authorized || stopping || closed) throw new Error('Windows worker guard is no longer available for authorization.');
    const native = resolveWindowsCommand(executable, argv, { env: options.env, cwd: options.cwd });
    if (options.deadline <= Date.now()) throw new Error('The approved worker deadline has expired.');
    authorized = true; pendingLaunch = { ...native, deadline: options.deadline, launchByAt: options.launchByAt ?? null };
    if (connected) { send(pendingLaunch); pendingLaunch = null; }
  };
  function attach() {
    if (closed) return;
    let buffer = '';
    socket = connect(`\\\\.\\pipe\\${pipe}`);
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16384) { stop(); socket.destroy(); return; }
      for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { stop(); socket.destroy(); return; }
        if (message.ready === true && !connected) {
          connected = true;
          if (stopping) send({ action: 'stop' });
          else if (pendingLaunch) { send(pendingLaunch); pendingLaunch = null; }
        } else if ((Number.isSafeInteger(message.nativeStarted) && message.nativeStarted > 0) || message.nativeClosed || message.cleanupConfirmed === true || message.guardStop === 'deadline') guard.emit('message', message);
        else { stop(); socket.destroy(); return; }
      }
    });
    socket.on('error', error => {
      if (closed) return;
      if (!connected && ['ENOENT', 'EBUSY', 'ECONNREFUSED'].includes(error.code) && Date.now() - startedAt < 40000) retry = setTimeout(attach, 50);
      else { stop(); }
    });
    socket.on('end', () => { if (!closed && child.exitCode === null) stop(); });
  }
  child.once('spawn', () => { attach(); guard.emit('spawn'); });
  child.once('error', error => guard.emit('error', error));
  child.once('close', (code, signal) => {
    closed = true; clearTimeout(retry); clearTimeout(hardStop);
    // Drain final pipe receipts before emitting close, so a clean result cannot
    // race the native stdout close notification.
    let finished = false;
    const finish = () => { if (finished) return; finished = true; socket?.destroy(); guard.emit('close', code, signal); };
    if (socket && !socket.destroyed) { const timer = setTimeout(finish, 1000); socket.once('close', () => { clearTimeout(timer); finish(); }); }
    else finish();
  });
  return guard;
}
