import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { prepareProjectJourney } from '../onboarding/journeys.js';
import { reportsModelWork } from '../onboarding/progress.js';
import { prepareSteeringEnd } from '../projects/steering.js';
// An agent's runner: one current run at a time, its contact with the service and its phase.
import { RUN_LENGTH } from '@mlswarm/contracts';
import { checkedWorkSignal, workSignalAtStart, taskWorkSignalIn, type WorkSignal } from './work-signals.js';
import { agentMembership, assertAgentMembership, type ProjectRole, assertProjectWritable } from '../projects/access.js';
import { agentGroup } from './agent-group.js';
import { createHash } from 'node:crypto';
import type { Transaction } from '../firestore.js';
import { V2_LIMITS } from '../config.js';
import { Refusal } from '../errors.js';
import { agents, currentProjectId, db } from '../firestore.js';
import { presence, runs, runHistory, chatDeadlineReceipts, chatParticipationEnds, type LastTurn, type Phase, type Run } from './records.js';

import { prepareTurnReceipt, runHistoryId } from './turn-reports.js';
import { prepareWorkerSession, WORKER_SESSION } from '../projects/worker-sessions.js';
import type { z } from 'zod';
import { projects } from '../projects/records.js';

// A run start resets only the run's own presence fields, merged, so fields another writer keeps in the same document
// (the shared current-state record, c1/c2 contract) survive a start or takeover. Every field the run owns is listed, so
// nothing from the previous run carries over.
// The run group a start writes. runEndedAt and runMode mirror runs/{agent}'s endedAt and mode (contract C3): every
// run-ending writer sets runEndedAt in the same transaction as the run's endedAt (stage E1; readers unchanged).
const runPresence = (runId: string, at: number, runMode: 'current_chat' | null = null) =>
  ({ runId, lastContactAt: at, phase: 'idle' as Phase, phaseAt: at, lastTurn: null, activity: null, acceptingWork: null, protocol: 2 as const,
    runEndedAt: null, runMode });

// Starts a new run, which supersedes the agent's current one. Refused with run_active while the
// current run has had contact in the last runActiveSeconds, unless takeover is set.
export async function startRun(agentId: string, input: { clientRunId: string, runnerVersion: string, takeover: boolean },
  now: () => number): Promise<{ run_id: string, generation: number, poll_seconds: number, protocol: 2 }> {
  return db.runTransaction(async (tx) => {
    const { agent } = await agentMembership(tx, agentId); await assertProjectWritable(tx);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.clientRunId))
      throw new Refusal('bad_input', 'A stable client_run_id UUID is required.');
    const historyRef = runHistory().doc(runHistoryId(agentId, input.clientRunId));
    const startInput = { runnerVersion: input.runnerVersion, takeover: input.takeover };
    const issued = (await tx.get(historyRef)).data();
    if (issued) {
      if (issued.mode === 'current_chat' || issued.agentId !== agentId || issued.runId !== input.clientRunId || issued.startInput?.runnerVersion !== startInput.runnerVersion || issued.startInput?.takeover !== startInput.takeover)
        throw new Refusal('runtime_conflict', 'This client_run_id was already used with different details. Use a new one.');
      // A receipt is historical evidence, never permission to reopen or supersede a run.
      return { run_id: issued.runId, generation: issued.generation, poll_seconds: V2_LIMITS.pollSeconds, protocol: 2 as const };
    }
    const [run, seen] = await Promise.all([tx.get(runs().doc(agentId)), tx.get(presence().doc(agentId))]);
    const current = run.data();
    const contact = seen.data();
    const at = now();
    if (current?.endedAt === null && current.mode === 'current_chat' && (!Number.isSafeInteger(current.deadlineAt) || current.deadlineAt! > at))
      throw new Refusal('run_active', 'This agent is already working with you in a chat. Use End first.');
    if (current && current.mode !== 'current_chat' && current.endedAt === null && contact?.runId === current.runId && !input.takeover) {
      const ageS = Math.floor((at - contact.lastContactAt) / 1000);
      if (ageS < V2_LIMITS.runActiveSeconds) {
        throw new Refusal('run_active', `This agent was working somewhere else ${ageS} seconds ago. `
          + 'Stop it there first, or start it here with takeover.');
      }
    }
    const work = await workSignalAtStart(tx, agentId);
    const runId = input.clientRunId;
    const generation = (current?.generation ?? 0) + 1;
    const endSteering = run.data()?.runId ? await prepareSteeringEnd(tx,agentId,run.data()!.runId,at) : null;
    const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
    endSteering?.();
    tx.create(historyRef, { agentId, runId, generation, startedAt: at, startInput });
    if (work.create) tx.set(work.ref, work.signal);
    tx.set(runs().doc(agentId), {
      runId, generation, workSignal: checkedWorkSignal(work.signal), runnerVersion: input.runnerVersion, startedAt: at, endedAt: null, endReason: null, protocol: 2,
    });
    // The start also writes the agent group, from the agent document its membership check read (no extra read or
    // write), so an agent created before stage A1 has a complete group from its next run. mergeFields: every listed
    // field, the agent group included, is replaced whole; other writers' groups (worker) are left alone.
    const started = { ...runPresence(runId, at), agent: agentGroup(agent) };
    statusProgress(presence().doc(agentId));
    tx.set(presence().doc(agentId), started, { mergeFields: Object.keys(started) });
    return { run_id: runId, generation, poll_seconds: V2_LIMITS.pollSeconds, protocol: 2 as const };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP = RUN_LENGTH.stepMinutes * 60_000, MAX_WINDOW = RUN_LENGTH.maxMinutes * 60_000;
type ChatStart = { clientRunId: string; runnerVersion: string; approvedAt: number; deadlineAt: number };
export type ChatExtension = { clientRequestId: string; expectedDeadlineAt: number; approvedAt: number; deadlineAt: number };
function checkGrant(approvedAt: number, deadlineAt: number, at: number, from = approvedAt) {
  const duration = deadlineAt - from;
  if (![approvedAt, deadlineAt, from].every(value => Number.isSafeInteger(value) && value > 0)
    || approvedAt > at || deadlineAt <= at || duration < STEP || duration > MAX_WINDOW || duration % STEP !== 0
    || deadlineAt - at > MAX_WINDOW)
    throw new Refusal('bad_input', 'Choose a time from 5 minutes to 24 hours, in 5-minute steps, starting now.');
}
function assertChatDeadline(current: Run, at: number) {
  if (current.mode === 'current_chat' && (!Number.isSafeInteger(current.deadlineAt) || current.deadlineAt! <= at))
    throw new Refusal('run_superseded', 'Time is up for working in this chat. Stop working on the project now, and ask the person whether they want to add time.');
}

// Current-chat participation has a human-approved window, independent of contact freshness.
// This starts no model and never takes over another unended runner.
export async function startChatParticipation(agentId: string, input: ChatStart, now: () => number) {
  if (!UUID.test(input.clientRunId) || !input.runnerVersion || input.runnerVersion.length > 100)
    throw new Refusal('bad_input', 'Use a stable client_run_id UUID and runner_version.');
  return db.runTransaction(async tx => {
    const { agent } = await agentMembership(tx, agentId); await assertProjectWritable(tx);
    const historyRef = runHistory().doc(runHistoryId(agentId, input.clientRunId));
    const startInput = { mode: 'current_chat' as const, runnerVersion: input.runnerVersion, approvedAt: input.approvedAt, deadlineAt: input.deadlineAt };
    const issued = (await tx.get(historyRef)).data();
    const cancelled = (await tx.get(chatParticipationEnds().doc(runHistoryId(agentId,input.clientRunId)))).data();
    if (issued) {
      if (issued.agentId !== agentId || issued.runId !== input.clientRunId || issued.mode !== 'current_chat'
        || issued.startInput.mode !== startInput.mode || issued.startInput.runnerVersion !== startInput.runnerVersion
        || issued.startInput.approvedAt !== startInput.approvedAt || issued.startInput.deadlineAt !== startInput.deadlineAt)
        throw new Refusal('runtime_conflict', 'This client_run_id was already used with different details. Use a new one.');
      return { run_id: issued.runId, generation: issued.generation, poll_seconds: V2_LIMITS.pollSeconds, protocol: 2 as const };
    }
    if(cancelled) throw new Refusal('run_superseded','The person ended this before it started. Ask them to use Wake to start again.');
    const at = now();
    checkGrant(input.approvedAt, input.deadlineAt, at);
    const current = (await tx.get(runs().doc(agentId))).data();
    if (current?.endedAt === null && (current.mode !== 'current_chat' || !Number.isSafeInteger(current.deadlineAt) || current.deadlineAt! > at))
      throw new Refusal('run_active', 'This agent is already working. Use End or stop it first.');
    const work = await workSignalAtStart(tx, agentId);
    const runId = input.clientRunId, generation = (current?.generation ?? 0) + 1;
    const window = { mode: 'current_chat' as const, approvedAt: input.approvedAt, deadlineAt: input.deadlineAt };
    const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
    tx.create(historyRef, { agentId, runId, generation, startedAt: at, startInput, ...window });
    if (work.create) tx.set(work.ref, work.signal);
    tx.set(runs().doc(agentId), { runId, generation, workSignal: checkedWorkSignal(work.signal), runnerVersion: input.runnerVersion,
      startedAt: at, endedAt: null, endReason: null, protocol: 2, ...window });
    const started = { ...runPresence(runId, at, 'current_chat'), agent: agentGroup(agent) };
    statusProgress(presence().doc(agentId));
    tx.set(presence().doc(agentId), started, { mergeFields: Object.keys(started) });
    return { run_id: runId, generation, poll_seconds: V2_LIMITS.pollSeconds, protocol: 2 as const };
  });
}

export async function extendChatParticipation(agentId: string, runId: string, input: ChatExtension, now: () => number) {
  return db.runTransaction(tx => prepareChatExtension(tx, agentId, runId, input, now));
}

// The website records the same receipt as the device's eventual exact retry.
// No independent extension writer or delivery-time clock is introduced.
export async function prepareChatExtension(tx: Transaction, agentId: string, runId: string, input: ChatExtension, now: () => number) {
  await assertProjectWritable(tx);
  if (!UUID.test(runId) || !UUID.test(input.clientRequestId)) throw new Refusal('bad_input', 'Use stable run and request UUIDs.');
  const fingerprint = createHash('sha256').update(JSON.stringify([runId, input.expectedDeadlineAt, input.approvedAt, input.deadlineAt])).digest('hex');
  const receiptRef = chatDeadlineReceipts().doc(createHash('sha256').update(JSON.stringify([agentId, input.clientRequestId])).digest('hex'));
    await assertAgentMembership(tx, agentId);
    const receipt = (await tx.get(receiptRef)).data();
    if (receipt) {
      if (receipt.agentId !== agentId || receipt.runId !== runId || receipt.fingerprint !== fingerprint)
        throw new Refusal('runtime_conflict', 'This request ID was already used with different details. Use a new one.');
      return { run_id: runId, deadline_at: receipt.deadlineAt };
    }
    const current = (await tx.get(runs().doc(agentId))).data(), at = now();
    if (!current || current.runId !== runId || current.endedAt !== null || current.mode !== 'current_chat')
      throw new Refusal('run_superseded', 'You can only add time while the agent is working with you in this chat.');
    assertChatDeadline(current, at);
    if (current.deadlineAt !== input.expectedDeadlineAt) throw new Refusal('runtime_conflict', 'The time left changed. Check the current time left, then try again.');
    checkGrant(input.approvedAt, input.deadlineAt, at, input.expectedDeadlineAt);
    tx.create(receiptRef, { agentId, runId, requestId: input.clientRequestId, fingerprint, approvedAt: input.approvedAt,
      expectedDeadlineAt: input.expectedDeadlineAt, deadlineAt: input.deadlineAt, receivedAt: at });
    tx.update(runs().doc(agentId), { deadlineAt: input.deadlineAt });
    tx.update(runHistory().doc(runHistoryId(agentId, runId)), { deadlineAt: input.deadlineAt });
    return { run_id: runId, deadline_at: input.deadlineAt };
}

// Owner End fences cloud admission even while its approved computer is offline.
// Its later standard stop report is the exact same immutable terminal evidence.
export function operatorStopFingerprint() { return phaseFingerprint({ phase: 'stopping', reason: 'operator' }); }

const superseded = () => new Refusal('run_superseded', 'This agent is now working somewhere else, '
  + 'or it was stopped. Stop now.');
function requireRunId(runId: string | undefined): string {
  if (!runId) {
    throw new Refusal('bad_input', 'This needs the run id in the header "X-Pilot-Run". The runner starts a run with POST /v2/runs.');
  }
  return runId;
}
// The run fence a request needs, in one snapshot: the current run (checked first, so a superseded run is
// refused before membership), then membership. Each read happens once per request; nothing is cached.
async function checkedRun(tx: Transaction, agentId: string, runId: string, now: () => number): Promise<Run> {
  const current = (await tx.get(runs().doc(agentId))).data();
  if (current?.runId !== runId || current.endedAt !== null) throw superseded();
  assertChatDeadline(current, now());
  await assertAgentMembership(tx, agentId);
  return current;
}

// For routes that need only the fence (project control, tool calls, uploads), not the work signal.
export async function assertRunCurrent(agentId: string, runId: string | undefined, now: () => number = Date.now): Promise<void> {
  const id = requireRunId(runId);
  await db.runTransaction(tx => checkedRun(tx, agentId, id, now), { readOnly: true });
}

export async function assertCurrentRun(agentId: string, runId: string | undefined, now: () => number = Date.now): Promise<WorkSignal> {
  const id = requireRunId(runId);
  return db.runTransaction(async tx => taskWorkSignalIn(tx, agentId, await checkedRun(tx, agentId, id, now)));
}

// The merged heartbeat's common case (contact without a report, plus a session sync): one transaction fences the run
// once, reads the work signal and writes the session. A session refusal does not undo the contact; it is returned.
export async function fencedContactAndSession(agentId: string, runId: string | undefined, session: unknown, now: () => number = Date.now) {
  const id = requireRunId(runId);
  return db.runTransaction(async tx => {
    const work = await taskWorkSignalIn(tx, agentId, await checkedRun(tx, agentId, id, now));
    try {
      const prepared = await prepareWorkerSession(tx, agentId, session, now, { fencedRunId: id });
      prepared.commit();
      return { work, session: prepared.reply };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { work, sessionError: error };
    }
  });
}

// Mutations read the run in their own transaction, so takeover conflicts with the commit.
export async function runInTransaction(tx: Transaction, agentId: string, runId: string, now: () => number = Date.now): Promise<{ role: ProjectRole; run: Run }> {
  const role = await assertAgentMembership(tx, agentId);
  const current = (await tx.get(runs().doc(agentId))).data();
  if (current?.runId !== runId || current.endedAt !== null) {
    throw new Refusal('run_superseded', 'This agent was stopped, or it is now working somewhere else. Stop now.');
  }
  assertChatDeadline(current, now());
  return { role, run: current };
}
export async function assertRunInTransaction(tx: Transaction, agentId: string, runId: string, now: () => number = Date.now): Promise<ProjectRole> {
  return (await runInTransaction(tx, agentId, runId, now)).role;
}

// A contact observation, written by the wait endpoint when its process has not written one for this agent within
// contactWriteSeconds. Requests are routed to any instance, so the stored contact decides: a contact this run
// stored within the window (by any instance) is kept, and its time is returned for the caller's throttle.
// Without this check each instance wrote on its own, about I/(I+3) writes per 20 s poll with I instances.
export async function recordContact(agentId: string, runId: string, at: number): Promise<number> {
  return db.runTransaction(async (tx) => {
    const [seen] = await Promise.all([tx.get(presence().doc(agentId)), assertRunInTransaction(tx, agentId, runId)]);
    const stored = seen.data()?.runId === runId ? seen.data()?.lastContactAt : undefined;
    if (typeof stored === 'number' && stored > at - V2_LIMITS.contactWriteSeconds * 1000 && stored <= at) return stored;
    const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
    statusProgress(presence().doc(agentId));
    tx.set(presence().doc(agentId), { runId, lastContactAt: at }, { merge: true });
    return at;
  });
}

export type PhaseReport = {
  phase: Phase;
  reason?: 'operator' | 'repeated_failures' | 'superseded' | 'checkout_missing' | 'controller_failed';
  lastTurn?: LastTurn;
  acceptingWork?: boolean;
  activity?: { tool: string; at: number };
  workerSession?: z.infer<typeof WORKER_SESSION>;
};

// A phase report is also contact. `stopping` ends the run.
// Only accompanying completion usage is evidence for the onboarding work milestone.
export async function reportPhase(agentId: string, runId: string, report: PhaseReport, now: () => number): Promise<WorkSignal> {
  if (report.workerSession && (report.phase !== 'stopping' || report.workerSession.run_id !== runId || report.workerSession.missionId !== runId))
    throw new Refusal('bad_input', 'Final worker contact must match this stopping run.');
  return db.runTransaction(async (tx) => {
    await assertAgentMembership(tx, agentId);
    const stopFingerprint = report.phase === 'stopping' ? phaseFingerprint(report) : null;
    const historyRef = runHistory().doc(runHistoryId(agentId, runId));
    const endRef=chatParticipationEnds().doc(runHistoryId(agentId,runId));
    const [currentDoc, historyDoc, cancelledDoc] = await Promise.all([tx.get(runs().doc(agentId)), tx.get(historyRef),tx.get(endRef)]);
    const current = currentDoc.data(), history = historyDoc.data();
    const cancelled=cancelledDoc.data();
    // A human may cancel a durable device start intent before a run was issued.
    // Settle only its exact standard stop evidence, without inventing a run or
    // changing the current successor, presence, model usage or history generation.
    if(!history && cancelled?.agentId===agentId && cancelled.runId===runId && stopFingerprint===operatorStopFingerprint()
      && report.phase==='stopping' && report.reason==='operator' && report.lastTurn===undefined && report.workerSession===undefined
      && report.acceptingWork===undefined && report.activity===undefined) {
      if(cancelled.stopFingerprint && cancelled.stopFingerprint!==stopFingerprint)
        throw new Refusal('runtime_conflict','The cancelled participation already has different terminal evidence.');
      if(!cancelled.stopFingerprint) tx.update(endRef,{stopFingerprint,reportedAt:now()});
      return checkedWorkSignal(current?.workSignal);
    }
    if (stopFingerprint && history?.stopFingerprint === stopFingerprint) return checkedWorkSignal(current?.workSignal);
    if (stopFingerprint && history?.mode === 'current_chat' && history.stopFingerprint)
      throw new Refusal('runtime_conflict', 'This historical participation already has different terminal evidence.');
    // Expired participation may have a successor before its durable stop reaches
    // the service. Accept only inert terminal evidence for that issued chat run;
    // never update the successor's presence, lease, usage or worker state.
    if (current?.runId !== runId && stopFingerprint && history?.mode === 'current_chat'
      && history.agentId === agentId && history.runId === runId
      && report.lastTurn === undefined && report.workerSession === undefined
      && report.acceptingWork === undefined && report.activity === undefined) {
      tx.update(historyRef, { stopFingerprint, endedAt: now() });
      return checkedWorkSignal(current?.workSignal);
    }
    if (current?.runId !== runId) throw new Refusal('run_superseded', 'This agent was stopped, or it is now working somewhere else. Stop now.');
    if (current.endedAt !== null) {
      throw new Refusal('run_superseded', 'This run already ended. A phase retry cannot reopen it.');
    }
    const at = now();
    if (report.phase !== 'stopping') assertChatDeadline(current, at);
    if (report.phase === 'turn') {
      const execution = (await tx.get(projects.doc(currentProjectId()))).data()?.execution;
      if (execution?.paused) throw new Refusal('paused', 'Project work is paused. Do not start another turn.');
    }
    const receipt = report.lastTurn?.usage ? await prepareTurnReceipt(tx, agentId, runId, report.lastTurn, at) : null;
    const seen = report.lastTurn ? (await tx.get(presence().doc(agentId))).data() : undefined;
    const worker = report.workerSession ? await prepareWorkerSession(tx, agentId, report.workerSession, now, { terminalOnly: true }) : null;
    const previous = seen?.lastTurn;
    const advances = report.lastTurn && (!previous || !previous.usage || !report.lastTurn.usage
      || report.lastTurn.usage.sequence >= previous.usage.sequence);
    const endSteering = report.phase === 'stopping' && !worker ? await prepareSteeringEnd(tx,agentId,runId,at) : null;
    const progress = reportsModelWork(report.lastTurn)
      ? await prepareProjectJourney(tx, (await tx.get(agents().doc(agentId))).data()!.ownerProfileId, currentProjectId(), at) : null;
    const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
    endSteering?.();
    progress?.(['firstWork']);
    receipt?.commit();
    worker?.commit();
    // mergeFields, not merge: the listed run-group fields are replaced whole, so a report whose lastTurn has no usage
    // does not keep the previous turn's usage (c5; Firestore's merge is deep), and other writers' groups are left alone.
    const runGroup = {
      runId, lastContactAt: at, phase: report.phase, phaseAt: at,
      ...(advances ? { lastTurn: report.lastTurn } : {}),
      ...(report.activity ? { activity: report.activity } : {}),
      ...(report.acceptingWork !== undefined ? { acceptingWork: report.acceptingWork } : {}),
      ...(report.phase === 'stopping' ? { runEndedAt: at } : {}),
    };
    statusProgress(presence().doc(agentId));
    tx.set(presence().doc(agentId), runGroup, { mergeFields: Object.keys(runGroup) });
    if (report.phase === 'stopping') {
      tx.update(runs().doc(agentId), { endedAt: at, endReason: report.reason ?? null });
      tx.update(historyRef, { stopFingerprint: stopFingerprint!, endedAt: at });
    }
    return checkedWorkSignal(current.workSignal);
  });
}

// Stable canonical terminal evidence: an exact retry is inert, including contact.
function phaseFingerprint(report: PhaseReport): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(report))).digest('hex');
}
