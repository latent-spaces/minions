import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const runFile = promisify(execFile);
export const MISSION_MARK = 'MINIONS_MISSION_MARK';
// Stable across service/adapter reconstruction, separate across every mission
// generation and project/owner. Never derive it from a volatile turn or PID.
export const missionMark = ({ target, missionId, generation }) => createHash('sha256').update(JSON.stringify([target.site, target.ownerId,
  target.projectId, target.agentId, missionId, generation])).digest('hex').slice(0, 32);

// Background servers a worker starts (nohup, run_in_background) leave the guard's
// process group and outlive its turn. They inherit the mission's marker, so the
// mission's end can still find them. Only the same user's processes are visible.
async function listWithEnvironment() {
  if (process.platform === 'darwin') {
    const { stdout } = await runFile('ps', ['-U', String(process.getuid()), '-E', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 * 1024 });
    return stdout.split('\n').map(line => line.match(/^\s*(\d+)\s(.*)$/)).filter(Boolean).map(([, pid, text]) => ({ pid: Number(pid), text }));
  }
  if (process.platform === 'linux') {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        if (statSync(`/proc/${name}`).uid !== process.getuid()) return [];
        return [{ pid: Number(name), text: readFileSync(`/proc/${name}/environ`, 'utf8').replaceAll('\0', ' ') }];
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return []; // Exited during enumeration.
        throw new Error('Mission cleanup could not inspect a same-user process.', { cause: error });
      }
    });
  }
  throw new Error('Mission process cleanup is unsupported on this platform.');
}

export async function markedProcesses(mark, { list = listWithEnvironment } = {}) {
  if (!/^[a-f0-9]{32}$/.test(mark)) throw new Error('Invalid mission marker.');
  const pattern = new RegExp(`(?:^|\\s)${MISSION_MARK}=${mark}(?:\\s|$)`);
  return [...new Set((await list()).filter(item => Number.isSafeInteger(item.pid) && item.pid > 0
    && item.pid !== process.pid && pattern.test(item.text)).map(item => item.pid))];
}

const signalAll = (pids, signal, kill) => {
  for (const pid of pids) {
    try { kill(pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw new Error('Mission cleanup could not signal a marked process.', { cause: error }); }
  }
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function stopMarkedProcesses(mark, { list, kill = process.kill.bind(process), graceMs = 3000, pollMs = 200, killGraceMs = 3000 } = {}) {
  for (const value of [graceMs, killGraceMs]) if (!Number.isFinite(value) || value < 0) throw new Error('Invalid cleanup timeout.');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid cleanup polling interval.');
  let pids = await markedProcesses(mark, { list });
  if (!pids.length) return { stopped: 0 };
  const found = pids.length;
  signalAll(pids, 'SIGTERM', kill);
  for (const until = Date.now() + graceMs; Date.now() < until;) {
    await wait(Math.min(pollMs, Math.max(0, until - Date.now())));
    pids = await markedProcesses(mark, { list });
    if (!pids.length) return { stopped: found };
  }
  // Re-enumerate before escalation: never signal an old PID just because it was
  // previously marked (it may now belong to an unrelated replacement process).
  pids = await markedProcesses(mark, { list });
  signalAll(pids, 'SIGKILL', kill);
  for (const until = Date.now() + killGraceMs; ; ) {
    pids = await markedProcesses(mark, { list });
    if (!pids.length) return { stopped: found };
    if (Date.now() >= until) throw new Error('Mission cleanup is unconfirmed: marked processes remain after SIGKILL.');
    signalAll(pids, 'SIGKILL', kill);
    await wait(Math.min(pollMs, Math.max(0, until - Date.now())));
  }
}
