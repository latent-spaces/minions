import { fitContextTelemetry } from '../context-measurement.mjs';
import { controllerPrompt } from '../turn-context.mjs';
import { randomUUID } from 'node:crypto';
import { MAX_REMAINING_MS } from '../run-length.mjs';
import { validateMissionRecovery, missionRecoveryFingerprint, settledExecution, assertRecoveryCheckout } from './mission-recovery.mjs';
import { createWorkController, newsFingerprint } from '../../runtime/work-controller.mjs';
import { countedTokens, tokenCapReached } from './token-cap.mjs';
import { RuntimeError, validateCommand, commandFingerprint, sameTarget, RUNTIME_LIMITS } from './contracts.mjs';

// Adapter selection belongs to the composition root. No executable, environment
// or credential can be supplied through a public command.
// Bound on the extra delay of a session sync after a project change (C6-S). Default 0: the sync after a change is
// immediate, as before C6-S. The spread (tested at 2000 ms) is an owner opt-in, because it delays non-pause
// confirmations by up to 2 s and two local pairs showed slower pause-window delivery with it on (cause open).
// A Pause confirmation is never spread.
export const ON_CHANGE_SPREAD_MS = 0;
// Tolerated clock difference with the server, as for web starts.
const CLOCK_SKEW_MS = 30000;
export function createRuntimeControllers({ store, adapterFactory, cloudFactory, onReportsReady = () => {}, inspectRecoveryCheckout, stopOrphanedMission, now = Date.now, observeIntervalMs = 20000, random = Math.random, onChangeSpreadMs = ON_CHANGE_SPREAD_MS }) {
  if (!Number.isSafeInteger(observeIntervalMs) || observeIntervalMs < 1) throw new Error('A positive trusted observation interval is required.');
  if (typeof adapterFactory !== 'function') throw new Error('A mission-local adapter factory is required.');
  if (typeof random !== 'function') throw new Error('A random source is required.');
  if (!Number.isSafeInteger(onChangeSpreadMs) || onChangeSpreadMs < 0) throw new Error('A non-negative change spread is required.');
  // Failure back-off is spread over [1, 1.5) x its base, never below Retry-After: a deploy or an
  // outage fails every computer's holds and ticks at once, and they must not all return together.
  const spread = ms => Math.min(3600000, Math.round(ms * (1 + 0.5 * Math.min(Math.max(Number(random()) || 0, 0), 0.999))));
  const controllers = new Map(), operations = new Map(), pendingPauses = new Map();
  let tail = Promise.resolve(), closed = false;
  const ready = Promise.all([store.listOperations(), store.listMissions()]).then(([receipts, missions]) => {
    for (const receipt of receipts) operations.set(receipt.operationId, { fingerprint: receipt.fingerprint, accepted: true });
    // Waiting survives a connector restart (owner decision, 9 November 2026). The store kept only missions
    // that were between turns with confirmed cleanup; each continues in the same mission, paused ones stay paused.
    for (const mission of missions) if (['accepted', 'starting', 'waiting', 'paused'].includes(mission.state) || mission.reason === 'report_attention') createController(mission, { restored: true });
  });
  // Retain rejection for callers while avoiding an unobserved startup failure.
  ready.catch(() => {});
  const serialize = fn => { const task = tail.then(fn); tail = task.catch(() => {}); return task; };
  const cloudFatal = error => error?.fatal === true || ['unauthorized', 'forbidden', 'run_superseded', 'runtime_conflict'].includes(error?.code);
  const reportReady = () => { try { Promise.resolve(onReportsReady()).catch(() => {}); } catch {} };
  function cloudRequest(ctrl, read) {
    const signal = ctrl.lifetime.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  // Focus goes out once, when the model prints it. A send refused for a passing reason (rate limit, network, 5xx) stays
  // pending and the cloud tick resends it, with the same request ID and sequence, until it is confirmed or a newer status
  // replaces it; otherwise the app and MCP would show the old focus until the next status line.
  const TRANSIENT_STATUS_FAILURES = new Set(['unavailable', 'rate_limited', 'project_busy', 'internal_error', 'http_failure', 'invalid_reply']);
  function sendStatus(ctrl, value) {
    ctrl.statusPending = value;
    return cloudRequest(ctrl, () => ctrl.cloud.reportStatus(ctrl.mission, value, { signal: ctrl.lifetime.signal })).then(() => {
      if (ctrl.statusPending === value) ctrl.statusPending = null;
    }, error => {
      if (ctrl.cancelled) return;
      if (['unauthorized', 'forbidden', 'run_superseded'].includes(error?.code)) { ctrl.statusPending = null; cloudFailure(ctrl, error); }
      // Only a passing failure keeps it pending; any other refusal would never succeed and is dropped.
      else if ((error?.fatal || !TRANSIENT_STATUS_FAILURES.has(error?.code)) && ctrl.statusPending === value) ctrl.statusPending = null;
    });
  }
  function cloudFailure(ctrl, error) {
    ctrl.news = null;
    if (cloudFatal(error)) { latchStop(ctrl, 'cloud_refused'); ctrl.releaseStop?.(); schedule(ctrl); }
    else {
      const retryMs = spread(Math.max(observeIntervalMs, (Number(error?.retryAfter) || 0) * 1000));
      ctrl.cloudRetryAt = Math.max(ctrl.cloudRetryAt ?? 0, now() + retryMs);
      clearTimeout(ctrl.retryTimer); ctrl.retryTimer = setTimeout(() => { void cloudTick(ctrl); schedule(ctrl); }, retryMs); ctrl.retryTimer.unref?.();
    }
  }
  const projectPauseSettled = ctrl => ctrl.projectPaused && !ctrl.turnBusy && ctrl.nativeCleanupConfirmed !== false && !ctrl.halted && !pauseUpdateDue(ctrl);
  // After a project Pause, an agent whose latest turn was work runs one short turn that only posts an update
  // (owner, 10 November 2026). Not for an agent paused on its own, stopped, detached or at its token cap.
  const pauseUpdateDue = ctrl => {
    const last = ctrl.mission?.outcomes?.at(-1)?.outcome;
    return ctrl.projectPaused === true && ctrl.projectControl?.closed !== true && !ctrl.cancelled && !ctrl.detached && !ctrl.halted
      && !locallyPaused(ctrl) && !ctrl.turnBusy && !!ctrl.news?.project && ctrl.nativeCleanupConfirmed !== false
      && (!ctrl.cloud || ctrl.tokenLimit !== undefined && !capReached(ctrl))
      && !!last && last.pauseUpdate !== true && last.delivery === 'acknowledged';
  };
  async function runPauseUpdate(ctrl) {
    ctrl.turnBusy = true;
    try { ctrl.adapter ??= await adapterFactory(ctrl.mission, { signal: ctrl.lifetime.signal }); await runTurn(ctrl, 'pause_update'); }
    finally { ctrl.turnBusy = false; if (ctrl.cloud && !ctrl.cancelled && !ctrl.settled) refreshCloud(ctrl); }
  }
  const executionHeld = ctrl => ctrl.detached || locallyPaused(ctrl) || ctrl.projectPaused;
  const cloudSession = (ctrl, mission) => ({ missionId: mission.missionId, generation: mission.generation,
    startedAt: mission.cloudRun.startedAt, deadlineAt: ctrl.appliedDeadlineAt ?? mission.deadlineAt,
    remainingSlots: Math.max(0, 64 - mission.steering.length), tokens: countedTokens(mission.outcomes),
    ...(projectPauseSettled(ctrl) && ctrl.projectControl?.pauseRequest ? { projectPauseRevision: ctrl.projectControl.pauseRequest.revision } : {}),
    phase: ctrl.cancelled ? 'stopped' : projectPauseSettled(ctrl) ? 'paused' : mission.state === 'paused' ? 'paused' : mission.state === 'pausing' ? 'working' : mission.state === 'running' ? 'working' : mission.state === 'blocked' ? 'blocked' : 'waiting',
    // A worker held by a provider limit says so, with the provider's reset time when it named one.
    ...(!ctrl.cancelled && mission.state === 'waiting' && ctrl.scheduler.status().limited ? { providerLimit: { retryAt: ctrl.scheduler.status().limited.resetAt } } : {}),
  });
  async function applyExtension(ctrl, deadlineAt) {
    if (deadlineAt === undefined || deadlineAt <= (ctrl.appliedDeadlineAt ?? ctrl.mission.deadlineAt)) return;
    await serialize(async () => {
      const applied = ctrl.appliedDeadlineAt ?? ctrl.mission.deadlineAt;
      // An end that has passed by the time the reply arrives leaves the worker waiting for more time.
      if (ctrl.cancelled || ctrl.settled || deadlineAt <= now()) return;
      // Added time may arrive after the end time passed: the waiting worker then continues. Later, and at most 24 hours away.
      if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= applied || deadlineAt - now() > MAX_REMAINING_MS + CLOCK_SKEW_MS)
        throw new RuntimeError('invalid_cloud_reply', 'Cloud deadline authorization is invalid.');
      const mission = await store.applyCloudDeadline({ missionId: ctrl.mission.missionId, generation: ctrl.mission.generation, deadlineAt });
      if (ctrl.cancelled || ctrl.settled) return;
      ctrl.scheduler.setDeadline(deadlineAt); ctrl.scheduler.requestContinuation();
      ctrl.appliedDeadlineAt = deadlineAt; ctrl.mission = mission;
      schedule(ctrl);
    });
  }
  // The cap is the server's, heard in each session reply; the tokens are counted from the stored outcomes. A worker at
  // the cap waits after the turn that crossed it, and continues once the cap is raised or removed.
  const capReached = ctrl => tokenCapReached(countedTokens(ctrl.mission.outcomes), ctrl.tokenLimit);
  function applyTokenLimit(ctrl, limit) {
    const before = ctrl.tokenLimit === undefined ? undefined : capReached(ctrl);
    ctrl.tokenLimit = limit;
    if (before === true && !capReached(ctrl)) { ctrl.scheduler.requestContinuation(); schedule(ctrl); }
  }
  function applyProjectControl(ctrl, project) {
    if (Number.isSafeInteger(ctrl.projectControl?.revision)
      && (!Number.isSafeInteger(project.revision) || project.revision < ctrl.projectControl.revision)) {
      if (ctrl.news) ctrl.news = { ...ctrl.news, project: ctrl.projectControl };
      return;
    }
    ctrl.projectControl = project;
    ctrl.projectPaused = project.paused === true;
    if (ctrl.news) ctrl.news = { ...ctrl.news, project };
    if (project.closed === true) { latchStop(ctrl, 'project_closed'); ctrl.releaseStop?.(); }
    // A paused project lets the running turn finish; the scheduler then waits.
    schedule(ctrl);
  }
  function refreshCloud(ctrl) {
    if (ctrl.cloudPolling) ctrl.cloudRefreshRequested = true;
    else void cloudTick(ctrl, { projectOnly: true });
  }
  // A project change reaches every session of the project at once (one shared listener per server, one held
  // request per computer), so an immediate sync from each would arrive as one burst of C_p session syncs. The
  // sync after a change is spread over onChangeSpreadMs instead; the change itself is applied at once. A new
  // Pause syncs at once, because owners wait for its confirmation: a worker between turns confirms it then, and one
  // in a turn confirms it when that turn ends. Changes inside the window coalesce.
  function refreshAfterChange(ctrl, project) {
    const pause = project.paused === true && Number.isSafeInteger(project.pauseRequest?.revision) ? project.pauseRequest.revision : undefined;
    if (pause !== undefined && pause > (ctrl.confirmingPause ?? 0)) {
      ctrl.confirmingPause = pause;
      ctrl.cancelChangeSync?.();
      refreshCloud(ctrl);
      return;
    }
    if (onChangeSpreadMs === 0) { refreshCloud(ctrl); return; }
    if (ctrl.changeTimer) return;
    const delay = Math.floor(onChangeSpreadMs * Math.min(Math.max(Number(random()) || 0, 0), 0.999));
    // One pending sync per member; firing, a Pause and the member's end all clear the timer and its abort listener.
    const cancel = () => {
      clearTimeout(ctrl.changeTimer); ctrl.changeTimer = null; ctrl.cancelChangeSync = null;
      ctrl.lifetime.signal.removeEventListener('abort', cancel);
    };
    ctrl.changeTimer = setTimeout(() => { cancel(); if (!ended(ctrl)) refreshCloud(ctrl); }, delay);
    ctrl.changeTimer.unref?.();
    ctrl.cancelChangeSync = cancel;
    ctrl.lifetime.signal.addEventListener('abort', cancel, { once: true });
  }
  // One held project-control request per project per process, not per mission. The answer is
  // project-level state only (started, paused, closed, revision), identical for every member; it is
  // applied to each member like its own hold would be. It never authorizes work: each mission's own
  // tick still fences its run, deadline and steering. A live member's credential holds; when that
  // member ends, the next one takes over with the same revision.
  const projectWatches = new Map();
  function watchProject(ctrl) {
    if (typeof ctrl.cloud?.projectControl !== 'function' || ctrl.projectWatcher) return;
    const key = JSON.stringify([ctrl.mission.target.site, ctrl.mission.target.projectId]);
    let group = projectWatches.get(key);
    if (!group) projectWatches.set(key, group = { members: new Set(), revision: undefined, latest: undefined });
    group.members.add(ctrl); ctrl.projectWatcher = group;
    if (group.latest) {
      // A member joins after its own first report. If the group already holds newer state than that report carried
      // (a change landed in between), sync it like any member that received the change, or its Pause confirmation
      // would wait for the next periodic tick.
      const known = ctrl.projectControl?.revision;
      applyProjectControl(ctrl, group.latest);
      if (Number.isSafeInteger(group.latest.revision) && !(Number.isSafeInteger(known) && known >= group.latest.revision)) refreshAfterChange(ctrl, group.latest);
    }
    group.loop ??= holdProject(key, group);
  }
  const ended = ctrl => ctrl.cancelled || ctrl.settled || ctrl.lifetime.signal.aborted;
  async function holdProject(key, group) {
    for (;;) {
      for (const member of group.members) if (ended(member)) group.members.delete(member);
      // Checked and removed in one synchronous step, so a later joiner starts a new group.
      if (!group.members.size) { projectWatches.delete(key); return; }
      const ctrl = group.members.values().next().value;
      try {
        const project = await cloudRequest(ctrl, () => ctrl.cloud.projectControl(ctrl.mission,
          { afterRevision: group.revision, signal: ctrl.lifetime.signal }));
        if (ended(ctrl)) continue;
        // Revisions only increase. An older answer (a lagging server listener at its timeout) is
        // never applied and never lowers the group's revision; hold again for newer state.
        if (Number.isSafeInteger(group.revision) && Number.isSafeInteger(project?.revision) && project.revision < group.revision) {
          // A server that answers older state at once (e.g. one not yet on C4-6 during a rollout) must not
          // turn this into a tight loop: wait a twentieth of the tick before holding again.
          await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); ctrl.lifetime.signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, Math.max(1, Math.round(observeIntervalMs / 20)));
            timer.unref?.(); ctrl.lifetime.signal.addEventListener('abort', finish, { once: true });
            if (ctrl.lifetime.signal.aborted) finish();
          });
          continue;
        }
        // An unchanged held-request timeout only re-holds; the periodic tick
        // and end-of-turn refresh already carry session state (0.18C -> 0.14C).
        const changed = group.revision === undefined || project.revision !== group.revision;
        group.revision = project.revision; group.latest = project;
        for (const member of group.members) {
          if (ended(member)) continue;
          applyProjectControl(member, project);
          if (changed) refreshAfterChange(member, project);
        }
      } catch (error) {
        // The holder ended: the next member holds at once with the same revision.
        if (ended(ctrl)) continue;
        cloudFailure(ctrl, error);
        // A refusal of this member's own run or credential stops only it; the next member holds at once.
        // Transport, 5xx and 429 failures back off the whole group, honoring Retry-After: one member's
        // request budget carries the hold for all.
        if (cloudFatal(error)) continue;
        // A lost connection holds new work; reconnect with bounded backoff.
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); ctrl.lifetime.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, spread(Math.max(observeIntervalMs, (Number(error?.retryAfter) || 1) * 1000)));
          timer.unref?.(); ctrl.lifetime.signal.addEventListener('abort', finish, { once: true });
          if (ctrl.lifetime.signal.aborted) finish();
        });
      }
    }
  }
  async function cloudTick(ctrl, { projectOnly = false } = {}) {
    if (!ctrl.cloud || !ctrl.cloudInitialized || ctrl.cloudPolling || ctrl.cancelled || ctrl.settled || now() < (ctrl.cloudRetryAt ?? 0)) return;
    ctrl.cloudPolling = (async () => {
      try {
        // Prompt confirmation must not poll /wait again inside its rate-limit window.
        if (!projectOnly) {
          const news = await cloudRequest(ctrl, () => ctrl.cloud.observe(ctrl.mission, { signal: ctrl.lifetime.signal }));
          if (ctrl.cancelled || ctrl.settled) return;
          // Do not manufacture contact when an observation is missing or malformed.
          if (!news?.project || typeof news.project.started !== 'boolean' || typeof news.project.paused !== 'boolean') { ctrl.news = null; return; }
          ctrl.news = news;
          applyProjectControl(ctrl, news.project);
        }
        // Closing the project stops this agent now, including a step in progress.
        if (ctrl.projectControl?.closed === true) { latchStop(ctrl, 'project_closed'); ctrl.releaseStop?.(); schedule(ctrl); return; }
        const mission = await store.getMission({ missionId: ctrl.mission.missionId, target: ctrl.mission.target });
        if (ctrl.cancelled || ctrl.settled) return;
        const reply = await cloudRequest(ctrl, () => ctrl.cloud.workerSession(mission, cloudSession(ctrl, mission), { signal: ctrl.lifetime.signal }));
        if (ctrl.cancelled || ctrl.settled) return;
        if (reply.missionId !== mission.missionId || !Array.isArray(reply.messages) || reply.messages.length > 64)
          throw new RuntimeError('invalid_cloud_reply', 'Cloud steering reply is invalid.');
        await applyExtension(ctrl, reply.authorizedDeadlineAt);
        applyTokenLimit(ctrl, reply.tokenLimit ?? null);
        if (ctrl.statusPending && !ctrl.cancelled && !ctrl.settled) void sendStatus(ctrl, ctrl.statusPending);
        ctrl.cloudRetryAt = null;
        for (const item of reply.messages) {
          if (ctrl.cancelled || ctrl.settled) return;
          if (item.missionId !== mission.missionId || item.generation !== mission.generation || typeof item.body !== 'string' || Buffer.byteLength(item.body) > 16000)
            throw new RuntimeError('invalid_cloud_reply', 'Cloud steering message is invalid.');
          const command = validateCommand({ version: 2, operationId: item.id, kind: 'steer', target: mission.target,
            missionId: mission.missionId, generation: mission.generation, payload: { message: item.body, ...(item.threadId ? {threadId:item.threadId} : {}) } });
          await serialize(async () => {
            if (ctrl.cancelled || ctrl.settled) return;
            const fingerprint = commandFingerprint(command), previous = operations.get(command.operationId);
            if (previous && previous.fingerprint !== fingerprint) throw new RuntimeError('conflict', 'Cloud steering identity changed.');
            await store.acceptSteering(command);
            operations.set(command.operationId, { fingerprint, accepted: true });
          });
        }
        if (!ctrl.cancelled && !ctrl.settled) schedule(ctrl);
      } catch (error) { if (!ctrl.cancelled && !ctrl.settled) cloudFailure(ctrl, error); }
    })().finally(() => { ctrl.cloudPolling = null; if (ctrl.cloudRefreshRequested) { ctrl.cloudRefreshRequested = false; refreshCloud(ctrl); } });
    return ctrl.cloudPolling;
  }
  async function initializeCloud(ctrl) {
    ctrl.cloud ??= await cloudRequest(ctrl, () => cloudFactory(ctrl.mission));
    if (ctrl.cancelled) return;
    // The server's rule: the end time is at most 24 hours from now. A restored worker's time may have been
    // added after it started, so its start time is not the measure.
    if (ctrl.mission.deadlineAt - now() > MAX_REMAINING_MS + CLOCK_SKEW_MS) throw new RuntimeError('invalid_command', 'Cloud work needs an end time at most 24 hours away.');
    // Retry the exact persisted window, including after restart or a lost reply.
    ctrl.mission = await store.prepareCloudRun({ missionId: ctrl.mission.missionId, generation: ctrl.mission.generation,
      startedAt: ctrl.mission.cloudRun?.startedAt ?? ctrl.mission.createdAt });
    if (ctrl.cancelled) return;
    const run = await cloudRequest(ctrl, () => ctrl.cloud.start(ctrl.mission, { signal: ctrl.lifetime.signal }));
    // The pre-request intent already preserves the run identity if cancellation wins.
    ctrl.mission = await store.bindCloudRun({ missionId: ctrl.mission.missionId, generation: ctrl.mission.generation,
      runId: run.runId, cloudGeneration: run.cloudGeneration });
    if (ctrl.cancelled) return;
    ctrl.cloudInitialized = true; ctrl.appliedDeadlineAt = ctrl.mission.deadlineAt;
    // The periodic tick starts after a one-time random phase in [0.55, 1) intervals, drawn once per mission, so
    // missions that start together (a connector restart, a fleet update, same-second scheduled starts) do not stay
    // phase-locked and land their /wait and session syncs in the same instant every interval. The tick at start below
    // stays immediate. Measured from timer start, the first periodic gap is in [0.55, 1) intervals (≈[11, 20) s at the
    // 20 s interval), leaving ≈1 s over the server's 10 s /wait minimum for send delay; the gap the server observes is
    // not guaranteed (a slow start tick coalesces the phased one, and back-off and network delay also move it).
    const phase = Math.floor(observeIntervalMs * (0.55 + 0.45 * Math.min(Math.max(Number(random()) || 0, 0), 0.999)));
    ctrl.cloudTimer = setTimeout(() => {
      if (ended(ctrl)) return;
      ctrl.cloudTimer = setInterval(() => { void cloudTick(ctrl); }, observeIntervalMs);
      ctrl.cloudTimer.unref?.();
      void cloudTick(ctrl);
    }, phase);
    ctrl.cloudTimer.unref?.();
    await cloudTick(ctrl);
    watchProject(ctrl);
  }
  function matching(command) {
    const ctrl = controllers.get(command.missionId);
    return ctrl && !ctrl.settled && ctrl.mission.generation === command.generation && sameTarget(ctrl.mission.target, command.target) ? ctrl : null;
  }
  // Observation is read-only. Cancellation may stop waiting for a failed peer;
  // its eventual result is observed but cannot resume this cancelled mission.
  async function observe(adapter, signal) {
    if (signal.aborted) return null;
    return new Promise(resolve => {
      const finish = value => { signal.removeEventListener('abort', abort); resolve(value); };
      const abort = () => finish(null);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      Promise.resolve().then(() => signal.aborted ? null : adapter.observe({ signal })).then(finish, () => finish(null));
    });
  }
  function latchStop(ctrl, reason = 'stopped') {
    if (!ctrl || ctrl.cancelled) return;
    ctrl.cancelled = true; ctrl.stopReason = reason;
    ctrl.lifetime.abort();
    ctrl.stopBarrier = new Promise(resolve => { ctrl.releaseStop = resolve; });
    clearInterval(ctrl.cloudTimer);
    ctrl.abort?.abort();
  }
  const locallyPaused = ctrl => ctrl.paused || ctrl.pauseRequests.size > 0;
  function latchPause(ctrl, operationId) {
    if (!ctrl || ctrl.cancelled || ctrl.halted) return;
    ctrl.pauseRequests.add(operationId);
    ctrl.paused = true;
    clearTimeout(ctrl.retryTimer);
    // Pause lets the running turn finish (owner decision, 9 November 2026); Stop is the kill.
  }
  // A restored mission first ends the processes the previous service left behind, by this mission's exact
  // identity, and frees that dead service's checkout claim. Throws when that cannot be confirmed.
  async function adoptOrphan(ctrl) {
    if (typeof stopOrphanedMission !== 'function') throw new Error('Orphaned mission cleanup unavailable.');
    await stopOrphanedMission(ctrl.mission);
  }
  async function settle(ctrl, reason, cleanupConfirmed = true) {
    if (ctrl.settled) return;
    ctrl.settling = true; // A worker already ending is not detached on a service stop.
    await ctrl.stopBarrier;
    if (ctrl.orphaned && cleanupConfirmed) {
      // Stop still kills a restored worker completely; unconfirmed, it needs recovery and Stop can be retried.
      try { await adoptOrphan(ctrl); ctrl.orphaned = false; } catch { cleanupConfirmed = false; }
    }
    if (cleanupConfirmed && ctrl.adapter?.release) {
      // A clean native turn does not prove its detached servers ended. Record
      // uncertainty before releasing; a crash anywhere below must fail closed.
      ctrl.cleanupPending ??= { reason };
      reason = ctrl.cleanupPending.reason;
      ctrl.mission = await store.settleMission({ missionId: ctrl.mission.missionId, generation: ctrl.mission.generation,
        reason: 'mission_cleanup_pending', cleanupConfirmed: false });
      try { await ctrl.adapter.release({ cleanupConfirmed: true }); }
      catch (error) {
        ctrl.error = error; ctrl.halted = true; ctrl.requested = false;
        ctrl.mission = await store.settleMission({ missionId: ctrl.mission.missionId, generation: ctrl.mission.generation,
          reason: 'mission_cleanup_uncertain', cleanupConfirmed: false });
        clearTimeout(ctrl.retryTimer); clearInterval(ctrl.cloudTimer);
        reportReady(); return; // Explicit Stop can retry cleanup; never run another turn.
      }
      ctrl.cleanupPending = null;
    }
    // Cleanup cannot reconcile a native submission whose acknowledgement/result
    // was lost. Keep its original identity for explicit recovery, not a new turn.
    ctrl.mission = await store.settleMission({ missionId: ctrl.mission.missionId, generation: ctrl.mission.generation,
      reason, cleanupConfirmed: cleanupConfirmed && reason !== 'delivery_uncertain' });
    reportReady(); ctrl.settled = true; ctrl.lifetime.abort();
    clearTimeout(ctrl.retryTimer); clearInterval(ctrl.cloudTimer);
  }
  function schedule(ctrl) {
    if (ctrl.halted || ctrl.settled) return;
    ctrl.requested = true;
    if (ctrl.pumping) return;
    ctrl.pumping = true;
    ctrl.task = Promise.resolve().then(async () => {
      while (ctrl.requested && !ctrl.settled) {
        ctrl.requested = false;
        if (ctrl.cleanupPending) { await settle(ctrl, ctrl.cleanupPending.reason); break; }
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        // A worker restored paused still reconnects, so the cloud sees it paused rather than gone.
        if (executionHeld(ctrl) && !(ctrl.orphaned && ctrl.paused && !ctrl.detached)) { if (pauseUpdateDue(ctrl)) await runPauseUpdate(ctrl); break; }
        if (cloudFactory && !ctrl.cloudInitialized) {
          if (now() < (ctrl.cloudRetryAt ?? 0)) break;
          try { await initializeCloud(ctrl); }
          catch (error) {
            if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
            cloudFailure(ctrl, error); break;
          }
        }
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        // A restored worker ends what the dead service left once, before it waits or continues.
        if (ctrl.orphaned && !ctrl.detached) { await adoptOrphan(ctrl); ctrl.orphaned = false; }
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        if (executionHeld(ctrl)) break;
        if (ctrl.resumeObservation && ctrl.cloud) {
          const resumeId = ctrl.resumeObservation;
          // A pre-Resume poll cannot stand in for fresh project authorization.
          await ctrl.cloudPolling;
          if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
          if (executionHeld(ctrl)) break;
          ctrl.news = null;
          await cloudTick(ctrl);
          if (ctrl.resumeObservation !== resumeId) continue;
          if (ctrl.news) ctrl.resumeObservation = null;
        }
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        if (executionHeld(ctrl)) break;
        ctrl.adapter ??= await adapterFactory(ctrl.mission, { signal: ctrl.lifetime.signal });
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        if (executionHeld(ctrl)) break;
        try {
          if (!ctrl.cloud) ctrl.news = await observe(ctrl.adapter, ctrl.lifetime.signal);
          const state = ctrl.news?.project;
          if (!state || typeof state.started !== 'boolean' || typeof state.paused !== 'boolean' || (state.closed !== undefined && typeof state.closed !== 'boolean')) ctrl.news = null;
        } catch { ctrl.news = null; }
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        if (executionHeld(ctrl)) break;
        const snapshot = await store.getMission({ missionId: ctrl.mission.missionId, target: ctrl.mission.target });
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        if (executionHeld(ctrl)) break;
        ctrl.mission = snapshot;
        if (ctrl.adapter.retryCoordination) await cloudRequest(ctrl, () => ctrl.adapter.retryCoordination({ signal: ctrl.lifetime.signal }));
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        if (executionHeld(ctrl)) break;
        ctrl.coordination = await cloudRequest(ctrl, () => ctrl.adapter.deliveryState?.()) ?? { pending: 0, notices: [] };
        if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); break; }
        if (executionHeld(ctrl)) break;
        const steering = snapshot.steering.some(item => item.state === 'queued');
        // A cloud worker runs no turn until a session reply told it the job's token cap, also after a restart.
        const tokenCap = !!ctrl.cloud && (ctrl.tokenLimit === undefined || capReached(ctrl));
        const decision = ctrl.scheduler.decide({ news: ctrl.news, steering, pendingDeliveries: ctrl.coordination.pending, notices: ctrl.coordination.notices.length, tokenCap, now: now() });
        if (decision.action === 'stop') { await settle(ctrl, decision.reason); break; }
        if (decision.action !== 'run') {
          if (['unknown_contact', 'paused', 'time_up', 'token_cap', 'fresh_observation', 'idle', 'pending_delivery'].includes(decision.reason)) { clearTimeout(ctrl.retryTimer); ctrl.retryTimer = setTimeout(() => schedule(ctrl), observeIntervalMs); ctrl.retryTimer.unref?.(); }
          if (decision.retryAt) { clearTimeout(ctrl.retryTimer); ctrl.retryTimer = setTimeout(() => schedule(ctrl), Math.max(1, decision.retryAt - now())); ctrl.retryTimer.unref?.(); }
          break;
        }
        ctrl.turnBusy = true;
        try { await runTurn(ctrl, decision.reason); }
        finally { ctrl.turnBusy = false; if (ctrl.cloud && !ctrl.cancelled && !ctrl.settled) refreshCloud(ctrl); }
      }
    }).catch(async error => {
      ctrl.error = error; ctrl.halted = true; ctrl.requested = false;
      const cleanupConfirmed = error.cleanupConfirmed === true || (!ctrl.nativeInvoked || ctrl.nativeCleanupConfirmed === true);
      ctrl.abort?.abort();
      try { await settle(ctrl, ctrl.cancelled ? ctrl.stopReason : error?.code === 'checkout_missing' ? 'checkout_missing' : 'controller_failed', cleanupConfirmed); } catch (storageError) { ctrl.error = storageError; }
    }).finally(() => { ctrl.pumping = false; if (ctrl.requested && !ctrl.settled && !ctrl.halted) schedule(ctrl); });
  }
  async function runTurn(ctrl, trigger) {
    const pauseUpdate = trigger === 'pause_update';
    // The pause update runs under the project Pause it reports on; any other hold still stops it.
    const held = () => pauseUpdate ? ctrl.cancelled || ctrl.detached || locallyPaused(ctrl) || !ctrl.projectPaused : executionHeld(ctrl);
    if (held()) return;
    const turnId = randomUUID(), ref = { missionId: ctrl.mission.missionId, generation: ctrl.mission.generation, turnId };
    ctrl.adapter ??= await adapterFactory(ctrl.mission, { signal: ctrl.lifetime.signal });
    if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); return; }
    if (held()) return;
    if (ctrl.cloud && !pauseUpdate) {
      try { await cloudRequest(ctrl, () => ctrl.cloud.phase(ctrl.mission, 'turn', { signal: ctrl.lifetime.signal })); }
      catch (error) { if (!ctrl.cancelled) cloudFailure(ctrl, error); return; }
      if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); return; }
      if (!workAllowed(ctrl)) return;
    }
    const startedAt = now();
    const prepared = await store.prepareTurn({ ...ref, steering: !pauseUpdate });
    if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason); return; }
    if (pauseUpdate ? held() : executionHeld(ctrl) || ctrl.cloud && !workAllowed(ctrl)) { ctrl.mission = await store.deferPreparedTurn(ref); return; }
    ctrl.mission = prepared.mission;
    if (!pauseUpdate) ctrl.scheduler.beginTurn(ctrl.news);
    const seenProject = newsFingerprint(ctrl.news), seenRevision = ctrl.news.work?.revision;
    ctrl.abort = new AbortController();
    const notices = pauseUpdate ? [] : ctrl.coordination?.notices ?? [];
    const inbox = { pending: ctrl.news.pending, acknowledged: ctrl.news.acknowledged };
    const {prompt,promptSources,steeringMessages}=controllerPrompt({scope:ctrl.mission.scope,
      deadlineAt:ctrl.mission.deadlineAt,steering:prepared.steering,notices,trigger,inbox});
    let result, guardPid, focus, observedModel;
    let denials = 0; const denialTools = new Set();
    ctrl.nativeInvoked = true; ctrl.nativeCleanupConfirmed = false;
    try {
      result = await ctrl.adapter.run({ turnId, prompt, promptSources, steeringMessages, signal: ctrl.abort.signal, ...(pauseUpdate ? { pauseUpdate } : {}),
        onGuardStarted: async pid => { guardPid = pid; await store.recordGuard({ ...ref, guardPid: pid }); },
        onGuardClosed: ({ guardPid: closedPid, cleanupConfirmed }) => {
          if (cleanupConfirmed !== true || closedPid !== guardPid) throw new Error('Guard cleanup identity changed.');
          return store.clearGuardAfterCleanup({ ...ref, guardPid: closedPid });
        },
        onStatus: value => { if (typeof value === 'string' && value.trim() && [...value].length <= 180 && Buffer.byteLength(value) <= 720 && !value.includes('\0')) {
          focus = value;
          if (ctrl.cloud && !ctrl.cancelled) sendStatus(ctrl, value);
        } },
        onMetadata: value => { if (typeof value?.model === 'string' && /^[A-Za-z0-9_:.-]{1,150}$/.test(value.model)) observedModel = value.model; },
        onPermission: value => { if (typeof value?.tool === 'string' && /^[A-Za-z0-9_:.-]{1,150}$/.test(value.tool)) { denials = Math.min(Number.MAX_SAFE_INTEGER, denials + 1); if (denialTools.size < 64) denialTools.add(value.tool); } },
        onPromptSubmitted: () => store.markTurnSubmitted(ref),
        onTurnStarted: () => store.markTurnApplied(ref),
      });
    } catch (error) { ctrl.abort.abort(); throw error; }
    const cleanupConfirmed = result.cleanupConfirmed === true;
    ctrl.nativeCleanupConfirmed = cleanupConfirmed;
    let outcome = { delivery: result.delivery ?? 'not_submitted', failed: result.failed === true, interrupted: result.interrupted === true, retryable: result.retryable === true, cleanupConfirmed };
    const fullText = typeof result.text === 'string' ? result.text : '';
    if (!pauseUpdate) ctrl.scheduler.recordOutcome({ kind: outcome.interrupted ? 'interrupted' : outcome.failed ? 'failed' : 'ok', news: ctrl.news,
      retryable: outcome.retryable, continuation: /(?:^|\n)WORK_NEXT: runnable\s*$/.test(fullText), now: now(),
      providerLimited: outcome.failed && !outcome.interrupted && result.failureCode === 'provider_limited', resetAt: result.limitResetAt ?? null });
    // What this turn saw and whether the worker has more to do, so a worker restored after a connector
    // restart continues as it would have, and otherwise runs only for news since then.
    const handled = !pauseUpdate && !outcome.failed && !outcome.interrupted && Number.isSafeInteger(seenRevision) && seenRevision >= 0;
    const { continuation: more, limited } = ctrl.scheduler.status();
    // A provider limit's wait is kept with the turn, so a worker restored after a connector restart still waits for it.
    outcome.seen = { project: seenProject, ...(handled ? { revision: seenRevision } : {}), ...(more ? { more: true } : {}),
      ...(limited ? { limit: { retryAt: limited.retryAt, resetAt: limited.resetAt, streak: limited.streak } } : {}) };
    for (const name of ['failureCode', 'usage', 'diagnostics', 'evidence']) if (result[name] !== undefined) outcome[name] = result[name];
    if (focus !== undefined) outcome.focus = focus;
    if (pauseUpdate) outcome.pauseUpdate = true;
    if (denials) outcome.permissionDenials = { count: denials, tools: [...denialTools] };
    if (observedModel && outcome.usage) outcome.usage = { ...outcome.usage, model: observedModel };
    outcome=fitContextTelemetry(outcome,RUNTIME_LIMITS.metadataBytes);
    let text = fullText;
    while (Buffer.byteLength(text) > RUNTIME_LIMITS.outcomeBytes) text = text.slice(0, Math.floor(text.length * 0.9));
    if (text !== fullText) outcome.textTruncated = true;
    ctrl.mission = await store.recordTurn({ ...ref, text, outcome, startedAt, endedAt: now() });
    reportReady();
    if (notices.length && outcome.delivery === 'acknowledged' && !outcome.failed && !outcome.interrupted)
      await cloudRequest(ctrl, () => ctrl.adapter.acknowledgeNotices?.(notices));
    if (!cleanupConfirmed) { await settle(ctrl, 'native_cleanup_uncertain', false); return; }
    if (ctrl.cancelled) { await settle(ctrl, ctrl.stopReason, true); return; }
    if (outcome.delivery === 'submitted') {
      await settle(ctrl, 'delivery_uncertain'); return;
    }
    if (ctrl.cloud) {
      try { await cloudRequest(ctrl, () => ctrl.cloud.phase(ctrl.mission, executionHeld(ctrl) ? 'paused' : 'idle', { signal: ctrl.lifetime.signal })); }
      catch (error) { if (!ctrl.cancelled) cloudFailure(ctrl, error); }
    }
    ctrl.abort = null;
    ctrl.requested = true;
  }
  function workAllowed(ctrl) {
    const project = ctrl.news?.project;
    return !ctrl.cancelled && !executionHeld(ctrl) && now() < (ctrl.appliedDeadlineAt ?? ctrl.mission.deadlineAt)
      && ctrl.tokenLimit !== undefined && !capReached(ctrl) && project?.started === true && project.paused === false && project.closed !== true;
  }
  // Turns saved before this was recorded leave it unknown: the restored worker then runs one catch-up turn.
  function restoredSeen(mission) {
    const last = mission.outcomes.at(-1)?.outcome.seen;
    if (!last?.project) return null;
    const revisions = mission.outcomes.map(item => item.outcome.seen?.revision).filter(Number.isSafeInteger);
    return { fingerprint: last.project, handledRevision: Math.max(-1, ...revisions), continuation: last.more === true,
      ...(last.limit ? { limitedUntil: last.limit.retryAt, limitResetAt: last.limit.resetAt, limitStreak: last.limit.streak } : {}) };
  }
  function createController(mission, { restored = false } = {}) {
    const ctrl = { mission, lifetime: new AbortController(), scheduler: createWorkController({ deadline: mission.deadlineAt, now, first: mission.outcomes.length === 0, seen: restored ? restoredSeen(mission) : null }), news: null, cancelled: false, paused: restored && mission.state === 'paused', pauseRequests: new Set(), settled: false, requested: false, pumping: false, stopBarrier: Promise.resolve(),
      // A restored mission may have left detached processes and a dead connector's checkout claim behind.
      orphaned: restored };
    controllers.set(mission.missionId, ctrl);
    // A Pause may be queued while the Start transaction is still pending.
    for (const command of pendingPauses.values()) if (matching(command) === ctrl) latchPause(ctrl, command.operationId);
    if (closed) { latchStop(ctrl, 'shutdown'); ctrl.releaseStop?.(); }
    schedule(ctrl);
    return ctrl;
  }
  return {
    async accept(input) {
      if(input?.kind==='steer')throw new RuntimeError('forbidden','Use the shared recorded steering operation.');
      await ready;
      if (closed) throw new RuntimeError('closed', 'Runtime is closed.');
      const command = structuredClone(validateCommand(input)), fingerprint = commandFingerprint(command);
      // Both chat and background commands share this port's collision fence.
      // Reserve before immediate stop effects, not only at the later SQL write.
      store.reserveOperation({ operationId: command.operationId, fingerprint });
      const previous = operations.get(command.operationId);
      if (previous && previous.fingerprint !== fingerprint) throw new RuntimeError('conflict', 'Operation ID already identifies another command.');
      if (previous?.pending) return { ...await previous.pending, created: false };
      const reservation = previous ?? { fingerprint };
      operations.set(command.operationId, reservation);
      // Receipt metadata loaded on startup makes this conflict check independent
      // of SQLite latency. This cache never manufactures durable acceptance.
      if (command.kind === 'stop') latchStop(matching(command));
      const pauseCtrl = command.kind === 'pause' && !reservation.accepted ? matching(command) : null;
      if (command.kind === 'pause' && !reservation.accepted) pendingPauses.set(command.operationId, command);
      if (pauseCtrl) latchPause(pauseCtrl, command.operationId);
      reservation.pending = serialize(async () => {
        let ctrl;
        if (command.kind === 'stop') { ctrl = matching(command); latchStop(ctrl); }
        try {
          if (command.kind === 'resume' && !reservation.accepted) {
            const saved = await store.getOperation({operationId:command.operationId,target:command.target});
            const active = matching(command);
            if (!saved && (!active || active.cancelled || active.halted))
              throw new RuntimeError('conflict','Resume requires this live controller. Restarted or uncertain missions need recovery.');
          }
          const accepted = await store.accept(command);
          reservation.accepted = true;
          if (accepted.created && command.kind === 'start') createController(accepted.mission);
          else if (accepted.created && ['pause','resume'].includes(command.kind)) {
            const active = matching(command);
            if (active && !active.cancelled) {
              active.paused = command.kind === 'pause';
              if (!active.paused) { active.news = null; active.resumeObservation = command.operationId; }
              active.mission = accepted.mission;
              schedule(active);
            }
          }
          if (command.kind === 'stop') {
            if (ctrl) { if (ctrl.cleanupPending) ctrl.halted = false; ctrl.releaseStop?.(); schedule(ctrl); }
            else {
              // No controller holds this mission (the connector restarted). A dead
              // saved guard PID does not prove its native descendants are gone, so
              // the owner's Stop ends the mission's processes by exact identity and
              // frees its checkout. Only that confirmed kill settles the mission,
              // abandoning any turn whose result was never recorded.
              let killed = false;
              if (!['stopped', 'failed'].includes(accepted.mission.state)) {
                try {
                  if (typeof stopOrphanedMission !== 'function') throw new Error('Orphaned mission cleanup unavailable.');
                  await stopOrphanedMission(accepted.mission);
                  killed = true;
                } catch { /* Stays recovery_required; the same Stop can be retried. */ }
              }
              await store.settleMission({ missionId: command.missionId, generation: command.generation, reason: 'explicit_stop_after_recovery', cleanupConfirmed: killed, abandonExecution: killed });
              reportReady();
            }
          }
          return accepted;
        } finally {
          if (command.kind === 'pause') {
            pendingPauses.delete(command.operationId);
            const paused = pauseCtrl ?? matching(command);
            if (paused) { paused.pauseRequests.delete(command.operationId); schedule(paused); }
          }
          ctrl?.releaseStop?.();
        }
      });
      try { return await reservation.pending; }
      finally { delete reservation.pending; }
    },
    async recoverMission(input) {
      await ready;if(closed)throw new RuntimeError('closed','Runtime is closed.');
      const command=validateMissionRecovery(input),fingerprint=missionRecoveryFingerprint(command);
      store.reserveOperation({operationId:command.operationId,fingerprint});
      return serialize(async()=>{
        if(closed)throw new RuntimeError('closed','Runtime is closed.');
        const previous=await store.getOperation({operationId:command.operationId,target:command.target});
        if(previous && previous.fingerprint!==fingerprint)throw new RuntimeError('conflict','Recovery operation already identifies different input.');
        if(!previous && command.action==='finalize') {
          const ctrl=controllers.get(command.missionId);
          if(ctrl && !ctrl.settled)throw new RuntimeError('recovery_not_safe','Use ordinary Stop for a mission still owned by this controller.');
          const mission=await store.getMission({missionId:command.missionId,target:command.target});
          if(!mission || mission.generation!==command.generation)throw new RuntimeError('stale_generation','Inspect the exact mission generation before recovery.');
          if(mission.state!=='recovery_required' || !settledExecution(mission))throw new RuntimeError('recovery_not_safe','Execution is not settled; preserve its evidence and checkout.');
          if(typeof inspectRecoveryCheckout!=='function')throw new RuntimeError('unavailable','Trusted checkout inspection is required before finalization.');
          assertRecoveryCheckout(await inspectRecoveryCheckout(mission));
        }
        const result=await store.applyMissionRecovery(command);
        operations.set(command.operationId,{fingerprint});reportReady();return result;
      });
    },
    async health() { await ready; if (closed) throw new RuntimeError('closed', 'Runtime is closed.'); return store.health(); },
    async getMission(query) { await ready; return store.getMission(query); },
    async listMissionSummaries(query) { await ready; return store.listMissionSummaries(query); },
    async reserveCloudOperation(input) { await ready; return store.reserveCloudOperation(input); },
    async getOperation(query) { await ready; return store.getOperation(query); },
    async listReports(query) { await ready; return store.listReports(query); },
    async archiveFailedLaunchReport(input) {
      await ready;
      if (closed) throw new RuntimeError('closed', 'Runtime is closed.');
      return serialize(() => store.archiveFailedLaunchReport(input));
    },
    async close() {
      await ready; closed = true;
      const leave = ctrl => {
        if (ctrl.settled) return;
        // Waiting survives a connector restart (owner decision, 9 November 2026): a worker between turns keeps
        // its saved state and the next service continues it. A turn in progress is still stopped.
        if (!ctrl.turnBusy && !ctrl.settling && !ctrl.cancelled && !ctrl.halted && !ctrl.cleanupPending) {
          ctrl.detached = true; ctrl.settled = true; ctrl.lifetime.abort();
          clearTimeout(ctrl.retryTimer); clearInterval(ctrl.cloudTimer); return;
        }
        if (ctrl.cleanupPending) ctrl.halted = false;
        latchStop(ctrl, 'shutdown'); ctrl.releaseStop?.(); schedule(ctrl);
      };
      for (const ctrl of controllers.values()) leave(ctrl);
      await tail;
      // An acceptance already in flight may have created its controller while
      // close was waiting for SQLite; creation itself also checks this fence.
      for (const ctrl of controllers.values()) leave(ctrl);
      await Promise.all([...controllers.values()].map(ctrl => ctrl.task));
      // A detached worker's own processes, bridge and checkout claim end with this service. When that cannot be
      // confirmed, the restored controller ends what is left by the mission's identity before continuing.
      await Promise.all([...controllers.values()].filter(ctrl => ctrl.detached && ctrl.adapter?.release)
        .map(ctrl => Promise.resolve().then(() => ctrl.adapter.release({ cleanupConfirmed: true })).catch(() => {})));
    },
  };
}
