import { parentPort, workerData } from 'node:worker_threads';
import { MAX_REMAINING_MS } from '../run-length.mjs';
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { RUNTIME_LIMITS, RuntimeError, validateCommand, validateOutcome, commandFingerprint, validateTarget, validateUuid, validateGeneration, boundedText, isTerminalState } from './contracts.mjs';

import { normalizeCloudTurn, turnReportId, stopReportId } from './cloud-reports.mjs';
import { countedTokens } from './token-cap.mjs';
import { validateParticipationCommand, participationFingerprint, participationQuerySchema } from './participation-contracts.mjs';
import { validateArchiveReport, archiveReportFingerprint } from './report-recovery.mjs';
import { validateMissionRecovery, missionRecoveryFingerprint, settledExecution } from './mission-recovery.mjs';

const { directory, reopen = false } = workerData;
const MAX_ACTIVE_REPORTS = 4096, MAX_OUTSTANDING_PER_TARGET = 128;
const lockPath = join(directory, 'owner.lock');
const databasePath = join(directory, 'runtime.sqlite');
const startupPath = join(directory, 'startup.lock');
let db, lockToken, startupToken, storageFault;
const error = (code, message) => { throw new RuntimeError(code, message); };
const targetKey = target => JSON.stringify([target.site, target.ownerId, target.projectId, target.agentId]);
function ownFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) error('unsafe_directory', 'Runtime files must be owned regular files');
  chmodSync(path, 0o600);
}
function acquireLock() {
  // Every opener takes this non-reclaimable gate before examining a stale owner.
  // A crash during initialization deliberately requires explicit inspection.
  // A reopen runs in the same service process after its previous storage worker
  // was terminated, so locks it left behind carry this process's own PID.
  const ownedHere = path => { try { return reopen && JSON.parse(readFileSync(path, 'utf8')).pid === process.pid; } catch { return false; } };
  startupToken = JSON.stringify({ pid: process.pid, token: randomUUID() });
  if (ownedHere(startupPath)) unlinkSync(startupPath);
  try { const fd = openSync(startupPath, 'wx', 0o600); writeFileSync(fd, startupToken); closeSync(fd); }
  catch (failure) { if (failure.code === 'EEXIST') error('storage_locked', 'Store initialization is in progress or needs explicit crash inspection'); throw failure; }
  lockToken = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try { const fd = openSync(lockPath, 'wx', 0o600); writeFileSync(fd, lockToken); closeSync(fd); }
  catch (failure) {
    if (failure.code !== 'EEXIST') throw failure;
    ownFile(lockPath);
    let previous; const content = readFileSync(lockPath, 'utf8');
    try { previous = JSON.parse(content); } catch { error('storage_locked', 'Invalid ownership evidence; inspect the runtime directory'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) error('storage_locked', 'Invalid ownership evidence');
    if (!(reopen && previous.pid === process.pid)) {
      try { process.kill(previous.pid, 0); error('storage_locked', 'Another runtime owns this store'); }
      catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    }
    if (readFileSync(lockPath, 'utf8') !== content) error('storage_locked', 'Runtime ownership changed');
    unlinkSync(lockPath);
    const fd = openSync(lockPath, 'wx', 0o600); writeFileSync(fd, lockToken); closeSync(fd);
  }
}
function releaseStartup() { try { if (startupToken && readFileSync(startupPath, 'utf8') === startupToken) unlinkSync(startupPath); } catch {} }
function releaseLock() { try { if (lockToken && readFileSync(lockPath, 'utf8') === lockToken) unlinkSync(lockPath); } catch {} }
function transaction(run) { db.exec('BEGIN IMMEDIATE'); try { const result = run(); db.exec('COMMIT'); return result; } catch (failure) { db.exec('ROLLBACK'); throw failure; } }
const statement = sql => db.prepare(sql);
function missionRow(missionId, generation) {
  validateUuid(missionId, 'missionId');
  const row = statement('SELECT * FROM missions WHERE missionId=?').get(missionId);
  if (!row) error('not_found', 'Mission not found');
  if (generation !== undefined && row.generation !== validateGeneration(generation)) error('stale_generation', 'Mission generation does not match');
  return row;
}
function requireTarget(row, target) { validateTarget(target); if (row.targetKey !== targetKey(target)) error('forbidden', 'Target does not match the persisted record'); }
const operatorPaused = row => row.state === 'blocked' && row.reason === 'operator_paused';
function pauseId(row) {
  return statement("SELECT operationId FROM operations WHERE missionId=? AND json_extract(receipt,'$.kind')='pause' ORDER BY rowid DESC LIMIT 1").get(row.missionId)?.operationId;
}
function missionControlView(row) {
  if(!operatorPaused(row))return {};
  const last=statement('SELECT outcome FROM outcomes WHERE missionId=? ORDER BY sequence DESC LIMIT 1').get(row.missionId);
  const outcome=last?JSON.parse(last.outcome):null;
  const unsettled=row.currentTurnId||row.guardPid||outcome&&(outcome.cleanupConfirmed!==true||outcome.delivery==='submitted');
  return {state:unsettled?'pausing':'paused',pauseOperationId:pauseId(row)};
}
function snapshot(row) {
  const blocked = reportBlock(row);
  return {
    version: 2, missionId: row.missionId, generation: row.generation, target: JSON.parse(row.target), scope: row.scope, execution: JSON.parse(row.execution),
    reportDelivery: reportCounts(row.missionId),
    cloudRun: row.cloudRunId ? { runId: row.cloudRunId, generation: row.cloudGeneration, startedAt: row.cloudStartedAt } : null,
    deadlineAt: row.deadlineAt, state: blocked ? 'blocked' : row.state, guardPid: row.guardPid, currentTurnId: row.currentTurnId, currentTurnStage: row.currentTurnStage,
    createdAt: row.createdAt, updatedAt: row.updatedAt, reason: blocked ? 'report_attention' : row.reason,
    ...(blocked ? {blockedBy:blocked} : {}),
    ...missionControlView(row),
    steering: statement(`SELECT s.operationId,s.message,s.state,s.turnId,json_extract(o.receipt,'$.threadId') AS threadId
      FROM steering s LEFT JOIN operations o ON o.operationId=s.operationId WHERE s.missionId=? ORDER BY s.rowid`).all(row.missionId)
      .map(item => ({version:2,...item,threadId:item.threadId??`steer_${JSON.parse(row.target).ownerId}_${item.operationId}`})),
    outcomes: statement('SELECT sequence,turnId,text,outcome,createdAt FROM outcomes WHERE missionId=? ORDER BY sequence').all(row.missionId).map(item => ({ version: 2, ...item, outcome: JSON.parse(item.outcome) })),
  };
}
function updateState(row, state, fields = {}) {
  statement('UPDATE missions SET state=?,guardPid=?,currentTurnId=?,currentTurnStage=?,reason=?,updatedAt=? WHERE missionId=? AND generation=?')
    .run(state, fields.guardPid === undefined ? row.guardPid : fields.guardPid, fields.currentTurnId === undefined ? row.currentTurnId : fields.currentTurnId,
      fields.currentTurnStage ?? (fields.currentTurnId === null ? null : row.currentTurnStage),
      fields.reason === undefined ? row.reason : fields.reason, Date.now(), row.missionId, row.generation);
}
function reportSnapshot(row) {
  const archive=statement('SELECT receipt FROM reportArchives WHERE reportId=?').get(row.reportId);
  return { version: 2, ...row, target: JSON.parse(row.target), payload: JSON.parse(row.payload),
    ...(archive ? {state:'archived',deliveryState:row.state,archive:JSON.parse(archive.receipt)} : {}) };
}
function attentionReports(key) { return statement("SELECT reportId FROM reports WHERE targetKey=? AND state='attention' AND NOT EXISTS(SELECT 1 FROM reportArchives a WHERE a.reportId=reports.reportId) ORDER BY reportId LIMIT 128").all(key); }
function reportBlock(row) {
  if(!['accepted','starting','waiting'].includes(row.state))return null;
  const reports=attentionReports(row.targetKey);
  return reports.length ? {code:'report_attention',message:'An earlier report needs owner attention before this agent can work.',reportIds:reports.map(r=>r.reportId)} : null;
}
function reportCounts(missionId) {
  const rows=statement("SELECT CASE WHEN a.reportId IS NOT NULL THEN 'archived' ELSE r.state END AS state,COUNT(*) AS count FROM reports r LEFT JOIN reportArchives a ON a.reportId=r.reportId WHERE (? IS NULL OR r.missionId=?) GROUP BY 1").all(missionId??null,missionId??null);
  return {pending:0,delivered:0,attention:0,...Object.fromEntries(rows.map(r=>[r.state,r.count]))};
}
function reportRow(reportId) {
  if (typeof reportId !== 'string' || !/^[a-f0-9]{64}$/.test(reportId)) error('invalid_command', 'Invalid report identity');
  const row = statement('SELECT * FROM reports WHERE reportId=?').get(reportId);
  if (!row) error('not_found', 'Report not found');
  const { targetKey: ignored, ...publicRow } = row;
  return publicRow;
}
function reportCapacity(row, reserve = 1) {
  if (attentionReports(row.targetKey).length) error('report_attention', 'An earlier report needs owner attention before new work. Inspect list_agent_reports; only proven failed launches can be archived.');
  // Reserve a stop for each issued/uncertain registration and one report per
  // in-flight native turn, so concurrent completions cannot consume each other's space.
  // Capacity bounds the delivery backlog, not the durable history. Delivered
  // reports remain readable and keep their retry identities without permanently
  // consuming a slot. Explicitly archived failed launches are settled as well.
  const total = statement("SELECT COUNT(*) AS total FROM reports WHERE state!='delivered' AND NOT EXISTS(SELECT 1 FROM reportArchives a WHERE a.reportId=reports.reportId)").get().total;
  const outstanding = statement("SELECT COUNT(*) AS total FROM reports WHERE targetKey=? AND state!='delivered' AND NOT EXISTS(SELECT 1 FROM reportArchives a WHERE a.reportId=reports.reportId)").get(row.targetKey).total;
  const reservations = statement(`SELECT targetKey,currentTurnId FROM missions WHERE cloudRunId IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM reports WHERE reports.missionId=missions.missionId AND kind='stop_run')
    UNION ALL SELECT targetKey,NULL AS currentTurnId FROM participations WHERE cloudRunId IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM reports WHERE reports.missionId=participations.participationId AND kind='stop_run')`).all();
  const steeringReservations=statement(`SELECT m.targetKey,MAX(0,4-(SELECT COUNT(*) FROM reports r WHERE r.missionId=s.missionId AND r.kind='steering_receipt' AND json_extract(r.payload,'$.operationId')=s.operationId)) AS slots FROM steering s JOIN missions m ON m.missionId=s.missionId WHERE s.state!='applied' AND m.state NOT IN ('stopped','failed')`).all();
  const steeringReserved=steeringReservations.reduce((n,r)=>n+r.slots,0), ownSteeringReserved=steeringReservations.filter(r=>r.targetKey===row.targetKey).reduce((n,r)=>n+r.slots,0);
  const reserved = reservations.reduce((sum, item) => sum + 1 + (item.currentTurnId ? 1 : 0), 0);
  const ownReserved = reservations.filter(item => item.targetKey === row.targetKey).reduce((sum,item) => sum + 1 + (item.currentTurnId ? 1 : 0),0);
  if (total + reserved + steeringReserved + reserve > MAX_ACTIVE_REPORTS || outstanding + ownReserved + ownSteeringReserved + reserve > MAX_OUTSTANDING_PER_TARGET) error('report_capacity', 'Undelivered report capacity requires attention before new work');
}
function enqueueReport(row, { reportId, kind, payload, expectedReceiptId }) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > 32768) error('invalid_command', 'Cloud report exceeds its bound');
  const at = Date.now();
  statement("INSERT INTO reports(reportId,kind,missionId,generation,targetKey,target,runId,payload,expectedReceiptId,state,attempts,nextAt,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,'pending',0,0,NULL,?,?)")
    .run(reportId, kind, row.missionId ?? row.participationId, row.generation, row.targetKey, row.target, row.cloudRunId, serialized, expectedReceiptId, at, at);
}
function participationRow(id, generation) {
  validateUuid(id, 'participationId');
  const row = statement('SELECT * FROM participations WHERE participationId=?').get(id);
  if (!row) error('not_found', 'Participation not found');
  if (generation !== undefined && row.generation !== validateGeneration(generation)) error('stale_generation', 'Participation generation does not match');
  return row;
}
function participationFields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key)))
    error('invalid_command', 'Use only the exact participation operation fields');
}
function participationSnapshot(row) {
  return { version: 1, participationId: row.participationId, participationRef: row.participationRef,
    target: JSON.parse(row.target), generation: row.generation, scope: row.scope, approvedAt: row.approvedAt,
    deadlineAt: row.deadlineAt, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt,
    cloudRun: row.cloudRunId === null ? null : { runId: row.cloudRunId, generation: row.cloudGeneration, deadlineAt: row.cloudDeadlineAt } };
}
function endParticipation(row, state) {
  const reportId = stopReportId(row.participationId, row.generation);
  if (row.cloudRunId && !statement('SELECT 1 FROM reports WHERE reportId=?').get(reportId))
    enqueueReport(row, { reportId, kind: 'stop_run', payload: { phase: 'stopping', reason: 'operator' }, expectedReceiptId: reportId });
  statement('UPDATE participations SET state=?,updatedAt=? WHERE participationId=?').run(state, Date.now(), row.participationId);
  return participationSnapshot(participationRow(row.participationId));
}
function expireParticipationRows() {
  return statement("SELECT * FROM participations WHERE state IN ('approved','active','recovery_required') AND deadlineAt<=?").all(Date.now())
    .map(row => endParticipation(row, 'expired'));
}
function nextAgentGeneration(key) {
  return (statement('SELECT MAX(generation) AS generation FROM (SELECT generation FROM missions WHERE targetKey=? UNION ALL SELECT generation FROM participations WHERE targetKey=?)').get(key, key).generation ?? 0) + 1;
}
function assertAgentFree(key) {
  if (statement("SELECT 1 FROM missions WHERE targetKey=? AND state NOT IN ('stopped','failed')").get(key)
    || statement("SELECT 1 FROM participations WHERE targetKey=? AND state IN ('approved','active','recovery_required')").get(key))
    error('conflict', 'This agent already has active or unreconciled work');
}
function createParticipation(command, id, scope, at) {
  const key = targetKey(command.target);
  assertAgentFree(key);
  if (statement('SELECT 1 FROM missions WHERE missionId=?').get(id) || statement('SELECT 1 FROM participations WHERE participationId=?').get(id)) error('conflict', 'Work identity already exists');
  const generation = nextAgentGeneration(key), state = command.payload.deadlineAt <= at ? 'expired' : 'approved';
  if (state === 'approved') reportCapacity({ targetKey: key });
  statement('INSERT INTO participations(participationId,participationRef,targetKey,target,generation,scope,approvedAt,deadlineAt,state,cloudRunId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, randomUUID(), key, JSON.stringify(command.target), generation, scope, command.payload.approvedAt, command.payload.deadlineAt, state, state === 'approved' ? id : null, at, at);
  const row = participationRow(id);
  if (state === 'expired') endParticipation(row, 'expired');
  return participationRow(id);
}
// Receipt rows use the same durable report delivery as turn and stop evidence.
function steeringEvidence(row,operationId,state,turnId) {
  if(!row.cloudRunId)error('conflict','Steering requires a registered cloud run');
  const sequence={received:1,uncertain:2,included:3,ended:4}[state];
  const reportId=createHash('sha256').update(JSON.stringify(['steering',row.missionId,operationId,state])).digest('hex');
  if(statement('SELECT 1 FROM reports WHERE reportId=?').get(reportId))return;
  enqueueReport(row,{reportId,kind:'steering_receipt',expectedReceiptId:reportId,payload:{receiptId:reportId,operationId,missionId:row.missionId,generation:row.generation,state,sequence,observedAt:Date.now(),turnId:state==='ended'?null:turnId??null}});
}
// One terminal/report writer shared by ordinary Stop and explicit recovery.
function settleMissionRow(row, reason, cleanupConfirmed, abandonExecution = false) {
  if (isTerminalState(row.state)) return snapshot(row);
  // Process cleanup does not reconcile a submitted native effect. Preserve its
  // identity if result persistence failed, even when no steering was attached.
  const unrecordedExecution = row.currentTurnId !== null && ['submitted','applied'].includes(row.currentTurnStage)
    && !statement('SELECT 1 FROM outcomes WHERE missionId=? AND turnId=?').get(row.missionId,row.currentTurnId);
  // Only an explicit owner Stop that killed the mission may abandon that effect.
  const canSettle = cleanupConfirmed && (!unrecordedExecution || abandonExecution);
  for(const item of statement('SELECT operationId,state,turnId FROM steering WHERE missionId=?').all(row.missionId))
    if(item.state!=='applied') steeringEvidence(row,item.operationId,['submitted','uncertain'].includes(item.state)?'uncertain':'ended',item.turnId);
  if (canSettle && row.cloudRunId) {
    const reportId = stopReportId(row.missionId,row.generation);
    if (!statement('SELECT 1 FROM reports WHERE reportId=?').get(reportId)) {
      const payload={phase:'stopping',...(['operator','repeated_failures','superseded','checkout_missing','controller_failed'].includes(reason)?{reason}:{}),
        worker_session:{run_id:row.cloudRunId,missionId:row.missionId,generation:row.generation,startedAt:row.cloudStartedAt,deadlineAt:row.deadlineAt,
          // A killed agent's tokens stay in the pool (owner decision, 10 November 2026): the final contact keeps its count.
          remainingSlots:0,phase:'stopped',tokens:countedTokens(snapshot(row).outcomes)}};
      enqueueReport(row,{reportId,kind:'stop_run',payload,expectedReceiptId:reportId});
    }
  }
  updateState(row, canSettle ? 'stopped' : 'recovery_required', { reason, ...(canSettle ? { guardPid: null, currentTurnId: null } : {}) });
  return snapshot(missionRow(row.missionId));
}
const operations = {
  acceptParticipation(input) {
    const command = validateParticipationCommand(input), fingerprint = participationFingerprint(command);
    transaction(expireParticipationRows);
    return transaction(() => {
      const intent=statement('SELECT fingerprint FROM steeringIntents WHERE operationId=?').get(command.operationId);
      if(intent&&(command.kind!=='steer'||intent.fingerprint!==fingerprint))error('conflict','Operation identifies a recorded steering intent');
      if(statement('SELECT 1 FROM reportArchives WHERE operationId=?').get(command.operationId))error('conflict','Operation ID already identifies report recovery');
      const previous = statement('SELECT * FROM participationOperations WHERE operationId=?').get(command.operationId);
      if (previous) {
        requireTarget(previous, command.target);
        if (previous.fingerprint !== fingerprint) error('conflict', 'Operation ID already identifies another participation command');
        expireParticipationRows();
        return { created: false, receipt: JSON.parse(previous.receipt), participation: participationSnapshot(participationRow(previous.participationId)) };
      }
      if (statement('SELECT 1 FROM operations WHERE operationId=?').get(command.operationId)) error('conflict', 'Operation ID already identifies a mission command');
      const at = Date.now();
      if (command.kind !== 'release' && command.payload.approvedAt > at) error('invalid_command', 'Approval time cannot be in the future');
      expireParticipationRows();
      let row;
      if (command.kind === 'claim') row = createParticipation(command, command.participationId, command.payload.scope, at);
      else {
        row = participationRow(command.participationId, command.generation); requireTarget(row, command.target);
        if (command.kind === 'release') {
          if (!['expired', 'released'].includes(row.state)) endParticipation(row, 'released');
          row = participationRow(row.participationId);
        } else if (command.kind === 'extend') {
          if (row.state !== 'active' || row.deadlineAt <= at || row.deadlineAt !== command.payload.expectedDeadlineAt
            || row.cloudGeneration === null || row.cloudDeadlineAt !== row.deadlineAt) error('conflict', 'Only the current live cloud-confirmed deadline can be extended');
          if (command.payload.deadlineAt - at > MAX_REMAINING_MS) error('invalid_command', 'Remaining participation lifetime cannot exceed 24 hours');
          statement('UPDATE participations SET deadlineAt=?,updatedAt=? WHERE participationId=?').run(command.payload.deadlineAt, at, row.participationId);
          row = participationRow(row.participationId);
        } else {
          if (!['expired', 'released'].includes(row.state)) error('conflict', 'Only expired or released participation can be woken');
          row = createParticipation(command, command.payload.nextParticipationId, row.scope, at);
        }
      }
      const receipt = { version: 1, operationId: command.operationId, kind: command.kind, target: command.target, participationId: row.participationId,
        participationRef: row.participationRef, generation: row.generation, acceptedAt: at, deadlineAt: row.deadlineAt, fingerprint };
      statement('INSERT INTO participationOperations(operationId,targetKey,participationId,fingerprint,receipt) VALUES(?,?,?,?,?)')
        .run(command.operationId, row.targetKey, row.participationId, fingerprint, JSON.stringify(receipt));
      return { created: true, receipt, participation: participationSnapshot(row) };
    });
  },
  getParticipation(input) {
    let query; try { query = participationQuerySchema.parse(input); } catch { error('invalid_command', 'Use an exact participation query'); }
    transaction(expireParticipationRows);
    const row = statement('SELECT * FROM participations WHERE participationId=?').get(query.participationId); if (!row) return null; requireTarget(row, query.target); return participationSnapshot(row);
  },
  resolveParticipation(input) {
    participationFields(input, ['site', 'ownerId', 'participationRef']);
    const { site, ownerId, participationRef } = input;
    validateTarget({ site, ownerId, projectId: 'query', agentId: 'query' }); validateUuid(participationRef, 'participationRef');
    transaction(expireParticipationRows);
    return transaction(() => {
      expireParticipationRows();
      const row = statement("SELECT * FROM participations WHERE participationRef=? AND json_extract(target,'$.site')=? AND json_extract(target,'$.ownerId')=?").get(participationRef, site, ownerId);
      if (!row || row.state !== 'active' || row.deadlineAt <= Date.now() || row.cloudGeneration === null || row.cloudDeadlineAt !== row.deadlineAt) error('participation_inactive', 'This participation reference is not active and cloud-confirmed');
      return participationSnapshot(row);
    });
  },
  listParticipations(input = {}) {
    participationFields(input, ['site', 'ownerId'], ['projectId', 'limit', 'after']);
    const { site, ownerId, projectId, limit = 50, after } = input;
    validateTarget({ site, ownerId, projectId: projectId ?? 'query', agentId: 'query' });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) error('invalid_command', 'List limit must be 1–100');
    if (after !== undefined) validateUuid(after, 'after');
    return transaction(() => { expireParticipationRows();
      const rows = statement("SELECT * FROM participations WHERE json_extract(target,'$.site')=? AND json_extract(target,'$.ownerId')=? AND (? IS NULL OR json_extract(target,'$.projectId')=?) AND (? IS NULL OR participationId>?) ORDER BY participationId LIMIT ?")
        .all(site, ownerId, projectId ?? null, projectId ?? null, after ?? null, after ?? null, limit + 1);
      return { version: 1, participations: rows.slice(0, limit).map(participationSnapshot), next: rows.length > limit ? rows[limit - 1].participationId : null };
    });
  },
  latestBackgroundsForTargets(input) {
    participationFields(input, ['targets']);
    if (!Array.isArray(input.targets) || input.targets.length > 32) error('invalid_command', 'Choose at most 32 configured targets');
    const keys = input.targets.map(target => { validateTarget(target); return targetKey(target); });
    if (new Set(keys).size !== keys.length) error('invalid_command', 'Configured targets must be distinct');
    return transaction(() => keys.map(key => statement('SELECT * FROM missions WHERE targetKey=? ORDER BY generation DESC LIMIT 1').get(key))
      .filter(Boolean).map(row => {
        const view=missionControlView(row),blocked=reportBlock(row);
        return {target:JSON.parse(row.target),missionId:row.missionId,generation:row.generation,deadlineAt:row.deadlineAt,
          state:view.state??(blocked?'blocked':row.state),pauseOperationId:view.pauseOperationId??null,
          cloudRun:row.cloudGeneration?{runId:row.cloudRunId,generation:row.cloudGeneration}:null,updatedAt:row.updatedAt};
      }));
  },
  latestParticipationsForTargets(input) {
    participationFields(input, ['targets']);
    if (!Array.isArray(input.targets) || input.targets.length > 32) error('invalid_command', 'Choose at most 32 configured targets');
    const keys = input.targets.map(target => { validateTarget(target); return targetKey(target); });
    if (new Set(keys).size !== keys.length) error('invalid_command', 'Configured targets must be distinct');
    return transaction(() => {
      expireParticipationRows();
      return keys.map(key => statement('SELECT * FROM participations WHERE targetKey=? ORDER BY generation DESC LIMIT 1').get(key))
        .filter(Boolean).map(participationSnapshot);
    });
  },
  bindParticipationCloud(input) {
    participationFields(input, ['target', 'participationId', 'generation', 'cloudGeneration', 'deadlineAt']);
    const { target, participationId, generation, cloudGeneration, deadlineAt } = input;
    validateTarget(target); validateGeneration(cloudGeneration);
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 1) error('invalid_command', 'Cloud participation deadline is required');
    transaction(expireParticipationRows);
    return transaction(() => {
      expireParticipationRows(); const row = participationRow(participationId, generation); requireTarget(row, target);
      if (!['approved', 'active'].includes(row.state) || row.deadlineAt <= Date.now()) error('participation_inactive', 'Ended or unreconciled participation cannot become active');
      if (row.deadlineAt !== deadlineAt || row.cloudGeneration !== null && row.cloudGeneration !== cloudGeneration) error('conflict', 'Cloud participation binding differs from its accepted authorization');
      statement("UPDATE participations SET cloudGeneration=?,cloudDeadlineAt=?,state='active',updatedAt=? WHERE participationId=?").run(cloudGeneration, deadlineAt, Date.now(), participationId);
      return participationSnapshot(participationRow(participationId));
    });
  },
  expireParticipations() { return transaction(expireParticipationRows); },
  getParticipationOperation(input) {
    participationFields(input, ['operationId', 'target']);
    const { operationId, target } = input;
    validateUuid(operationId, 'operationId'); validateTarget(target);
    const row = statement('SELECT * FROM participationOperations WHERE operationId=?').get(operationId);
    if (!row) return null; requireTarget(row, target); return JSON.parse(row.receipt);
  },
  listParticipationOperations() { return statement('SELECT receipt FROM participationOperations ORDER BY rowid').all().map(row => JSON.parse(row.receipt)); },
  reserveSteeringGroup(input) {
    validateUuid(input.operationId,'operationId');
    if(!/^[a-f0-9]{64}$/.test(input.fingerprint))error('invalid_command','Invalid steering group fingerprint');
    return transaction(()=>{
      const previous=statement('SELECT fingerprint FROM steeringIntents WHERE operationId=?').get(input.operationId);
      if(previous&&previous.fingerprint!==input.fingerprint)error('conflict','Steering send already has different recipients or content');
      if(statement('SELECT 1 FROM operations WHERE operationId=?').get(input.operationId)||statement('SELECT 1 FROM participationOperations WHERE operationId=?').get(input.operationId)||statement('SELECT 1 FROM reportArchives WHERE operationId=?').get(input.operationId))error('conflict','Operation identity is already in use');
      statement('INSERT OR IGNORE INTO steeringIntents(operationId,fingerprint) VALUES(?,?)').run(input.operationId,input.fingerprint);
      return {operationId:input.operationId};
    });
  },
  reserveCloudOperation(input) {
    // Schema 6 retains this table's historical name. It holds fingerprints for
    // cloud actions before effects, so queued Stop and steering share the same
    // durable global operation-ID fence without changing installed store shape.
    participationFields(input,['operationId','fingerprint']);
    const {operationId,fingerprint}=input;validateUuid(operationId,'operationId');
    if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))error('invalid_command','Invalid cloud operation fingerprint');
    return transaction(()=>{
      const previous=statement('SELECT fingerprint FROM steeringIntents WHERE operationId=?').get(operationId);
      if(previous&&previous.fingerprint!==fingerprint)error('conflict','Cloud operation already has different content');
      const op=statement('SELECT fingerprint FROM operations WHERE operationId=?').get(operationId);
      if(op&&op.fingerprint!==fingerprint || statement('SELECT 1 FROM participationOperations WHERE operationId=?').get(operationId) || statement('SELECT 1 FROM reportArchives WHERE operationId=?').get(operationId))error('conflict','Operation identity is already in use');
      statement('INSERT OR IGNORE INTO steeringIntents(operationId,fingerprint) VALUES(?,?)').run(operationId,fingerprint);
      return {operationId};
    });
  },
  acceptSteering(command) { validateCommand(command); if(command.kind!=='steer')error('invalid_command','Steering intake accepts only recorded steering');return operations.accept(command,true); },
  accept(command, recordedSteering = false) {
    validateCommand(command); if(command.kind==='steer'&&!recordedSteering)error('forbidden','Record steering before delivery.'); const fingerprint = commandFingerprint(command);
    return transaction(() => {
      const intent=statement('SELECT fingerprint FROM steeringIntents WHERE operationId=?').get(command.operationId);
      if(intent&&(command.kind!=='steer'||intent.fingerprint!==fingerprint))error('conflict','Operation identifies a steering intent');
      if(statement('SELECT 1 FROM reportArchives WHERE operationId=?').get(command.operationId))error('conflict','Operation ID already identifies report recovery');
      if (statement('SELECT 1 FROM participationOperations WHERE operationId=?').get(command.operationId)) error('conflict', 'Operation ID already identifies a participation command');
      const previous = statement('SELECT * FROM operations WHERE operationId=?').get(command.operationId);
      if (previous) {
        if (previous.targetKey !== targetKey(command.target)) error('forbidden', 'Operation target does not match');
        if (previous.fingerprint !== fingerprint) error('conflict', 'Operation ID was already accepted with different content');
        if(command.kind==='steer'&&command.payload.threadId&&JSON.parse(previous.receipt).threadId&&command.payload.threadId!==JSON.parse(previous.receipt).threadId)error('conflict','Steering conversation identity changed');
        return { created: false, receipt: JSON.parse(previous.receipt), mission: snapshot(missionRow(previous.missionId)) };
      }
      const acceptedAt = Date.now(); let row;
      if (command.kind === 'start') {
        // A deadline that has already passed starts the mission waiting for more time, like a worker past the job's end time.
        if (command.payload.deadlineAt > acceptedAt + MAX_REMAINING_MS) error('invalid_command', 'New mission deadline must be within 24 hours');
        expireParticipationRows();
        if (statement('SELECT 1 FROM missions WHERE missionId=?').get(command.missionId) || statement('SELECT 1 FROM participations WHERE participationId=?').get(command.missionId)) error('conflict', 'Work identity already exists');
        const key = targetKey(command.target);
        assertAgentFree(key);
        reportCapacity({targetKey:key});
        const generation = nextAgentGeneration(key);
        statement('INSERT INTO missions(missionId,targetKey,target,generation,scope,execution,deadlineAt,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(command.missionId, key, JSON.stringify(command.target), generation, command.payload.scope, JSON.stringify(command.payload.execution), command.payload.deadlineAt, 'accepted', acceptedAt, acceptedAt);
        row = missionRow(command.missionId);
      } else {
        row = missionRow(command.missionId, command.generation); requireTarget(row, command.target);
        if (command.kind === 'steer') {
          if (isTerminalState(row.state) || row.state === 'stopping' || row.state === 'recovery_required' || row.state === 'blocked' && !operatorPaused(row)) error('conflict', 'Mission cannot accept steering in this state');
          reportCapacity(row,4);
          statement("INSERT INTO steering(operationId,missionId,message,state) VALUES(?,?,?,'queued')").run(command.operationId, row.missionId, command.payload.message);
          steeringEvidence(row,command.operationId,'received',null);
        } else if (command.kind === 'pause') {
          if (!['accepted','starting','running','waiting'].includes(row.state) && !operatorPaused(row))
            error('conflict','Only a live approved mission can be paused.');
          updateState(row,'blocked',{reason:'operator_paused'});
        } else if (command.kind === 'resume') {
          const last = statement('SELECT outcome FROM outcomes WHERE missionId=? ORDER BY sequence DESC LIMIT 1').get(row.missionId);
          if (!operatorPaused(row) || pauseId(row) !== command.payload.pauseOperationId
            || row.guardPid !== null || row.currentTurnId !== null || last && (JSON.parse(last.outcome).cleanupConfirmed !== true || JSON.parse(last.outcome).delivery === 'submitted'))
            error('conflict','Resume requires the current Pause and confirmed settled execution.');
          reportCapacity(row,0);
          updateState(row,'waiting',{reason:null});
        } else if (!isTerminalState(row.state)) updateState(row, 'stopping');
      }
      const receipt = { version: 2, operationId: command.operationId, kind: command.kind, missionId: row.missionId, generation: row.generation, target: command.target, acceptedAt, fingerprint, ...(command.kind==='steer'&&command.payload.threadId?{threadId:command.payload.threadId}:{}) };
      statement('INSERT INTO operations(operationId,targetKey,missionId,fingerprint,receipt) VALUES(?,?,?,?,?)')
        .run(command.operationId, targetKey(command.target), row.missionId, fingerprint, JSON.stringify(receipt));
      return { created: true, receipt, mission: snapshot(missionRow(row.missionId)) };
    });
  },
  getOperation({ operationId, target }) {
    validateUuid(operationId, 'operationId'); validateTarget(target);
    const row = statement('SELECT * FROM operations WHERE operationId=?').get(operationId);
    if (row) { requireTarget(row, target); return JSON.parse(row.receipt); }
    const archived = statement('SELECT receipt FROM reportArchives WHERE operationId=?').get(operationId);
    if (!archived) return null;
    const receipt = JSON.parse(archived.receipt);
    if (targetKey(receipt.target) !== targetKey(target)) error('forbidden', 'Target does not match this recovery receipt');
    return receipt;
  },
  getMission({ missionId, target }) {
    validateUuid(missionId, 'missionId'); validateTarget(target);
    const row = statement('SELECT * FROM missions WHERE missionId=?').get(missionId);
    if (!row) return null; requireTarget(row, target); return snapshot(row);
  },
  listMissions() { return statement('SELECT * FROM missions ORDER BY createdAt,missionId').all().map(snapshot); },
  listSteeringIntents() {return statement('SELECT operationId,fingerprint FROM steeringIntents').all();},
  listOperations() { return statement('SELECT receipt FROM operations ORDER BY rowid').all().map(row => JSON.parse(row.receipt)); },
  listArchiveOperations() { return statement('SELECT receipt FROM reportArchives ORDER BY rowid').all().map(row=>JSON.parse(row.receipt)); },
  archiveFailedLaunchReport(input) {
    const command = validateArchiveReport(input), fingerprint = archiveReportFingerprint(command);
    return transaction(() => {
      const previous = statement('SELECT * FROM reportArchives WHERE operationId=?').get(command.operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) error('conflict', 'Recovery operation already has different input');
        return { created: false, receipt: JSON.parse(previous.receipt), report: reportSnapshot(reportRow(command.reportId)) };
      }
      const operationExists = statement('SELECT 1 FROM operations WHERE operationId=? UNION ALL SELECT 1 FROM participationOperations WHERE operationId=? UNION ALL SELECT 1 FROM steeringIntents WHERE operationId=?')
        .get(command.operationId, command.operationId, command.operationId);
      if (operationExists) error('conflict', 'Operation ID already identifies other work');
      const row = missionRow(command.missionId), report = reportRow(command.reportId);
      requireTarget(row, command.target);
      if (targetKey(JSON.parse(report.target)) !== targetKey(command.target)) error('forbidden', 'Target does not match this report');
      // A bad_input refusal may follow an issued cloud run whose worker session the
      // service refused before any native turn; the run itself is not execution.
      const hasExecutionEvidence = (row.cloudGeneration !== null && command.expectedErrorCode !== 'bad_input') || row.guardPid !== null || row.currentTurnId !== null
        || statement('SELECT 1 FROM outcomes WHERE missionId=?').get(row.missionId)
        || statement("SELECT 1 FROM reports WHERE missionId=? AND kind!='stop_run'").get(row.missionId)
        || statement("SELECT 1 FROM steering WHERE missionId=? AND (turnId IS NOT NULL OR state IN ('submitted','applied','uncertain'))").get(row.missionId);
      if (report.missionId !== row.missionId || report.generation !== row.generation || report.runId !== row.cloudRunId
        || report.kind !== 'stop_run' || report.state !== 'attention' || report.errorCode !== command.expectedErrorCode
        || row.state !== 'stopped' || row.reason !== 'cloud_refused' || row.cloudRunId !== row.missionId || hasExecutionEvidence) {
        error('recovery_not_safe', 'Only a failed launch with no native execution evidence and a matching refusal can be archived.');
      }
      assertAgentFree(row.targetKey);
      if (statement('SELECT 1 FROM reportArchives WHERE reportId=?').get(command.reportId)) {
        error('conflict', 'This report already has an archive receipt; reuse its original operation ID.');
      }
      const receipt = { ...command, kind: 'archive_failed_launch_report', archivedAt: Date.now(), fingerprint,
        disposition: 'archived_no_execution', deliveryConfirmed: false };
      statement('INSERT INTO reportArchives(reportId,operationId,fingerprint,receipt) VALUES(?,?,?,?)')
        .run(command.reportId, command.operationId, fingerprint, JSON.stringify(receipt));
      return { created: true, receipt, report: reportSnapshot(report) };
    });
  },
  prepareCloudRun({missionId,generation,startedAt}) {
    if(!Number.isSafeInteger(startedAt)||startedAt<0)error('invalid_command','Cloud start requires a measured start time');
    return transaction(()=>{
      const row=missionRow(missionId,generation);
      if(row.cloudRunId){if(row.cloudRunId!==missionId||row.cloudStartedAt!==startedAt)error('conflict','Cloud start intent is immutable');return snapshot(row);}
      if(row.currentTurnId||(!['accepted','starting','waiting'].includes(row.state)&&!operatorPaused(row)))error('conflict','Cloud start intent must precede execution');
      reportCapacity(row);
      statement('UPDATE missions SET cloudRunId=?,cloudStartedAt=?,updatedAt=? WHERE missionId=?').run(missionId,startedAt,Date.now(),missionId);
      return snapshot(missionRow(missionId));
    });
  },
  bindCloudRun({ missionId, generation, runId, cloudGeneration }) {
    validateUuid(runId, 'runId');
    validateGeneration(cloudGeneration);
    return transaction(() => {
      const row = missionRow(missionId, generation);
      if (runId !== row.missionId) error('conflict', 'Cloud run must use the mission identity');
      if (row.cloudRunId && row.cloudGeneration !== null) {
        if (row.cloudRunId !== runId || row.cloudGeneration !== cloudGeneration) error('conflict', 'Cloud binding is immutable');
        return snapshot(row);
      }
      if (row.currentTurnId || (!['accepted','starting','waiting'].includes(row.state)&&!operatorPaused(row))) error('conflict', 'Cloud binding must precede execution');
      if (!row.cloudRunId) error('conflict','A saved cloud start intent is required before binding');
      statement('UPDATE missions SET cloudRunId=?,cloudGeneration=?,updatedAt=? WHERE missionId=?').run(runId,cloudGeneration,Date.now(),missionId);
      return snapshot(missionRow(missionId));
    });
  },
  recordGuard({ missionId, generation, turnId, guardPid }) {
    validateUuid(turnId, 'turnId');
    if (!Number.isSafeInteger(guardPid) || guardPid < 1) error('invalid_command', 'Invalid guard PID');
    return transaction(() => {
      const row = missionRow(missionId, generation);
      // A Pause lets a prepared turn run in full (owner decision, 9 November 2026).
      if ((row.state !== 'running' && !operatorPaused(row)) || row.currentTurnId !== turnId) error('conflict', 'Guard must belong to the active turn');
      if (row.guardPid && row.guardPid !== guardPid) error('conflict', 'Mission already owns a different guard');
      updateState(row, row.state, { guardPid }); return snapshot(missionRow(missionId));
    });
  },
  clearGuardAfterCleanup({missionId,generation,turnId,guardPid}) {
    validateUuid(turnId,'turnId');
    if(!Number.isSafeInteger(guardPid)||guardPid<1)error('invalid_command','Invalid guard PID');
    return transaction(()=>{
      const row=missionRow(missionId,generation);
      if(row.currentTurnId!==turnId||(row.guardPid!==null&&row.guardPid!==guardPid)||(!['running','stopping'].includes(row.state)&&!operatorPaused(row)))error('conflict','Cleanup evidence does not identify the current guard');
      updateState(row,row.state,{guardPid:null});return snapshot(missionRow(missionId));
    });
  },
  // A pause update turn (steering: false) leaves queued steering for the next working turn.
  prepareTurn({ missionId, generation, turnId, steering = true }) {
    validateUuid(turnId, 'turnId');
    return transaction(() => {
      const row = missionRow(missionId, generation);
      if (row.cloudRunId && row.cloudGeneration === null) error('conflict','Cloud run binding has not been confirmed');
      if (row.cloudRunId) reportCapacity(row);
      if (row.currentTurnId || !['accepted', 'starting', 'waiting'].includes(row.state)) error('conflict', 'Mission cannot start a turn');
      if (statement('SELECT 1 FROM outcomes WHERE missionId=? AND turnId=?').get(missionId, turnId)) error('conflict', 'Turn ID was already completed');
      updateState(row, 'running', { currentTurnId: turnId, currentTurnStage: 'prepared' });
      if (steering) statement("UPDATE steering SET state='received',turnId=? WHERE missionId=? AND state='queued'").run(turnId, missionId);
      const mission = snapshot(missionRow(missionId));
      return { mission, steering: mission.steering.filter(item => item.turnId === turnId) };
    });
  },
  deferPreparedTurn({missionId,generation,turnId}) {
    validateUuid(turnId,'turnId');
    return transaction(()=>{
      const row=missionRow(missionId,generation);
      if((row.state!=='running'&&!operatorPaused(row))||row.currentTurnId!==turnId||row.guardPid!==null||row.currentTurnStage!=='prepared'
        ||statement("SELECT 1 FROM steering WHERE missionId=? AND turnId=? AND state IN ('submitted','applied','uncertain') LIMIT 1").get(missionId,turnId))error('conflict','Only an unsubmitted guard-free prepared turn can be deferred');
      statement("UPDATE steering SET state='queued',turnId=NULL WHERE missionId=? AND turnId=? AND state='received'").run(missionId,turnId);
      updateState(row,operatorPaused(row)?'blocked':'waiting',{currentTurnId:null});
      return snapshot(missionRow(missionId));
    });
  },
  markTurnApplied({ missionId, generation, turnId }) {
    validateUuid(turnId, 'turnId');
    return transaction(() => {
      const row = missionRow(missionId, generation);
      if (row.currentTurnId !== turnId || (!['running', 'stopping'].includes(row.state)&&!operatorPaused(row))) error('conflict', 'Turn is no longer active');
      statement("UPDATE missions SET currentTurnStage='applied' WHERE missionId=?").run(missionId);
      statement("UPDATE steering SET state='applied' WHERE missionId=? AND turnId=? AND state IN ('received','submitted')").run(missionId, turnId);
      for(const item of statement("SELECT operationId FROM steering WHERE missionId=? AND turnId=? AND state='applied'").all(missionId,turnId))steeringEvidence(row,item.operationId,'included',turnId);
      return snapshot(missionRow(missionId));
    });
  },
  markTurnSubmitted({ missionId, generation, turnId }) {
    validateUuid(turnId, 'turnId');
    return transaction(() => {
      const row=missionRow(missionId,generation);
      if(row.currentTurnId!==turnId || (row.state!=='running'&&!operatorPaused(row))) error('conflict','Turn is no longer authorized for submission');
      statement("UPDATE missions SET currentTurnStage='submitted' WHERE missionId=?").run(missionId);
      statement("UPDATE steering SET state='submitted' WHERE missionId=? AND turnId=? AND state='received'").run(missionId,turnId);
      for(const item of statement("SELECT operationId FROM steering WHERE missionId=? AND turnId=? AND state='submitted'").all(missionId,turnId))steeringEvidence(row,item.operationId,'uncertain',turnId);
      return snapshot(missionRow(missionId));
    });
  },
  recordTurn({ missionId, generation, turnId, text, outcome, startedAt, endedAt }) {
    validateUuid(turnId, 'turnId'); validateOutcome(outcome);
    if(typeof text!=='string'||Buffer.byteLength(text)>RUNTIME_LIMITS.outcomeBytes||text.includes('\0')) error('invalid_command','Invalid bounded outcome text');
    const metadata=JSON.stringify(outcome);
    return transaction(() => {
      const row=missionRow(missionId,generation);
      const previous=statement('SELECT text,outcome,startedAt,endedAt FROM outcomes WHERE missionId=? AND turnId=?').get(missionId,turnId);
      if(previous){if(previous.text!==text||previous.outcome!==metadata||row.cloudRunId&&(previous.startedAt!==startedAt||previous.endedAt!==endedAt))error('conflict','Turn already recorded with another result');return snapshot(row);}
      if(row.currentTurnId!==turnId||(!['running','stopping'].includes(row.state)&&!operatorPaused(row)))error('conflict','Turn is no longer active');
      const sequence=statement('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM outcomes WHERE missionId=?').get(missionId).sequence;
      if (row.cloudRunId) {
        const cloudSequence = statement('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM cloudSequences WHERE targetKey=? AND runId=?').get(row.targetKey,row.cloudRunId).sequence;
        const lastTurn = normalizeCloudTurn({outcome,execution:JSON.parse(row.execution),startedAt,endedAt,sequence:cloudSequence});
        const reportId = turnReportId(JSON.parse(row.target).agentId,row.cloudRunId,cloudSequence);
        statement('INSERT INTO cloudSequences(targetKey,runId,sequence,turnId) VALUES(?,?,?,?)').run(row.targetKey,row.cloudRunId,cloudSequence,turnId);
        enqueueReport(row,{reportId,kind:'turn_report',payload:{run_id:row.cloudRunId,last_turn:lastTurn},expectedReceiptId:reportId});
      }
      statement('INSERT INTO outcomes(missionId,sequence,turnId,text,outcome,createdAt,startedAt,endedAt) VALUES(?,?,?,?,?,?,?,?)').run(missionId,sequence,turnId,text,metadata,Date.now(),startedAt??null,endedAt??null);
      if(outcome.delivery==='submitted') statement("UPDATE steering SET state='uncertain' WHERE missionId=? AND turnId=? AND state IN ('received','submitted')").run(missionId,turnId);
      else if(['not_submitted','rejected'].includes(outcome.delivery)) statement("UPDATE steering SET state='queued',turnId=NULL WHERE missionId=? AND turnId=? AND state IN ('received','submitted')").run(missionId,turnId);
      const state=!outcome.cleanupConfirmed?'recovery_required':row.state==='stopping'?'stopping':operatorPaused(row)?'blocked':'waiting';
      updateState(row,state,outcome.cleanupConfirmed?{currentTurnId:null,guardPid:null}:{});
      return snapshot(missionRow(missionId));
    });
  },
  blockMission({missionId,generation,reason}) {
    boundedText(reason,'reason',2048);
    return transaction(()=>{const row=missionRow(missionId,generation);if(!isTerminalState(row.state)&&row.state!=='stopping'&&row.state!=='recovery_required')updateState(row,'blocked',{reason});return snapshot(missionRow(missionId));});
  },
  listMissionSummaries({site,ownerId,projectId,after,limit=50}) {
    validateTarget({site,ownerId,projectId:projectId??'query',agentId:'query'});
    if(!Number.isInteger(limit)||limit<1||limit>100)error('invalid_command','List limit must be 1–100');
    if(after!==undefined)validateUuid(after,'after');
    const rows=statement("SELECT * FROM missions WHERE json_extract(target,'$.site')=? AND json_extract(target,'$.ownerId')=? AND (? IS NULL OR json_extract(target,'$.projectId')=?) AND (? IS NULL OR missionId>?) ORDER BY missionId LIMIT ?").all(site,ownerId,projectId??null,projectId??null,after??null,after??null,limit+1);
    return {version:2,missions:rows.slice(0,limit).map(row=>{const block=reportBlock(row);return {version:2,missionId:row.missionId,generation:row.generation,target:JSON.parse(row.target),execution:JSON.parse(row.execution),scope:row.scope,state:block?'blocked':row.state,reason:block?'report_attention':row.reason,...(block?{blockedBy:block}:{}),...missionControlView(row),deadlineAt:row.deadlineAt,createdAt:row.createdAt,updatedAt:row.updatedAt};}),next:rows.length>limit?rows[limit-1].missionId:null};
  },
  settleMission({ missionId, generation, reason, cleanupConfirmed, abandonExecution = false }) {
    boundedText(reason,'reason',2048);
    if(typeof cleanupConfirmed!=='boolean'||typeof abandonExecution!=='boolean')error('invalid_command','cleanupConfirmed and abandonExecution must be boolean');
    return transaction(()=>settleMissionRow(missionRow(missionId,generation),reason,cleanupConfirmed,abandonExecution));
  },
  applyMissionRecovery(input) {
    const command=validateMissionRecovery(input),fingerprint=missionRecoveryFingerprint(command);
    return transaction(()=>{
      const row=missionRow(command.missionId,command.generation);requireTarget(row,command.target);
      const previous=statement('SELECT * FROM operations WHERE operationId=?').get(command.operationId);
      if(previous) {
        if(previous.fingerprint!==fingerprint)error('conflict','Recovery operation already identifies different input.');
        return {created:false,receipt:JSON.parse(previous.receipt),mission:snapshot(row),
          ...(command.action==='retry_report'?{report:reportSnapshot(reportRow(command.reportId))}:{})};
      }
      if(statement('SELECT 1 FROM participationOperations WHERE operationId=? UNION ALL SELECT 1 FROM reportArchives WHERE operationId=?').get(command.operationId,command.operationId))
        error('conflict','Recovery operation identifies other work.');
      if(command.action==='finalize') {
        if(row.state!=='recovery_required' || !settledExecution(snapshot(row)))
          error('recovery_not_safe','Only an interrupted mission with settled execution can be finalized. Uncertain turns and cleanup stay protected.');
        settleMissionRow(row,'operator',true);
      } else {
        const report=reportRow(command.reportId);
        if(report.missionId!==row.missionId || report.generation!==row.generation || targetKey(JSON.parse(report.target))!==row.targetKey)
          error('forbidden','Report does not belong to this exact mission.');
        if(report.state!=='attention' || report.attempts!==command.expectedAttempts || report.errorCode!==command.expectedErrorCode
          || statement('SELECT 1 FROM reportArchives WHERE reportId=?').get(report.reportId))
          error('conflict','Report outcome changed or is not retryable attention. Inspect the current evidence before a new request.');
        statement("UPDATE reports SET state='pending',nextAt=?,updatedAt=? WHERE reportId=?").run(Date.now(),Date.now(),report.reportId);
      }
      const receipt={...command,kind:'mission_recovery',acceptedAt:Date.now(),fingerprint,
        executionReplayed:false,deliveryConfirmed:false};
      statement('INSERT INTO operations(operationId,targetKey,missionId,fingerprint,receipt) VALUES(?,?,?,?,?)')
        .run(command.operationId,row.targetKey,row.missionId,fingerprint,JSON.stringify(receipt));
      return {created:true,receipt,mission:snapshot(missionRow(row.missionId)),
        ...(command.action==='retry_report'?{report:reportSnapshot(reportRow(command.reportId))}:{})};
    });
  },
  listDueReports({now=Date.now(),limit=32}={}) {
    if(!Number.isSafeInteger(now)||now<0||!Number.isInteger(limit)||limit<1||limit>100)error('invalid_command','Invalid report selection');
    return statement("SELECT reportId FROM (SELECT reportId,nextAt,updatedAt,ROW_NUMBER() OVER (PARTITION BY targetKey ORDER BY nextAt,updatedAt,reportId) AS position FROM reports WHERE state='pending' AND nextAt<=? AND NOT EXISTS (SELECT 1 FROM reports delayed WHERE delayed.targetKey=reports.targetKey AND delayed.state='pending' AND delayed.nextAt>?)) ORDER BY position,nextAt,updatedAt,reportId LIMIT ?").all(now,now,limit).map(row=>reportSnapshot(reportRow(row.reportId)));
  },
  listReports({missionId,target,limit=50,after}={}) {
    if(missionId!==undefined)validateUuid(missionId,'missionId');
    if(target!==undefined)validateTarget(target);
    if(!Number.isInteger(limit)||limit<1||limit>100||after!==undefined&&(typeof after!=='string'||!/^[a-f0-9]{64}$/.test(after)))error('invalid_command','Invalid report page');
    const rows=statement('SELECT reportId FROM reports WHERE (? IS NULL OR missionId=?) AND (? IS NULL OR targetKey=?) AND (? IS NULL OR reportId>?) ORDER BY reportId LIMIT ?').all(missionId??null,missionId??null,target?targetKey(target):null,target?targetKey(target):null,after??null,after??null,limit+1);
    return {version:2,reports:rows.slice(0,limit).map(row=>reportSnapshot(reportRow(row.reportId))),next:rows.length>limit?rows[limit-1].reportId:null};
  },
  acknowledgeReport({reportId,receiptId}) {
    return transaction(()=>{
      const row=reportRow(reportId);
      if(statement('SELECT 1 FROM reportArchives WHERE reportId=?').get(reportId))error('conflict','Archived evidence is not a delivered report.');
      if(receiptId!==row.expectedReceiptId)error('conflict','Cloud acknowledgement does not match this report');
      if(row.state!=='delivered')statement("UPDATE reports SET state='delivered',attempts=attempts+1,errorCode=NULL,updatedAt=? WHERE reportId=?").run(Date.now(),reportId);
      return reportSnapshot(reportRow(reportId));
    });
  },
  failReport({reportId,errorCode,retryAt}) {
    if(typeof errorCode!=='string'||!/^[A-Za-z0-9_:.-]{1,100}$/.test(errorCode)||retryAt!==null&&(!Number.isSafeInteger(retryAt)||retryAt<0))error('invalid_command','Invalid delivery failure');
    return transaction(()=>{
      const row=reportRow(reportId);
      if(statement('SELECT 1 FROM reportArchives WHERE reportId=?').get(reportId))return reportSnapshot(row);
      if(row.state==='delivered')return reportSnapshot(row);
      statement('UPDATE reports SET state=?,attempts=attempts+1,nextAt=?,errorCode=?,updatedAt=? WHERE reportId=?').run(retryAt===null?'attention':'pending',retryAt??0,errorCode,Date.now(),reportId);
      return reportSnapshot(reportRow(reportId));
    });
  },
  applyCloudDeadline({missionId,generation,deadlineAt}) {
    if(!Number.isSafeInteger(deadlineAt)||deadlineAt<=Date.now())error('invalid_command','Deadline must be in the future');
    return transaction(()=>{const row=missionRow(missionId,generation);
      if(!row.cloudRunId||(!['accepted','starting','running','waiting'].includes(row.state)&&!operatorPaused(row)))error('conflict','Mission cannot accept an extension');
      if(deadlineAt<row.deadlineAt||deadlineAt-Date.now()>MAX_REMAINING_MS)error('conflict','Cloud extension exceeds the authorized window');
      statement('UPDATE missions SET deadlineAt=?,updatedAt=? WHERE missionId=?').run(deadlineAt,Date.now(),missionId);return snapshot(missionRow(missionId));});
  },
  health() { return { version: 2, ready: true, schemaVersion: 6, reports: reportCounts() }; },
  close() { db.close(); releaseLock(); return null; },
};
try {
  acquireLock();
  try { const fd = openSync(databasePath, 'wx', 0o600); closeSync(fd); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
  ownFile(databasePath);
  for (const suffix of ['-wal', '-shm']) { try { ownFile(databasePath + suffix); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } }
  db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');
  const version = statement('PRAGMA user_version').get().user_version;
  if (![0,6].includes(version)) error('unsupported_schema', 'Unsupported runtime schema version');
  if (version === 0) {
    if (statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) error('unsupported_schema', 'Unversioned existing schema cannot be adopted');
    transaction(() => db.exec(`
      CREATE TABLE missions(missionId TEXT PRIMARY KEY,targetKey TEXT NOT NULL,target TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),scope TEXT NOT NULL,execution TEXT NOT NULL,deadlineAt INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('accepted','starting','running','waiting','blocked','stopping','stopped','failed','recovery_required')),guardPid INTEGER,currentTurnId TEXT,currentTurnStage TEXT,reason TEXT,cloudRunId TEXT,cloudGeneration INTEGER,cloudStartedAt INTEGER,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,UNIQUE(targetKey,generation));
      CREATE UNIQUE INDEX one_active_agent ON missions(targetKey) WHERE state NOT IN ('stopped','failed');
      CREATE TABLE operations(operationId TEXT PRIMARY KEY,targetKey TEXT NOT NULL,missionId TEXT NOT NULL REFERENCES missions(missionId),fingerprint TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE steeringIntents(operationId TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE steering(operationId TEXT PRIMARY KEY,missionId TEXT NOT NULL REFERENCES missions(missionId),message TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','received','submitted','applied','uncertain')),turnId TEXT);
      CREATE TABLE outcomes(missionId TEXT NOT NULL REFERENCES missions(missionId),sequence INTEGER NOT NULL,turnId TEXT NOT NULL,text TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL,startedAt INTEGER,endedAt INTEGER,PRIMARY KEY(missionId,sequence),UNIQUE(missionId,turnId));
      CREATE TABLE cloudSequences(targetKey TEXT NOT NULL,runId TEXT NOT NULL,sequence INTEGER NOT NULL,turnId TEXT NOT NULL,PRIMARY KEY(targetKey,runId,sequence),UNIQUE(targetKey,runId,turnId));
      CREATE TABLE participations(participationId TEXT PRIMARY KEY,participationRef TEXT NOT NULL UNIQUE,targetKey TEXT NOT NULL,target TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),scope TEXT NOT NULL,approvedAt INTEGER NOT NULL,deadlineAt INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('approved','active','expired','released','recovery_required')),cloudRunId TEXT,cloudGeneration INTEGER,cloudDeadlineAt INTEGER,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,UNIQUE(targetKey,generation));
      CREATE UNIQUE INDEX one_active_participation ON participations(targetKey) WHERE state IN ('approved','active','recovery_required');
      CREATE TABLE participationOperations(operationId TEXT PRIMARY KEY,targetKey TEXT NOT NULL,participationId TEXT NOT NULL REFERENCES participations(participationId),fingerprint TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE reports(reportId TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('turn_report','stop_run','steering_receipt')),missionId TEXT NOT NULL,generation INTEGER NOT NULL,targetKey TEXT NOT NULL,target TEXT NOT NULL,runId TEXT NOT NULL,payload TEXT NOT NULL,expectedReceiptId TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','delivered','attention')),attempts INTEGER NOT NULL,nextAt INTEGER NOT NULL,errorCode TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE INDEX reports_due ON reports(state,nextAt,updatedAt);
      CREATE TABLE reportArchives(reportId TEXT PRIMARY KEY REFERENCES reports(reportId),operationId TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL);
      PRAGMA user_version=6;
    `));
  }
  // Waiting survives a connector restart (owner decision, 9 November 2026): a
  // mission between turns, with every earlier turn's cleanup confirmed, keeps its
  // state and the restarted service continues it. Work a restart interrupted is
  // never silently resumed: it needs recovery. A reopen inside the running
  // service keeps all its missions: their guards and checkout claims still
  // belong to this process.
  if (!reopen) transaction(() => {
    statement("UPDATE steering SET state='uncertain' WHERE state='submitted'").run();
    for (const row of statement("SELECT * FROM missions WHERE state NOT IN ('stopped','failed','recovery_required')").all()) {
      if ((['accepted','starting','waiting'].includes(row.state) || operatorPaused(row)) && settledExecution(snapshot(row))) continue;
      updateState(row, 'recovery_required', { reason: 'Service restarted; inspect guard and mission evidence before continuing' });
    }
    statement("UPDATE participations SET state='recovery_required',updatedAt=? WHERE state IN ('approved','active')").run(Date.now());
  });
  for (const suffix of ['', '-wal', '-shm']) { try { ownFile(databasePath + suffix); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } }
  parentPort.on('message', ({ id, method, input }) => {
    try {
      if (storageFault && method !== 'close') throw storageFault;
      if (!Object.hasOwn(operations, method)) error('invalid_command', 'Unknown storage operation');
      parentPort.postMessage({ id, result: operations[method](input) });
    } catch (failure) {
      if (!(failure instanceof RuntimeError)) storageFault = new RuntimeError('storage_failure', failure.message);
      parentPort.postMessage({ id, error: { code: failure instanceof RuntimeError ? failure.code : 'storage_failure', message: failure.message } });
    }
  });
  releaseStartup();
  parentPort.postMessage({ ready: true });
} catch (failure) {
  try { db?.close(); } catch {}
  releaseLock(); releaseStartup();
  parentPort.postMessage({ initializationError: { code: failure instanceof RuntimeError ? failure.code : 'storage_failure', message: failure.message } });
  parentPort.close();
}
