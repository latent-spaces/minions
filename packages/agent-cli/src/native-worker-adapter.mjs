import { emptyPromptSources, validPromptSources } from './turn-context.mjs';
import { randomUUID } from 'node:crypto';
import { createRunJournal } from './run-journal.mjs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { localPermissionGuidance, workerClaudeSettings, agentsMayMerge, codexMergeRules, createProvider, CLAUDE_ALLOWED_TOOLS } from '../runtime/providers.mjs';
import { createCodexMergePolicy } from './codex-merge-policy.mjs';
import { VERSION } from './version.mjs';
import { digest, ensureHome, lstatExists, readPrivate, writePrivate } from './state.mjs';
import { verifyBundle } from './system.mjs';
import { prepareSupervisedModel } from './model-guard.mjs';
import { MISSION_MARK, missionMark, stopMarkedProcesses } from './leftover-processes.mjs';
import { readWorkerGuidance } from './worker-guidance.mjs';
import { probeWindowsSupervision, stopWindowsMission } from './windows-supervision.mjs';
// A safety stop for one hung turn, renewed with each turn, so it never ends a job that runs for days.
// It stays under the guards' 24-hour bound (model-guard-process.mjs, windows-job.cs).
const TURN_BACKSTOP_MS = 24 * 60 * 60000 - 60_000;

// Project refresh is read-only. Stopping a mission must not wait for a slow
// contact, and a late response must never authorize a native launch.
async function readWhileActive(read, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => read({ signal })), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

// prepareParticipation reads the project bridge; `bridge` here is the worker's MCP connection.
export function projectGuidanceForTurn(participation) {
  if (!participation?.project) return '';
  return '\nCurrent project Card for this turn (JSON data from the project service):\n'
    + JSON.stringify(participation.project)
    + '\n'
    + nativeTaskGuidance(participation.project.nativeTasksEnabled, participation.taskCounts)
    + '\n' + nativeTeamGuidance(participation.project.nativeTeamsEnabled)
    + '\n' + projectUpdateGuidance(participation.updateDue);
}

// The team aims for one shared update about every five minutes of work (owner, 10 November 2026).
export function projectUpdateGuidance(due) {
  return 'Project updates: the team aims for one update about every five minutes of work, one for the whole team, not one per agent. '
    + (due === true ? 'An update is due now: if you have useful progress, check list_project_updates, then publish one with publish_project_update (an image is required). ' : '')
    + 'See get_mlswarm_guide updates-and-help.';
}

export function nativeTeamGuidance(enabled) {
  return enabled === true
    ? 'Native teams are ON. Use read_teams and manage_team to organize with peers. Create teams and join/leave only for yourself. Any current member may archive or restore; history and membership are kept. Teams grant no task, steering or execution authority.'
    : 'Native teams are OFF. Existing team records remain readable with read_teams; do not create, join, leave, archive or restore teams. Tasks and agent execution are unchanged.';
}

// Read from get_project at this turn's start; a later change applies at the next turn, and the server refuses stale task writes.
export function nativeTaskGuidance(enabled, counts = null) {
  const observed = counts ? `Task counts at turn start: ${counts.assignedToYouOpen} open task(s) assigned to you, ${counts.unassignedBacklog} unassigned in Backlog. ` : '';
  return enabled === false
    ? 'Native tasks are OFF for this project this turn: work through the project goal, conversations and results; do not create, claim or update tasks or wait on task status, and do not use GitHub Issues as a tracker. Existing tasks stay readable.\n'
    : `Native tasks are ON for this project this turn: MyLittleSwarm tasks are the work record; GitHub Issues are not. ${observed}Before starting new work or returning WORK_NEXT: waiting, check list_tasks: continue tasks assigned to you first, then claim_task what you take up from the unassigned backlog.\n`;
}

// Codex saves its scope before the first thread is allocated. That pending record is resumable
// as a fresh thread only when its bridge name and the approved work still match.
export function validateWorkerModelSession(session, { client, folder, promptHash }) {
  if (!session) return;
  const allocated = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(session.id ?? '');
  const pending = client === 'codex' && session.id === null && /^project_[a-f0-9]{32}$/.test(session.mcpName ?? '');
  if ((!allocated && !pending) || session.provider !== client || session.repoDir !== folder || session.promptHash !== promptHash)
    throw new Error('Saved worker model session belongs to different approved work. Use a fresh work session.');
}

// When a provider limit resets, if the error text names it; null otherwise, or when the time is past or more than 7 days
// away. Shapes: Claude Code's "Claude AI usage limit reached|<epoch seconds>", a "try again in 2 hours 5 minutes"
// duration and a "retry after <seconds>" hint. None of them comes from a recorded native run.
export function providerLimitResetAt(text, now = Date.now()) {
  let at = null;
  const epoch = /usage limit reached\|(\d{10,13})\b/i.exec(text);
  if (epoch) at = epoch[1].length === 13 ? Number(epoch[1]) : Number(epoch[1]) * 1000;
  const after = /retry[- ]after:?\s*(\d{1,7})\b/i.exec(text);
  if (at === null && after) at = now + Number(after[1]) * 1000;
  const within = /try again in\s+((?:\d{1,5}\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (at === null && within) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
    at = now + [...within[1].matchAll(/(\d+)\s*([dhms])/gi)].reduce((sum, [, n, u]) => sum + Number(n) * unit[u.toLowerCase()], 0);
  }
  return Number.isSafeInteger(at) && at > now && at <= now + 7 * 86_400_000 ? at : null;
}

// Persist only allowlisted scalar evidence. Native stderr, RPC error text and
// conversation/tool bodies can contain credentials or project content.
export function modelTurnOutcome({ stream, stderr = '', exitCode = null, signal = null, nativeExit = null, persistenceFault = false, interrupted = false, now = Date.now() }) {
  const failed = !interrupted && Boolean(persistenceFault || (stream.closed && stream.report ? 0 : exitCode) !== 0 || stream.report?.is_error || !stream.report);
  // Classify only terminal error fields. Codex result and successful Claude result are the model's
  // own final text, which may quote "unauthorized" or "429" without the turn failing for that reason.
  const diagnostics = `${stderr} ${stream.report?.errors?.join(' ') ?? ''} ${stream.provider === 'claude' && stream.report?.is_error ? stream.report.result ?? '' : ''}`;
  // Provider usage limits, 429 rate limits and 529 overload are temporary: the worker waits for the reset and tries again.
  const providerLimited = [undefined, 'native_turn_failed', 'native_rpc_error'].includes(stream.failure?.code)
    && /(?:\b(?:429|529)\b|rate[ _-]?limit|usage limit|too many requests|overloaded|quota (?:exceeded|reached)|limit reached)/i.test(diagnostics);
  const failureCode = persistenceFault ? 'private_state_failure' : providerLimited ? 'provider_limited' : /(?:not logged in|authentication|unauthorized|login required|invalid api key)/i.test(diagnostics) ? 'authentication_required' : /(?:permission denied|not permitted|approval required|tool.*refused)/i.test(diagnostics) ? 'permission_required' : stream.failure?.code ?? 'local_execution_failure';
  const detail = { phase: stream.failure?.phase ?? stream.phase ?? (stream.delivery === 'acknowledged' ? 'turn' : 'spawn'),
    request_id: stream.failure?.request_id ?? stream.requestId ?? null, elapsed_ms: stream.failure?.elapsed_ms ?? (Number.isFinite(stream.attachedAt) ? Math.max(0, Date.now() - stream.attachedAt) : null),
    frame_bytes_at_least: stream.failure?.frame_bytes_at_least ?? null, rpc_code: stream.failure?.rpc_code ?? null,
    exit_code: Number.isSafeInteger(nativeExit?.exitCode) ? nativeExit.exitCode : null,
    signal: /^SIG[A-Z0-9]{1,12}$/.test(nativeExit?.signal ?? '') ? nativeExit.signal : null,
    guard_exit_code: Number.isSafeInteger(exitCode) ? exitCode : null,
    guard_signal: /^SIG[A-Z0-9]{1,12}$/.test(signal ?? '') ? signal : null,
    truncated: stream.truncated === true, delivery: stream.delivery };
  const limitResetAt = failed && failureCode === 'provider_limited' ? providerLimitResetAt(diagnostics, now) : null;
  return { ...(failed ? { failureCode } : {}), ...(limitResetAt !== null ? { limitResetAt } : {}), diagnostics: detail,
    retryable: failed && !['private_state_failure', 'authentication_required', 'permission_required', 'merge_policy_unavailable', 'native_protocol_frame_too_large', 'native_protocol_error', 'native_interactive_request'].includes(failureCode)
      // Only Claude's terminal refusal with zero turns proves the prompt never ran; otherwise
      // an uncertain submission stays protected from a duplicate retry.
      && (stream.delivery !== 'submitted' || failureCode === 'provider_limited' && stream.report?.is_error === true && stream.report.num_turns === 0),
    interrupted, failed,
    delivery: stream.delivery, text: stream.report?.result ?? stream.finalText ?? '' };
}

export async function createLocalWorkerAdapter({ client, model, effort, folder, stateDir, bridge, journalIdentity, scope, prepareParticipation, executables = { claude: 'claude', codex: 'codex' }, envSource = process.env, signal, firstLaunchByAt = null }) {
  signal?.throwIfAborted();
  verifyBundle(); ensureHome(stateDir);
  const configuredEndpoint = client === 'claude' ? envSource.ANTHROPIC_BASE_URL : envSource.OPENAI_BASE_URL;
  if (configuredEndpoint && (() => { try { const endpoint = new URL(configuredEndpoint); return endpoint.protocol !== 'https:' || endpoint.origin !== (client === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com'); } catch { return true; } })()) throw new Error('This worker adapter cannot preserve your custom API endpoint. Use the current-chat MCP mode rather than silently switching your model backend.');
  const settings = { claude: executables.claude, codex: executables.codex, model, effort, repoDir: folder, permissionMode: 'acceptEdits', allowedTools: CLAUDE_ALLOWED_TOOLS, passEnv: '', turnBudgetUsd: 0 };
  const provider = createProvider(client, settings, { envSource });
  if (process.platform === 'win32') await probeWindowsSupervision({ env: provider.environment(), signal });
  const mergePolicy = client === 'codex' ? createCodexMergePolicy({ folder, stateDir, env: provider.environment() }) : null;
  await provider.preflight({ signal });
  signal?.throwIfAborted();
  const instructions = readPrivate(join(stateDir, 'instructions.md'));
  const guides = readWorkerGuidance(stateDir, instructions);
  const promptHash = guides ? digest(JSON.stringify([instructions, guides.sha256])) : digest(instructions);
  const sessionFile = join(stateDir, 'model-session.json');
  let session = lstatExists(sessionFile) ? readPrivate(sessionFile, true) : null;
  validateWorkerModelSession(session, { client, folder, promptHash });
  const journal = createRunJournal({ directory: stateDir, identity: journalIdentity, redact: [bridge?.token] });
  let firstSpawnPending = true, firstSubmissionPending = true;
  const launchExpired = () => firstLaunchByAt !== null && Date.now() >= firstLaunchByAt;
  if (firstLaunchByAt !== null && (!Number.isSafeInteger(firstLaunchByAt) || firstLaunchByAt < 1)) throw new Error('Invalid first-launch deadline.');
  // Every process this adapter's turns start inherits it; see leftover-processes.mjs.
  const mark = missionMark(journalIdentity);
  return {
    async stopLeftovers() { const result = process.platform === 'win32' ? await stopWindowsMission(mark, { env: provider.environment() }) : await stopMarkedProcesses(mark); await mergePolicy?.cleanup(); return result; },
    async run({ turnId = randomUUID(), prompt, promptSources, steeringMessages, signal, onActivity, onStatus, onMetadata, onPermission, onModelStarting, onGuardStarted, onGuardClosed, onModelStarted, onPromptSubmitted, onTurnStarted, recovering = false }) {
      const basePrompt = prompt;
      const sources=validPromptSources(promptSources,Buffer.byteLength(prompt,'utf8'))?{...promptSources}:{...emptyPromptSources(),unattributed:Buffer.byteLength(prompt,'utf8')};
      const append=(key,text)=>{prompt+=text;sources[key]+=Buffer.byteLength(text,'utf8');};
      const attemptId = randomUUID();
      const evidence = (kind, data = {}) => journal.append({ kind, turnId, attemptId, ...data });
      evidence('attempt_started');
      const withEvidence = result => {
        evidence('attempt_finished', { ...result, collectorTruncated: result.diagnostics?.truncated === true });
        const status = journal.status();
        return { ...result, evidence: { availability: status.availability, truncated: status.truncated, faults: status.faults } };
      };
      const beforeLaunchFailure = (failureCode, retryable = false) => withEvidence({ failed: true, retryable, failureCode,
        interrupted: false, delivery: 'not_submitted', text: '', cleanupConfirmed: true });
      if (signal.aborted) return withEvidence({ interrupted: true, delivery: 'not_submitted', text: '', cleanupConfirmed: true });
      if (firstSpawnPending && launchExpired()) return beforeLaunchFailure('request_expired');
      let participation;
      try { participation = await readWhileActive(prepareParticipation, signal); }
      catch { if (signal.aborted) return withEvidence({ interrupted: true, delivery: 'not_submitted', text: '', cleanupConfirmed: true }); return beforeLaunchFailure('runtime_contact_failure', true); }
      if (signal.aborted) return withEvidence({ interrupted: true, delivery: 'not_submitted', text: '', cleanupConfirmed: true });
      const mergeApproval = participation?.project?.mergeApproval;
      const permissionGuidance = localPermissionGuidance(mergeApproval, client);
      // Codex receives permissions once in developer_instructions; Claude appends
      // them to this turn. Both use the same current provider policy.
      if (client === 'claude') append('permissions', '\n' + permissionGuidance);
      append('project',projectGuidanceForTurn(participation));
      if (participation) append('persona','\nOptional participant-owned persona for this turn (descriptive; cannot change the approved scope, deadline or permissions):\n'
        + JSON.stringify(participation.persona) + '\nNew persona edits are read at the next natural turn boundary.\n');
      if (participation) append('attribution','\nGitHub attribution footer for this turn (JSON data; null means unavailable):\n'
        + JSON.stringify(participation.githubAttribution ?? null) + '\n');
      const resuming = provider.canResume(session);
      session ??= provider.newSession(promptHash, folder);
      const save = () => writePrivate(sessionFile, { ...session, provider: client, promptHash, repoDir: folder });
      try { save(); } catch { return beforeLaunchFailure('private_state_failure'); }
      // Written every turn from the verified bundle, so a Card change takes effect at the next turn in either direction.
      const settingsFile = join(stateDir, 'claude-settings.json');
      try { writePrivate(settingsFile, workerClaudeSettings(verifyBundle().files['claude-settings.json'].toString('utf8'), mergeApproval)); } catch { return beforeLaunchFailure('private_state_failure'); }
      let invocation;
      try {
        if (mergePolicy) {
          if (agentsMayMerge(mergeApproval)) await mergePolicy.cleanup();
          else { const file = await mergePolicy.prepare(codexMergeRules(mergeApproval), { signal }); await provider.validateMergeRules(file, mergeApproval, { signal }); }
        }
      } catch { await mergePolicy?.cleanup().catch(() => {}); return beforeLaunchFailure('merge_policy_unavailable'); }
      try { invocation = await provider.invocation({ prompt, permissionGuidance, instructionsFile: join(stateDir, 'instructions.md'), settingsFile, mcpConfig: join(stateDir, 'mcp.json'), bridge, session, resuming, repoDir: folder, clientVersion: VERSION, signal, requireMergePolicy: client === 'codex' && !agentsMayMerge(mergeApproval) }); }
      catch { await mergePolicy?.cleanup(); if (signal.aborted) return withEvidence({ interrupted: true, delivery: 'not_submitted', text: '', cleanupConfirmed: true }); return beforeLaunchFailure('native_preparation_failure'); }
      if (firstSpawnPending && launchExpired()) { await mergePolicy?.cleanup(); return beforeLaunchFailure('request_expired'); }
      try { await onModelStarting?.(); } catch { await mergePolicy?.cleanup(); return beforeLaunchFailure('private_state_failure'); }
      if (signal.aborted) { await mergePolicy?.cleanup(); return withEvidence({ interrupted: true, delivery: 'not_submitted', text: '', cleanupConfirmed: true }); }
      const result = await new Promise(resolve => {
        // A job has no time limit. The guard only bounds one turn as a last resort if this service dies.
        const deadline = Date.now() + TURN_BACKSTOP_MS;
        let done = false, interrupted = false, persistenceFault = false, killTimer, forceTimer, stderr = '';
        let nativeReported = false, nativeExit = null, cleanupConfirmed = false, launchAuthorized = false, startExpired = false;
        let child, guardCommit;
        const failPersistence = () => {
          persistenceFault = true;
          if (!child || done) return;
          child.kill('SIGTERM');
          clearTimeout(forceTimer); forceTimer = setTimeout(() => child.kill('SIGKILL'), 8000);
        };
        const stream = provider.collector({ rpc: invocation.rpc, assistantText: text => evidence('assistant_text', { text }),
          action: name => { evidence('tool', { name }); onActivity?.(name); },
          status: text => { evidence('status', { text }); onStatus?.(text); },
          metadata: value => { if (value.model) evidence('model', { name: value.model }); onMetadata?.(value); },
          permission: value => { evidence('permission', { name: value.tool, ...(typeof value.command === 'string' ? { command: value.command } : {}) }); onPermission?.(value); },
          submitted: async () => {
            if (firstSubmissionPending && launchExpired()) { startExpired = true; throw new Error('First prompt authorization expired.'); }
            await onPromptSubmitted?.();
            if (firstSubmissionPending && launchExpired()) { startExpired = true; throw new Error('First prompt authorization expired.'); }
            firstSubmissionPending = false; evidence('submitted');
          },
          started: async () => { evidence('acknowledged'); await onTurnStarted?.(); }, persistence: failPersistence,
          session: id => { evidence('session', { sessionId: id }); session.id = id; save(); } });
        // Prepare an idle guard and attach every observer before awaiting a durable
        // PID commit. Only this trusted adapter can authorize the native executable.
        child = prepareSupervisedModel({ cwd: folder, env: provider.environment({ ...invocation.env, [MISSION_MARK]: mark }), stdio: [invocation.rpc ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, deadline, launchByAt: firstSpawnPending ? firstLaunchByAt : null });
        const interrupt = () => {
          interrupted = true;
          if (launchAuthorized && invocation.rpc) stream.interrupt(); else child.kill('SIGINT');
          clearTimeout(killTimer); clearTimeout(forceTimer);
          killTimer = setTimeout(() => child.kill('SIGTERM'), 3000);
          forceTimer = setTimeout(() => child.kill('SIGKILL'), 8000);
        };
        signal.addEventListener('abort', interrupt, { once: true });
        child.on('message', value => {
          if (value?.cleanupConfirmed === true) cleanupConfirmed = true;
          if (value?.guardStop === 'deadline') interrupted = true;
          if (value?.nativeClosed) nativeExit = value.nativeClosed;
          if (!nativeReported && Number.isSafeInteger(value?.nativeStarted) && value.nativeStarted > 0) {
            nativeReported = true; evidence('native_started', { pid: value.nativeStarted });
            try { Promise.resolve(onModelStarted?.(value.nativeStarted)).catch(failPersistence); }
            catch { failPersistence(); }
          }
        });
        const finish = async (code, closeSignal) => {
          if (done) return; done = true;
          try { stream.end(); await stream.drainPersistence(); } catch { persistenceFault = true; }
          stream.cleanup?.(); clearTimeout(killTimer); clearTimeout(forceTimer); signal.removeEventListener('abort', interrupt);
          if (stream.sessionId) session.id = stream.sessionId;
          if (stream.tokenTotals) session.tokenTotals = stream.tokenTotals;
          try { save(); } catch { persistenceFault = true; }
          const cleaned = cleanupConfirmed || !launchAuthorized;
          if (cleaned) {
            try {
              // A stop may close the idle guard while its PID commit is pending.
              // Clear only this exact, proven-clean guard after that commit settles.
              await guardCommit?.catch(() => {});
              if (Number.isSafeInteger(child.pid)) await onGuardClosed?.({ guardPid: child.pid, cleanupConfirmed: true });
            } catch { persistenceFault = true; }
          }
          resolve({ missingSession: !interrupted && !persistenceFault && Boolean(provider.missingSession?.(stderr)),
            // An unauthorized idle guard cannot have started native work, even
            // when it was stopped before installing its IPC/signal handlers.
            cleanupConfirmed: cleaned,
            ...modelTurnOutcome({ stream, stderr, exitCode: code, signal: closeSignal, nativeExit, persistenceFault, interrupted }),
            ...(startExpired ? {failed:true,retryable:false,failureCode:'request_expired',...(!launchAuthorized ? {delivery:'not_submitted'} : {})} : {}), usage: {
            ...provider.usage(stream.report, stream.init), toolCalls: stream.toolCalls,
            ...(stream.nativeContext?{nativeContext:{...stream.nativeContext}}:{}),
            context: { instructionBytes: Buffer.byteLength(instructions + (client === 'codex' ? '\n' + permissionGuidance : '')),
              turnPromptBytes: Buffer.byteLength(prompt), promptSources:sources, sessionMode:resuming?'resumed':'new',
              ...(Number.isSafeInteger(steeringMessages)&&steeringMessages>=0&&steeringMessages<=64?{steeringMessages}:{}) },
            toolScope: interrupted || stream.truncated || !stream.report || stream.report.is_error ? 'partial' : 'provider-stream',
          } });
        };
        child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { try { stream.feed(chunk); } catch { failPersistence(); } });
        child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
        // `close` follows `error` after stream shutdown and is the only completion
        // boundary. An error is not proof that a native process tree was cleaned up.
        child.once('error', failPersistence); child.once('close', finish);
        if (invocation.rpc) child.stdin.on('error', () => {});
        const authorize = async () => {
          try {
            if (signal.aborted) return interrupt();
            if (firstSpawnPending && launchExpired()) { startExpired = true; return child.kill('SIGTERM'); }
            if (!child.pid) throw new Error('Worker guard PID is unavailable.');
            evidence('guard_started', { pid: child.pid });
            guardCommit = Promise.resolve(onGuardStarted?.(child.pid));
            await guardCommit;
            if (done || interrupted || signal.aborted || persistenceFault) return;
            // Claude receives -p at launch; Codex commits just before turn/start.
            if (client === 'claude') await stream.submitPrompt();
            if (done || interrupted || signal.aborted || persistenceFault) return;
            if (firstSpawnPending && launchExpired()) { startExpired = true; return child.kill('SIGTERM'); }
            child.authorize(invocation.command, invocation.args); launchAuthorized = true; firstSpawnPending = false;
            if (invocation.rpc) stream.attach(child);
          } catch { failPersistence(); }
        };
        void authorize();
      });
      if (result.cleanupConfirmed) await mergePolicy?.cleanup();
      if (result.missingSession && result.cleanupConfirmed && !recovering && !signal.aborted && result.delivery !== 'acknowledged') { session = null; rmSync(sessionFile, { force: true }); withEvidence(result); return this.run({ turnId, prompt: basePrompt, promptSources, steeringMessages, signal, deadline, onActivity, onStatus, onMetadata, onPermission, onModelStarting, onGuardStarted, onGuardClosed, onModelStarted, onPromptSubmitted, onTurnStarted, recovering: true }); }
      if (result.missingSession) { result.failed = true; result.retryable = false; result.failureCode = 'session_recovery_failed'; }
      delete result.missingSession; return withEvidence(result);
    },
  };
}

