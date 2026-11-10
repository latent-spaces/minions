import { Worker } from 'node:worker_threads';
import { mkdir, chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RuntimeError, validateCommand, validateUuid, commandFingerprint } from './contracts.mjs';
import { validateParticipationCommand, participationFingerprint } from './participation-contracts.mjs';
import { validateArchiveReport, archiveReportFingerprint } from './report-recovery.mjs';
import { validateMissionRecovery, missionRecoveryFingerprint } from './mission-recovery.mjs';

/** One bounded asynchronous port; synchronous SQLite work stays off the service event loop. */
export async function openRuntimeStore({ directory, requestTimeoutMs = 10000, reopenDelayMs = 1000, log = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) }) {
  if (typeof directory !== 'string' || !directory) throw new RuntimeError('invalid_directory', 'A private runtime directory is required');
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new RuntimeError('unsafe_directory', 'Runtime directory must be an owned directory');
  await chmod(directory, 0o700);
  const pending = new Map(); let nextId = 1, failure, closed = false, worker, fatal, recovering = false;
  const rejectPending = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  // One worker at a time. A failure rejects every in-flight request (acceptance
  // unknown; callers inspect by operation ID) and the service reopens storage.
  const spawn = reopen => new Promise((resolveReady, rejectReady) => {
    const current = new Worker(new URL('./store-worker.mjs', import.meta.url), { workerData: { directory, reopen }, execArgv: [] });
    let ready = false;
    worker = current;
    const fail = error => {
      if (worker !== current) return;
      failure ||= error; rejectPending(failure);
      if (!ready) { rejectReady(failure); void current.terminate(); }
      else if (!closed) void recover(current);
    };
    fatal = fail;
    const startupTimer = setTimeout(() => fail(new RuntimeError('storage_timeout', 'Storage initialization timed out')), 10000);
    current.on('error', error => fail(new RuntimeError('storage_failure', error.message)));
    current.on('exit', code => { clearTimeout(startupTimer); if (!closed) fail(new RuntimeError('storage_failure', `Storage worker exited (${code}); acceptance may be unknown`)); });
    current.on('message', message => {
      if (message.ready) { ready = true; clearTimeout(startupTimer); return resolveReady(); }
      if (message.initializationError) { clearTimeout(startupTimer); return fail(new RuntimeError(message.initializationError.code, message.initializationError.message)); }
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) {
        const error = new RuntimeError(message.error.code, message.error.message);
        entry.reject(error);
        if (error.code === 'storage_failure') fail(error);
      } else entry.resolve(message.result);
    });
  });
  async function recover(failed) {
    if (recovering) return; recovering = true;
    log(`Storage failed (${failure.code}: ${failure.message}); reopening.`);
    try {
      await failed.terminate();
      for (let delay = reopenDelayMs; !closed; delay = Math.min(delay * 2, 30000)) {
        await new Promise(resolve => setTimeout(resolve, delay).unref());
        if (closed) return;
        try { await spawn(true); } catch (error) { log(`Storage reopen failed (${error.code}: ${error.message}); retrying in ${Math.min(delay * 2, 30000) / 1000}s.`); continue; }
        if (closed) { await worker.terminate(); return; }
        failure = undefined; log('Storage reopened.'); return;
      }
    } finally { recovering = false; }
  }
  const request = (method, input) => {
    if (failure && method !== 'close') return Promise.reject(failure);
    if (closed) return Promise.reject(new RuntimeError('storage_closed', 'Storage is closed'));
    if (pending.size >= 128) return Promise.reject(new RuntimeError('storage_busy', 'Storage queue is full'));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => fatal(new RuntimeError('storage_timeout', 'Storage acceptance is unknown; reopen and inspect the operation ID')), requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, input });
    });
  };
  await spawn(false);
  // This same-port fence protects early cancellation before SQLite dispatch.
  // It grants no acceptance: only saved receipts establish durable operations.
  const reservations = new Map();
  function reserveOperation(input) {
    // Physical stop must remain available when SQLite is unhealthy. This cache
    // only rejects conflicting identities; every actual request stays gated.
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
      || !Object.hasOwn(input, 'operationId') || !Object.hasOwn(input, 'fingerprint')) throw new RuntimeError('invalid_command', 'Use the exact operation reservation');
    validateUuid(input.operationId, 'operationId');
    if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new RuntimeError('invalid_command', 'Invalid operation fingerprint');
    const previous = reservations.get(input.operationId);
    if (previous !== undefined && previous !== input.fingerprint) throw new RuntimeError('conflict', 'Operation ID already identifies different input');
    reservations.set(input.operationId, input.fingerprint);
  }
  try {
    const receipts = await Promise.all([request('listOperations'), request('listParticipationOperations'),request('listArchiveOperations'),request('listSteeringIntents')]);
    for (const receipt of receipts.flat()) reserveOperation({ operationId: receipt.operationId, fingerprint: receipt.fingerprint });
  } catch (error) { closed = true; await worker.terminate(); throw error; }
  return {
    reserveOperation,
    reserveCloudOperation(input) { reserveOperation(input);return request('reserveCloudOperation',structuredClone(input)); },
    acceptParticipation(command) { validateParticipationCommand(command); try { reserveOperation({ operationId: command.operationId, fingerprint: participationFingerprint(command) }); } catch (error) { return Promise.reject(error); } return request('acceptParticipation', structuredClone(command)); },
    getParticipation: input => request('getParticipation', input),
    resolveParticipation: input => request('resolveParticipation', input),
    listParticipations: input => request('listParticipations', input),
    latestParticipationsForTargets: input => request('latestParticipationsForTargets', input),
    bindParticipationCloud: input => request('bindParticipationCloud', input),
    expireParticipations: () => request('expireParticipations'),
    getParticipationOperation: input => request('getParticipationOperation', input),
    listParticipationOperations: () => request('listParticipationOperations'),
    accept(command) { validateCommand(command); try { reserveOperation({ operationId: command.operationId, fingerprint: commandFingerprint(command) }); } catch (error) { return Promise.reject(error); } return request('accept', structuredClone(command)); },
    reserveSteeringGroup(input) { reserveOperation(input); return request('reserveSteeringGroup',structuredClone(input)); },
    reserveSteering(input) { validateCommand(input);if(input.kind!=='steer')throw new RuntimeError('invalid_command','Use a steering intent.');const reservation={operationId:input.operationId,fingerprint:commandFingerprint(input)};reserveOperation(reservation);return request('reserveCloudOperation',reservation); },
    acceptSteering(input) { validateCommand(input); if (input.kind !== 'steer') throw new RuntimeError('invalid_command', 'Cloud steering intake only accepts steering'); try { reserveOperation({ operationId: input.operationId, fingerprint: commandFingerprint(input) }); } catch (error) { return Promise.reject(error); } return request('acceptSteering', structuredClone(input)); },
    prepareCloudRun: input => request('prepareCloudRun', input),
    bindCloudRun: input => request('bindCloudRun', input),
    listDueReports: input => request('listDueReports', input),
    listReports: input => request('listReports', input),
    async archiveFailedLaunchReport(input) {
      const command = validateArchiveReport(input);
      reserveOperation({ operationId: command.operationId, fingerprint: archiveReportFingerprint(command) });
      return request('archiveFailedLaunchReport', command);
    },
    applyMissionRecovery(input) {
      const command=validateMissionRecovery(input);
      try { reserveOperation({operationId:command.operationId,fingerprint:missionRecoveryFingerprint(command)}); }
      catch(error) { return Promise.reject(error); }
      return request('applyMissionRecovery',command);
    },
    listArchiveOperations: () => request('listArchiveOperations'),
    acknowledgeReport: input => request('acknowledgeReport', input),
    failReport: input => request('failReport', input),
    applyCloudDeadline: input => request('applyCloudDeadline', input),
    clearGuardAfterCleanup: input => request('clearGuardAfterCleanup', input),
    getOperation: input => request('getOperation', input), getMission: input => request('getMission', input),
    latestBackgroundsForTargets: input => request('latestBackgroundsForTargets',input),
    listMissions: () => request('listMissions'), listOperations: () => request('listOperations'), recordGuard: input => request('recordGuard', input),
    markTurnSubmitted: input => request('markTurnSubmitted', input), blockMission: input => request('blockMission', input),
    listMissionSummaries: input => request('listMissionSummaries', input),
    deferPreparedTurn: input => request('deferPreparedTurn', input),
    prepareTurn: input => request('prepareTurn', input), markTurnApplied: input => request('markTurnApplied', input),
    recordTurn: input => request('recordTurn', input), settleMission: input => request('settleMission', input),
    health: () => request('health'),
    async close() { if (closed) return; try { if (!failure) await request('close'); } finally { closed = true; failure ||= new RuntimeError('storage_closed', 'Storage is closed'); rejectPending(failure); await worker.terminate(); } },
  };
}
