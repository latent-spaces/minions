import { validContextMeasurement, validNativeContext } from '../context-measurement.mjs';
import { createHash } from 'node:crypto';

export const RUNTIME_LIMITS = Object.freeze({ siteBytes: 300, identifierBytes: 256, scopeBytes: 8000, metadataBytes:12000, messageBytes: 16000, outcomeBytes: 32768 });

export class RuntimeError extends Error {
  constructor(code, message) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
const fail = message => { throw new RuntimeError('invalid_command', message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be an object`);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`${label} has missing or unknown fields`);
}
export function boundedText(value, label, maximum = RUNTIME_LIMITS.messageBytes) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || value.includes('\0')) fail(`${label} must be nonempty text of at most ${maximum} bytes`);
  return value;
}
export function validateTarget(target) {
  exact(target, ['site', 'ownerId', 'projectId', 'agentId'], 'target');
  boundedText(target.site, 'site', RUNTIME_LIMITS.siteBytes);
  let site;
  try { site = new URL(target.site); } catch { fail('site must be an HTTPS origin'); }
  const local = site.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(site.hostname);
  if ((!local && site.protocol !== 'https:') || site.origin !== target.site || site.username || site.password) fail('site must be an HTTPS or explicit loopback development origin');
  for (const key of ['ownerId', 'projectId', 'agentId']) boundedText(target[key], key, RUNTIME_LIMITS.identifierBytes);
  return target;
}
export function validateUuid(value, label) { if (typeof value !== 'string' || !uuid.test(value)) fail(`${label} must be a UUID`); return value; }
export function validateGeneration(value) { if (!Number.isSafeInteger(value) || value < 1) fail('generation must be a positive integer'); return value; }
export function validateCommand(command) {
  const kind = command?.kind;
  if (!['start', 'steer', 'stop', 'pause', 'resume'].includes(kind)) fail('unknown command kind');
  exact(command, ['version', 'operationId', 'kind', 'target', 'missionId', 'payload', ...(kind === 'start' ? [] : ['generation'])], 'command');
  if (command.version !== 2) fail('unsupported command version');
  validateUuid(command.operationId, 'operationId'); validateUuid(command.missionId, 'missionId'); validateTarget(command.target);
  if (kind === 'start') {
    // A job has no time limit. deadlineAt is accepted and ignored: a start saved on this computer before 10 November
    // 2026 (a reserved website start, or a receipt retried with its identical input) still carries one. Remove it with
    // the next local schema version.
    if (command.payload?.deadlineAt !== undefined && !Number.isSafeInteger(command.payload.deadlineAt)) fail('deadlineAt must be an integer');
    exact(command.payload, ['scope', 'execution', ...(command.payload?.deadlineAt === undefined ? [] : ['deadlineAt'])], 'start payload'); boundedText(command.payload.scope, 'scope', RUNTIME_LIMITS.scopeBytes);
    validateExecution(command.payload.execution);
  } else {
    validateGeneration(command.generation);
    exact(command.payload, kind === 'steer' ? ['message', ...(command.payload?.threadId === undefined ? [] : ['threadId'])] : kind === 'resume' ? ['pauseOperationId'] : [], `${kind} payload`);
    if (kind === 'steer') { boundedText(command.payload.message, 'message'); if(command.payload.threadId!==undefined && !/^[\w-]{1,200}$/.test(command.payload.threadId))fail('Invalid steering thread'); }
    if (kind === 'resume') validateUuid(command.payload.pauseOperationId, 'pauseOperationId');
  }
  return command;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
// threadId is cloud-assigned conversation metadata. Older reserved intents have
// only message; including metadata would conflict when those deliveries arrive.
export function commandFingerprint(command) { validateCommand(command); const intent=command.kind==='steer'?{...command,payload:{message:command.payload.message}}:command; return createHash('sha256').update(JSON.stringify(canonical(intent))).digest('hex'); }
export function sameTarget(a, b) { return a?.site === b?.site && a?.ownerId === b?.ownerId && a?.projectId === b?.projectId && a?.agentId === b?.agentId; }
export function isTerminalState(state) { return state === 'stopped' || state === 'failed'; }


export function validateExecution(execution) {
  fields(execution, ['provider', 'model'], [], 'execution');
  if (!['claude', 'codex'].includes(execution.provider)) fail('provider must be claude or codex');
  if (execution.model !== null && (typeof execution.model !== 'string' || !/^[A-Za-z0-9_:.-]{1,150}$/.test(execution.model))) fail('model must be a bounded identifier or null');
  return execution;
}
const fields = (value, required, optional, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || required.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(`Invalid ${label} fields`);
};
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,150}$/.test(value);
const safeCounter = value => value === null || Number.isFinite(value) && value >= 0 && value <= 1e15;
export function validateOutcome(value) {
  fields(value,['delivery','failed','interrupted','retryable','cleanupConfirmed'],['failureCode','usage','diagnostics','textTruncated','focus','permissionDenials','evidence','seen'],'outcome');
  if (value.seen !== undefined) {
    fields(value.seen,['project'],['revision','more','limit'],'seen');
    const limit = value.seen.limit;
    if (limit !== undefined) { exact(limit,['retryAt','resetAt','streak'],'seen limit');
      if (!Number.isSafeInteger(limit.retryAt) || limit.retryAt < 0 || limit.resetAt !== null && (!Number.isSafeInteger(limit.resetAt) || limit.resetAt < 0)
        || !Number.isSafeInteger(limit.streak) || limit.streak < 1) fail('Invalid seen provider limit'); }
    if (typeof value.seen.project !== 'string' || !/^[a-f0-9]{64}$/.test(value.seen.project)
      || value.seen.more !== undefined && value.seen.more !== true
      || value.seen.revision !== undefined && (!Number.isSafeInteger(value.seen.revision) || value.seen.revision < 0)) fail('Invalid seen project state');
  }
  if (!['not_submitted','submitted','acknowledged','rejected'].includes(value.delivery)) fail('Invalid outcome delivery');
  for (const key of ['failed','interrupted','retryable','cleanupConfirmed']) if (typeof value[key] !== 'boolean') fail(`Invalid ${key}`);
  if (value.textTruncated !== undefined && typeof value.textTruncated !== 'boolean') fail('Invalid textTruncated');
  if (value.failureCode !== undefined && !safeName(value.failureCode)) fail('Invalid failure code');
  if (value.evidence !== undefined) {
    exact(value.evidence,['availability','truncated','faults'],'run evidence');
    if (!['available','unavailable'].includes(value.evidence.availability) || typeof value.evidence.truncated !== 'boolean'
      || !Array.isArray(value.evidence.faults) || value.evidence.faults.length > 8 || value.evidence.faults.some(code => !safeName(code))) fail('Invalid run evidence status');
  }
  if (value.focus !== undefined && value.focus !== null) boundedText(value.focus, 'focus', 720);
  if (value.permissionDenials !== undefined) {
    const denials=value.permissionDenials; exact(denials,['count','tools'],'permissionDenials');
    if (!Number.isSafeInteger(denials.count) || denials.count<0 || !Array.isArray(denials.tools) || denials.tools.length>64 || denials.tools.some(tool=>!safeName(tool))) fail('Invalid permission denial observation');
  }
  if (value.usage !== undefined && value.usage !== null) {
    const u=value.usage; fields(u,[],['provider','inputSemantics','model','modelSource','tokens','toolCalls','toolScope','context','nativeContext'],'usage');
    for(const key of ['provider','inputSemantics','model','modelSource','toolScope']) if(u[key]!==undefined && u[key]!==null && !safeName(u[key])) fail('Invalid usage identity');
    if(u.nativeContext!==undefined&&!validNativeContext(u.nativeContext)) fail('Invalid native context observation');
    if(u.context!==undefined && !validContextMeasurement(u.context)) fail('Invalid context measurement');
    if(u.toolCalls!==undefined && !safeCounter(u.toolCalls)) fail('Invalid tool count');
    if(u.tokens!==undefined && u.tokens!==null){fields(u.tokens,[],['input','output','cacheRead','cacheWrite','modelCalls'],'token usage'); if(Object.values(u.tokens).some(n=>!safeCounter(n))) fail('Invalid token usage');}
  }
  if(value.diagnostics!==undefined && value.diagnostics!==null){
    const d=value.diagnostics; const names=['phase','signal','guard_signal','delivery']; const numbers=['request_id','elapsed_ms','frame_bytes_at_least','rpc_code','exit_code','guard_exit_code'];
    fields(d,[],[...names,...numbers,'truncated'],'diagnostics');
    for(const key of names) if(d[key]!==undefined&&d[key]!==null&&!safeName(d[key])) fail('Invalid diagnostic identifier');
    for(const key of numbers) if(d[key]!==undefined&&d[key]!==null&&(!Number.isFinite(d[key])||Math.abs(d[key])>1e15)) fail('Invalid diagnostic value');
    if(d.truncated!==undefined&&typeof d.truncated!=='boolean') fail('Invalid diagnostic flag');
  }
  if(Buffer.byteLength(JSON.stringify(value))>RUNTIME_LIMITS.metadataBytes) fail('Outcome metadata exceeds its bound');
  return value;
}
