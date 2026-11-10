import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareWindowsModel } from './windows-supervision.mjs';

// The returned ChildProcess is the guard, whose lifetime includes native cleanup.
// Its streams relay the native protocol unchanged. Ownership records this PID so
// another controller cannot acquire the checkout during cleanup after a crash.
export function prepareSupervisedModel(options) {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('Independent worker process supervision requires macOS, Linux or Windows.');
  if (!Number.isSafeInteger(options.deadline) || options.deadline <= Date.now()) throw new Error('The approved worker deadline has expired.');
  if (process.platform === 'win32') return prepareWindowsModel(options);
  const guard = spawn(process.execPath, [fileURLToPath(new URL('./model-guard-process.mjs', import.meta.url))], {
    cwd: options.cwd, env: options.env, detached: true, windowsHide: true,
    stdio: [options.stdio[0], 'pipe', 'pipe', 'ipc'],
  });
  let launched = false, authorized = false, spawned = false;
  guard.once('spawn', () => { spawned = true; });
  guard.authorize = (command, args) => {
    if (authorized) throw new Error('Worker guard was already authorized.');
    if (typeof command !== 'string' || !command || !Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('Invalid worker command.');
    if (options.deadline <= Date.now() || guard.exitCode !== null || guard.signalCode !== null) throw new Error('Worker guard is no longer available.');
    authorized = true;
    const launch = () => {
      if (!guard.connected) return;
      launched = true;
      guard.send({ command, args, deadline: options.deadline, rpc: options.stdio[0] === 'pipe' }, error => {
        if (error) guard.kill('SIGTERM');
      });
    };
    if (spawned) launch(); else guard.once('spawn', launch);
  };
  const killGuard = guard.kill.bind(guard);
  // Provider shutdown can request SIGKILL. Force the native group through IPC,
  // retaining the guard (and checkout ownership) until that group is reaped.
  guard.kill = signal => {
    if (signal !== 'SIGKILL') return killGuard(signal);
    if (!guard.connected) return killGuard('SIGTERM');
    guard.send({ action: 'force-stop' }, error => { if (error) killGuard('SIGTERM'); });
    return true;
  };
  return guard;
}
