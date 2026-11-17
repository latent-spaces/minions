import { readdirSync, statSync, unlinkSync, readFileSync, lstatSync, opendirSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { userInfo } from 'node:os';
import { join, isAbsolute, basename, resolve, dirname, win32 } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ensureHome, readPrivate, writePrivate, assertStateOutsideWorkspace, pathInside, physicalPath } from './state.mjs';

// This is deliberately independent of --state-dir and HOME overrides. All connector
// processes for the same OS user arbitrate in one private, local filesystem registry.
const checkoutOwnershipHome = () => join(userInfo().homedir, '.minions', 'worker-ownership');
let machineIdentity;
// Raw OS machine identifier, or undefined when this platform cannot provide one.
export function readMachineId(platform = process.platform, run = execFileSync, read = readFileSync) {
  if (platform === 'linux') return read('/etc/machine-id', 'utf8').trim();
  if (platform === 'darwin') return run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 2000 }).match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i)?.[1];
  if (platform === 'win32') {
    const reg = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    return run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]{36})/i)?.[1];
  }
}
function machine() {
  if (machineIdentity !== undefined) return machineIdentity;
  let value;
  try { value = readMachineId(); } catch {} // Identity uncertainty disables automatic stale recovery.
  machineIdentity = value && /^[a-f0-9-]{32,36}$/i.test(value) ? createHash('sha256').update(value).digest('hex') : null;
  return machineIdentity;
}
const absent = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; } // EPERM/unknown/live/reused PID: retain.
};
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
const confirmedAbsent = owner => Boolean(machine()) && owner.machine === machine() && absent(owner.pid);
const names = (root, prefix) => readdirSync(root).filter(name => new RegExp(`^${prefix}-[a-f0-9-]{36}\\.json$`).test(name));
const read = (root, name) => {
  try {
    const value = readPrivate(join(root, name), true);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An ownership record must be an object.');
    return value;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Worker ownership cannot inspect ${join(root, name)}. Restore the private record before retrying; no existing worker was stopped.`); }
};
const overlap = (left, right) => pathInside(left, right) || pathInside(right, left);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Lamport bakery arbitration: publish choosing before observing tickets, then wait
// for lower (number, UUID) tickets. Atomic rename keeps choosing/ticket states whole.
// Dead participants are ignored, not removed: stale-mutex deletion cannot accidentally
// remove a replacement owner's lock. Transactions contain only synchronous file I/O.
async function transaction(root, action) {
  const id = randomUUID(), name = `ticket-${id}.json`, path = join(root, name);
  const participant = { schema: 1, pid: process.pid, machine: machine(), choosing: true, number: 0, createdAt: Date.now() };
  writePrivate(path, participant);
  const tickets = () => names(root, 'ticket').map(name => {
    const ticket = read(root, name); if (!ticket) return null;
    if (ticket.schema !== 1 || !validPid(ticket.pid) || typeof ticket.choosing !== 'boolean' || !Number.isSafeInteger(ticket.number) || ticket.number < 0) throw new Error(`Worker ownership has an uncertain arbitration record: ${join(root, name)}. No ownership was changed.`);
    return { name, ...ticket };
  }).filter(Boolean);
  try {
    participant.number = 1 + Math.max(0, ...tickets().filter(ticket => !confirmedAbsent(ticket)).map(ticket => ticket.number));
    if (!Number.isSafeInteger(participant.number)) throw new Error('Worker ownership arbitration needs inspection before another worker can start.');
    participant.choosing = false; writePrivate(path, participant);
    const until = Date.now() + 3000;
    while (true) {
      const blocker = tickets().find(ticket => ticket.name !== name && !confirmedAbsent(ticket) && (ticket.choosing || ticket.number < participant.number || (ticket.number === participant.number && ticket.name < name)));
      if (!blocker) return action();
      if (Date.now() >= until) throw new Error(`Worker ownership is busy in connector process ${blocker.pid}. Retry after its current start/stop operation finishes. If that process is no longer running, remove ${join(root, blocker.name)} and retry. No worker was stopped.`);
      await pause(10);
    }
  } finally { unlinkSync(path); }
}

function validateClaim(claim, path) {
  if (!claim || typeof claim !== 'object' || claim.schema !== 2 || typeof claim.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(claim.id) || basename(path) !== `claim-${claim.id}.json`
      || !validPid(claim.pid) || !(claim.machine === null || (typeof claim.machine === 'string' && /^[a-f0-9]{64}$/.test(claim.machine)))
      || !Number.isSafeInteger(claim.createdAt) || claim.createdAt < 0
      || !['agentId', 'project'].every(key => claim[key] === null || typeof claim[key] === 'string')
      || typeof claim.folder !== 'string' || !isAbsolute(claim.folder)
      || !['guardPid', 'nativePid'].every(key => claim[key] === null || validPid(claim[key]))
      || !['idle', 'spawning', 'running'].includes(claim.phase)
      || (claim.phase === 'idle' && (claim.guardPid !== null || claim.nativePid !== null))
      || (claim.phase === 'spawning' && claim.nativePid !== null)
      || (claim.phase === 'running' && (!validPid(claim.guardPid) || !validPid(claim.nativePid)))) {
    throw new Error(`Worker ownership has an uncertain checkout record: ${path}. Inspect it before retrying; no existing worker was stopped.`);
  }
}

// Inspection never enters the arbitration transaction: even a missing registry
// must remain missing. Observations grant no cleanup, takeover or replay authority.
export function inspectWorkerCheckout({ folder, agentId, project, registryRoot = checkoutOwnershipHome() }) {
  const result = { status: 'observed', complete: true, exactClaims: [], overlappingOtherClaims: 0, invalidRecords: 0, reasons: [] };
  const uncertain = reason => { result.status = 'uncertain'; result.complete = false; if (!result.reasons.includes(reason)) result.reasons.push(reason); };
  let checkout, root, registryStat;
  const privateOwned = stat => (process.platform === 'win32' || (stat.uid === process.getuid() && !(stat.mode & 0o077)));
  try {
    if (typeof folder !== 'string' || !isAbsolute(folder) || typeof agentId !== 'string' || typeof project !== 'string') throw new Error();
    checkout = physicalPath(folder);
    if (!statSync(checkout).isDirectory()) throw new Error();
  } catch { uncertain('checkout_unavailable'); return result; }
  try {
    if (typeof registryRoot !== 'string' || !isAbsolute(registryRoot)) throw new Error();
    // Claims are written under the registry's physical path, so its parents resolve the
    // same way here (/tmp on macOS, /home on Fedora Atomic are links). Then refuse
    // symlinks anywhere in that spelling, including the registry itself.
    root = join(physicalPath(dirname(resolve(registryRoot))), basename(resolve(registryRoot)));
    let part = root;
    while (true) {
      if (lstatSync(part).isSymbolicLink()) throw new Error();
      const parent = dirname(part); if (part === parent) break; part = parent;
    }
    registryStat = lstatSync(root);
    if (!registryStat.isDirectory() || !privateOwned(registryStat) || overlap(checkout, root)) throw new Error();
  } catch (error) {
    if (error.code === 'ENOENT') result.status = 'missing';
    else uncertain('registry_unsafe_or_unavailable');
    return result;
  }
  const sameRegistry = () => {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwned(stat) || stat.dev !== registryStat.dev || stat.ino !== registryStat.ino) throw new Error();
  };
  const processObservation = (pid, ownerMachine) => {
    if (pid === null) return 'not_recorded';
    if (!machine() || ownerMachine !== machine()) return 'unknown';
    try { process.kill(pid, 0); return 'present'; }
    catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
  };
  let dir;
  try {
    sameRegistry(); dir = opendirSync(root);
    for (let scanned = 0; ; scanned++) {
      const entry = dir.readSync(); if (!entry) break;
      if (scanned >= 512) { uncertain('registry_scan_incomplete'); break; }
      if (!entry.name.startsWith('claim-')) continue;
      let fd;
      try {
        if (!/^claim-[a-f0-9-]{36}\.json$/.test(entry.name)) throw new Error();
        sameRegistry();
        const path = join(root, entry.name), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || !privateOwned(stat) || stat.nlink !== 1 || stat.size > 65536) throw new Error();
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        if (!opened.isFile() || !privateOwned(opened) || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 65536) throw new Error();
        const bytes = Buffer.alloc(65537); let count = 0, length;
        while (count < bytes.length && (length = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += length;
        if (count > 65536) throw new Error();
        const claim = JSON.parse(bytes.subarray(0, count).toString('utf8'));
        validateClaim(claim, path);
        if (!overlap(checkout, claim.folder)) continue;
        if (claim.agentId !== agentId || claim.project !== project) { result.overlappingOtherClaims++; continue; }
        result.exactClaims.push({ id: claim.id, phase: claim.phase, createdAt: claim.createdAt,
          owner: processObservation(claim.pid, claim.machine), guard: processObservation(claim.guardPid, claim.machine), native: processObservation(claim.nativePid, claim.machine),
          cleanup: claim.phase === 'idle' ? 'idle_recorded' : 'unconfirmed' });
      } catch { result.invalidRecords++; uncertain('claim_record_uncertain'); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    sameRegistry();
  } catch { uncertain('registry_read_failed'); }
  finally { dir?.closeSync(); }
  return result;
}

export async function claimWorkerCheckout({ folder, agentId, project, registryRoot = checkoutOwnershipHome() }) {
  const checkout = physicalPath(folder);
  if (!statSync(checkout).isDirectory()) throw new Error('Worker checkout must be an existing directory.');
  ensureHome(registryRoot); const root = physicalPath(registryRoot);
  assertStateOutsideWorkspace(root, checkout);
  const id = randomUUID(), path = join(root, `claim-${id}.json`);
  const claim = { schema: 2, id, pid: process.pid, machine: machine(), folder: checkout, agentId: agentId ?? null, project: project ?? null, createdAt: Date.now(), phase: 'idle', guardPid: null, nativePid: null };
  await transaction(root, () => {
    for (const name of names(root, 'claim')) {
      const existingPath = join(root, name), existing = read(root, name); if (!existing) continue; validateClaim(existing, existingPath);
      // Missing recorded leaders cannot prove their descendants stopped. Only an
      // idle claim has trusted cleanup evidence; interrupted startup/execution
      // remains protected even after both the guard and connector disappear.
      const stale = existing.phase === 'idle' && confirmedAbsent(existing);
      if (stale) { unlinkSync(existingPath); continue; }
      if (overlap(checkout, existing.folder)) {
        throw new Error(`Worker checkout is already owned: ${existing.folder} (project ${existing.project ?? 'unknown'}, agent ${existing.agentId ?? 'unknown'}, connector PID ${existing.pid}, guard PID ${existing.guardPid ?? 'none recorded'}, native PID ${existing.nativePid ?? 'none recorded'}, phase ${existing.phase}). Use a separate sibling checkout, or stop this exact worker in its owning session and retry. Ownership record: ${existingPath}.${existing.machine !== machine() || !machine() ? ' Machine identity is uncertain or different; inspect ownership on the original machine before removing this exact record.' : existing.phase !== 'idle' && absent(existing.pid) ? ' Its connector ended before confirmed whole-process-group cleanup; inspect this exact checkout and its execution descendants before manually removing this exact claim.' : ''} No process was killed.`);
      }
    }
    writePrivate(path, claim);
  });
  let released = false;
  const exactClaim = () => {
    const saved = read(root, `claim-${id}.json`);
    if (saved) validateClaim(saved, path);
    if (!saved || saved.id !== id || saved.pid !== process.pid || saved.folder !== checkout || saved.machine !== claim.machine) throw new Error(`Worker checkout ownership changed unexpectedly. Inspect ${path}; no replacement record was removed.`);
  };
  const update = () => { if (released) throw new Error('Worker checkout ownership was already released.'); exactClaim(); writePrivate(path, claim); };
  const processesEnded = () => {
    if ([claim.guardPid, claim.nativePid].some(pid => pid !== null && !absent(pid))) throw new Error(`Worker checkout still has a live guard or native process. Ownership retained at ${path}; wait for confirmed cleanup before releasing.`);
  };
  return {
    folder: checkout,
    beginTurn() {
      if (claim.phase !== 'idle') throw new Error('Worker checkout cannot begin another turn before confirmed cleanup.');
      processesEnded(); claim.phase = 'spawning'; update();
    },
    guardStarted(pid) {
      if (!validPid(pid) || claim.phase !== 'spawning' || claim.guardPid !== null) throw new Error('Worker checkout ownership could not record the guard process.');
      claim.guardPid = pid; update();
    },
    nativeStarted(pid) {
      if (!validPid(pid) || claim.phase !== 'spawning' || !validPid(claim.guardPid) || claim.nativePid !== null) throw new Error('Worker checkout ownership could not record the native model process.');
      claim.nativePid = pid; claim.phase = 'running'; update();
    },
    endTurn({ cleanupConfirmed, retainClaim = false } = {}) {
      if (released) return;
      if (cleanupConfirmed !== true) throw new Error(`Worker checkout cleanup is uncertain. Ownership retained at ${path}; trusted whole-process-group cleanup is required.`);
      if (typeof retainClaim !== 'boolean') throw new Error('Invalid checkout retention setting.');
      // A mission may keep detached servers between turns. `spawning` with no
      // leaders also means reserved, not proven resource-free; only this live
      // claim may record the next guard. Never stale-reclaim that gap as idle.
      processesEnded(); claim.phase = retainClaim ? 'spawning' : 'idle'; claim.guardPid = null; claim.nativePid = null; update();
    },
    release() {
      if (released) return;
      exactClaim();
      // No saved-PID inference or uncertain active-holder takeover. Only an idle
      // claim, reached through trusted cleanup, can release this exact UUID.
      if (claim.phase !== 'idle') throw new Error(`Worker checkout cleanup is uncertain. Ownership retained at ${path}; end the turn with confirmed cleanup before releasing.`);
      processesEnded();
      unlinkSync(path); released = true;
    },
  };
}

// Explicit owner Stop of a worker whose connector died. Removes this exact
// worker's claims in any phase, but only when the owning connector and every
// recorded guard/native process are confirmed gone on this machine. The caller
// must first stop the mission's marked processes; a live or unknowable owner
// keeps its claim and nothing is removed.
export async function releaseOrphanedCheckout({ folder, agentId, project, registryRoot = checkoutOwnershipHome() }) {
  const checkout = physicalPath(folder), root = physicalPath(registryRoot);
  return transaction(root, () => {
    const orphaned = [];
    for (const name of names(root, 'claim')) {
      const path = join(root, name), claim = read(root, name); if (!claim) continue; validateClaim(claim, path);
      if (!overlap(checkout, claim.folder) || claim.agentId !== agentId || claim.project !== project) continue;
      if (!confirmedAbsent(claim) || [claim.guardPid, claim.nativePid].some(pid => pid !== null && !absent(pid)))
        throw new Error(`Worker checkout is still owned by a running or unconfirmed process. Ownership retained at ${path}; nothing was removed.`);
      orphaned.push(path);
    }
    for (const path of orphaned) unlinkSync(path);
    return { released: orphaned.length };
  });
}
