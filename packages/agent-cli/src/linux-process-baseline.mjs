import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome, lstatExists, readPrivate, writePrivate } from './state.mjs';

const MAX_BYTES = 256 * 1024, MAX_PROCESSES = 8192;
const FILE = 'linux-process-baseline.json';
const PID = /^[1-9][0-9]{0,9}$/, TICK = /^[0-9]{1,20}$/, BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const gone = error => error.code === 'ENOENT' || error.code === 'ESRCH';
const bootId = (root, read) => {
  const value = read(join(root, 'sys/kernel/random/boot_id'), 'utf8').trim();
  if (!BOOT.test(value)) throw new Error('Linux cleanup cannot read this boot identity.');
  return value;
};

// comm (field 2) can contain spaces and parentheses. All following fields are scalars;
// field 22 is index 19 after the final closing parenthesis, including state at index 0.
export function linuxProcessStartTick(pid, { procRoot = '/proc', read = readFileSync } = {}) {
  const value = read(join(procRoot, String(pid), 'stat'), 'utf8'), end = value.lastIndexOf(')');
  const tick = value.slice(end + 1).trim().split(/\s+/)[19];
  if (!value.startsWith(`${pid} (`) || end < 0 || !TICK.test(tick ?? '')) throw new Error('Linux cleanup cannot inspect a process identity.');
  return tick;
}
function validate(record, mark, uid) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== 'bootId,mark,processes,uid,version'
    || record.version !== 1 || record.mark !== mark || !/^[a-f0-9]{32}$/.test(record.mark)
    || record.uid !== uid || !BOOT.test(record.bootId) || !record.processes || typeof record.processes !== 'object' || Array.isArray(record.processes)
    || Object.keys(record.processes).length > MAX_PROCESSES
    || Object.entries(record.processes).some(([pid, tick]) => !PID.test(pid) || typeof tick !== 'string' || !TICK.test(tick)))
    throw new Error('Linux cleanup baseline is invalid for this mission.');
  return record;
}
export function captureLinuxProcessBaseline(mark, { procRoot = '/proc', uid = process.getuid(), read = readFileSync, stat = statSync, list = readdirSync } = {}) {
  const record = { version: 1, mark, bootId: bootId(procRoot, read), uid, processes: {} };
  let count = 0;
  for (const pid of list(procRoot).filter(name => PID.test(name))) {
    try {
      if (stat(join(procRoot, pid)).uid !== uid) continue;
      record.processes[pid] = linuxProcessStartTick(pid, { procRoot, read });
      if (++count > MAX_PROCESSES) throw new Error('Too many processes for a bounded Linux cleanup baseline.');
    } catch (error) { if (!gone(error)) throw error; }
  }
  validate(record, mark, uid);
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) throw new Error('Linux cleanup baseline exceeds its size limit.');
  return record;
}
export function readLinuxProcessBaseline(stateDir, mark) {
  const path = join(stateDir, FILE);
  try { if (lstatSync(path).size > MAX_BYTES) throw new Error('Linux cleanup baseline exceeds its size limit.'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = readPrivate(path);
  if (Buffer.byteLength(value) > MAX_BYTES) throw new Error('Linux cleanup baseline exceeds its size limit.');
  return validate(JSON.parse(value), mark, process.getuid());
}
// Capture before creating the directory: even concurrent first preparations cannot
// snapshot processes launched through that directory. Only the mkdir winner writes.
// Existing/legacy/abandoned directories never acquire a retroactive baseline.
export function prepareMissionProcessBaseline(stateDir, mark, { platform = process.platform } = {}) {
  if (platform !== 'linux') { ensureHome(stateDir); return; }
  if (lstatExists(stateDir)) { ensureHome(stateDir); readLinuxProcessBaseline(stateDir, mark); return; }
  const record = captureLinuxProcessBaseline(mark);
  let fresh = true;
  try { mkdirSync(stateDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; fresh = false; }
  ensureHome(stateDir);
  if (fresh) writePrivate(join(stateDir, FILE), record);
  else readLinuxProcessBaseline(stateDir, mark);
}
export function linuxProcessesWithEnvironment({ baseline, procRoot = '/proc', uid = process.getuid(), read = readFileSync, stat = statSync, list = readdirSync } = {}) {
  const sameBoot = baseline && baseline.uid === uid && baseline.bootId === bootId(procRoot, read);
  return list(procRoot).filter(name => PID.test(name)).flatMap(pid => {
    try {
      if (stat(join(procRoot, pid)).uid !== uid) return [];
      try { return [{ pid: Number(pid), text: read(join(procRoot, pid, 'environ'), 'utf8').replaceAll('\0', ' ') }]; }
      catch (error) {
        // This exclusion is evidence of preexistence, never authority to signal a PID.
        // Readable markers retain normal cleanup, even on a preexisting process.
        if ((error.code === 'EACCES' || error.code === 'EPERM') && sameBoot && baseline.processes[pid] !== undefined
          && linuxProcessStartTick(pid, { procRoot, read }) === baseline.processes[pid]) return [];
        throw error;
      }
    } catch (error) {
      if (gone(error)) return [];
      throw new Error(`Mission cleanup could not inspect a same-user process (PID ${pid}); shutdown is unconfirmed. Inspect that process and retry Stop.`, { cause: error });
    }
  });
}
