import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { personaChoice } from '@mlswarm/contracts';
import type { ProjectWorkersView, SteeringView, WorkerSteeringSession } from '@mlswarm/contracts';
import { RUN_LENGTH } from '@mlswarm/contracts';
import { latestAgentRun, queuedStarts } from '../owner/web-agent-starts.js';
import { workSettings } from '../onboarding/store.js';
import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { agents, db, projectCollection, currentProjectId } from '../firestore.js';
import { assertMembership, currentConnectionEpoch } from './access.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { presence } from '../v2/records.js';
import { AGENTS_PER_PARTICIPANT_CEILING } from '../platform/settings.js';
import { Refusal } from '../errors.js';
import { readBackgroundControl } from './background-controls.js';
import { readParticipationControl } from './chat-controls.js';
import { readWorkerObservation } from './worker-observations.js';
import { prepareSteeringEnd } from './steering.js';
import { projects } from './records.js';

const uuid = z.string().uuid();
// The job's end time can come before a worker starts: a start that finishes preparing after it comes up waiting.
export const WORKER_SESSION = z.object({ run_id: uuid, missionId: uuid, generation: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(), deadlineAt: z.number().int().nonnegative(),
  remainingSlots: z.number().int().min(0).max(64),
  phase: z.enum(['waiting', 'working', 'paused', 'blocked', 'stopped', 'completed']),
  projectPauseRevision: z.number().int().positive().optional(),
  // Tokens this mission counted toward the job's token cap; see WorkerSteeringSession.tokens.
  tokens: z.object({ counted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), unknownTurns: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  // A waiting worker held by a provider usage or rate limit; see WorkerSteeringSession.providerLimit.
  providerLimit: z.object({ retryAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).strict().optional(),
}).strict();
type Session = WorkerSteeringSession & { profileId: string };
// The pointer is retained for action authority and names the current mission. Status uses only the canonical
// worker group; the superseded pointer summary is no longer written or read.
export type WorkerSummary = Pick<WorkerSteeringSession, 'runId' | 'phase' | 'lastContactAt' | 'deadlineAt' | 'projectPauseRevision'>;
export const workerPointer = (id: string) => projectCollection<{ missionId: string }>('workerSessions').doc(id);
export const workerSessions = (id: string) => projectCollection<Session>(`workerSessions/${id}/runs`);
const pointer = workerPointer, sessions = workerSessions;
const parse = <T>(s: z.ZodType<T>, v: unknown): T => { const p = s.safeParse(v); if (!p.success) throw new Refusal('bad_input', 'Use the documented worker fields.'); return p.data; };
// A worker past the job's end time has not ended: it finishes its turn, then waits for more time.
export const workerAvailable = (s: Session | undefined, at: number) => !!s && !['stopped', 'completed'].includes(s.phase) && s.lastContactAt >= at - 90_000 && s.lastContactAt <= at;
const available = workerAvailable;
const view = (id: string, s: Session | undefined, at: number): SteeringView => ({ agentId: id, session: s ? (({profileId: _person,...session})=>session)(s) : null, available: available(s, at), serverTime: at });
export async function syncWorkerSession(agentId: string, input: unknown, now: () => number) {
  return db.runTransaction(async tx => { const prepared = await prepareWorkerSession(tx, agentId, input, now); prepared.commit(); return prepared.reply; });
}
// `fenced`: the caller already checked this agent's current run and membership in this same transaction (the
// merged heartbeat), so it is not read again. Every other caller fences here.
export async function prepareWorkerSession(tx: Transaction, agentId: string, input: unknown, now: () => number, { terminalOnly = false, fencedRunId }: { terminalOnly?: boolean; fencedRunId?: string } = {}) {
  const v = parse(WORKER_SESSION,input);
  if (terminalOnly && (!['stopped','completed'].includes(v.phase) || v.remainingSlots !== 0)) throw new Refusal('bad_input','Final worker contact must be terminal.');
  if (fencedRunId === undefined || fencedRunId !== v.run_id) await assertRunInTransaction(tx,agentId,v.run_id);
  const a = (await tx.get(agents().doc(agentId))).data()!;
  const ref=sessions(agentId).doc(v.missionId), prior=(await tx.get(ref)).data(), p=(await tx.get(pointer(agentId))).data();
  const current=p ? (await tx.get(sessions(agentId).doc(p.missionId))).data() : undefined;
  if (prior && (prior.profileId !== a.ownerProfileId || prior.runId !== v.run_id || prior.generation !== v.generation || prior.startedAt !== v.startedAt || ![prior.deadlineAt,prior.authorizedDeadlineAt ?? prior.deadlineAt].includes(v.deadlineAt))) throw new Refusal('bad_input','Worker identity or deadline changed.');
  if (prior && ['stopped','completed'].includes(prior.phase) && v.phase !== prior.phase) throw new Refusal('bad_input','This worker already ended.');
  if (current && current.runId === v.run_id && current.missionId !== v.missionId && current.startedAt >= v.startedAt) throw new Refusal('bad_input','A newer mission replaced this one.');
  if (!prior && v.deadlineAt-v.startedAt > RUN_LENGTH.maxMinutes*60_000) throw new Refusal('bad_input','Initial deadline exceeds 24 hours.');
  const project=(await tx.get(projects.doc(currentProjectId()))).data();
  if (v.projectPauseRevision !== undefined && v.phase !== 'paused')
    throw new Refusal('bad_input','Confirm project Pause only after execution has paused.');
  // An older confirmation can arrive after Resume or another Pause. It confirms neither.
  const confirmsPause = project?.execution.paused && project.execution.pauseRequest?.revision === v.projectPauseRevision;
  const tokenLimit = project?.execution.tokenLimit ? { ...project.execution.tokenLimit, othersUsed: await jobTokensCounted(a.ownerProfileId, project.execution.startsAt, { agentId, missionId: v.missionId }) } : null;
  const session: Session={missionId:v.missionId,runId:v.run_id,generation:v.generation,profileId:a.ownerProfileId,startedAt:v.startedAt,deadlineAt:v.deadlineAt,
    // Time added to the job reaches every worker here: the reply carries the job's end time once it is later.
    authorizedDeadlineAt:Math.max(prior?.authorizedDeadlineAt ?? v.deadlineAt,project?.execution.endsAt ?? 0),phase:v.phase,lastContactAt:now(),remainingSlots:v.remainingSlots,
    ...(confirmsPause && v.projectPauseRevision !== undefined ? {projectPauseRevision:v.projectPauseRevision} : {}),
    // A contact without a count (an older stop report) keeps the stored one: a killed agent's tokens stay in the pool.
    ...(v.tokens ?? prior?.tokens ? {tokens:v.tokens ?? prior!.tokens!} : {}), tokenLimit,
    ...(v.providerLimit && v.phase === 'waiting' ? {providerLimit:v.providerLimit} : {})};
  const end = ['stopped','completed'].includes(v.phase) ? await prepareSteeringEnd(tx,agentId,v.missionId,now()) : null;
  const summary: WorkerSummary = {runId:session.runId,phase:session.phase,lastContactAt:session.lastContactAt,deadlineAt:session.deadlineAt,
    ...(session.projectPauseRevision !== undefined ? {projectPauseRevision:session.projectPauseRevision} : {})};
  const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
  // The canonical worker group is replaced whole and tagged with the run in the SAME transaction as the
  // fenced session and authority pointer. Progress was prepared above, before any writes in this callback.
  return {reply:{missionId:v.missionId,authorizedDeadlineAt:session.authorizedDeadlineAt,tokenLimit},commit:()=>{end?.();tx.set(ref,session);
    statusProgress(presence().doc(agentId));
    tx.set(presence().doc(agentId),{worker:summary} as never,{mergeFields:['worker']});
    tx.set(pointer(agentId),{missionId:v.missionId});}};
}
// The job's token pool, without this mission (its worker counts that itself): every other mission of the person's
// agents in this project since the job started, ended, restarted and revoked agents included, and this agent's
// earlier missions. A project starts once (execution.startsAt), so this is every mission in contact since then.
// Bounded: up to AGENTS_PER_PARTICIPANT_CEILING agents, revoked ones included, and POOL_MISSIONS missions each.
// Read outside the transaction: these documents are rewritten by the other workers every ~20 s, and locking them here
// would make every session sync contend with all of them. A slightly stale sum is fine, the cap is checked between turns.
const POOL_MISSIONS = 50;
// except: the caller's own current mission, which its worker counts itself. Without it, the whole pool (the job bar).
export async function jobTokensCounted(profileId: string, startsAt: number, except?: { agentId: string; missionId: string }) {
  const owned = await agents().where('ownerProfileId', '==', profileId).limit(AGENTS_PER_PARTICIPANT_CEILING).get();
  const used = await Promise.all(owned.docs.map(async d => {
    const missions = await sessions(d.id).where('lastContactAt', '>=', startsAt).limit(POOL_MISSIONS).get();
    return missions.docs.reduce((sum, m) => sum + (m.data().profileId === profileId && !(d.id === except?.agentId && m.id === except.missionId) ? m.data().tokens?.counted ?? 0 : 0), 0);
  }));
  return Math.min(Number.MAX_SAFE_INTEGER, used.reduce((sum, n) => sum + n, 0));
}
export const listMyWorkers = (profileId: string, now: () => number) => listOwnedWorkers(profileId, now);
async function listOwnedWorkers(profileId: string, now: () => number): Promise<ProjectWorkersView> {
  return db.runTransaction(async tx => {
    await assertMembership(tx, profileId);
    const epoch = await currentConnectionEpoch(tx, profileId), at = now();
    const project = (await tx.get(projects.doc(currentProjectId()))).data();
    const closed = project?.execution.completedAt != null;
    const pause = project?.execution.paused && !closed ? project.execution.pauseRequest : undefined;
    const owned = await tx.get(agents().where('ownerProfileId', '==', profileId).where('revokedAt', '==', null).where('connectionEpoch', '==', epoch).limit(AGENTS_PER_PARTICIPANT_CEILING));
    const pointers = await Promise.all(owned.docs.map(a => tx.get(pointer(a.id))));
    const rows = await Promise.all(owned.docs.map(async (a, i) => {
      const missionId = pointers[i].data()?.missionId;
      const s = missionId ? (await tx.get(sessions(a.id).doc(missionId))).data() : undefined;
      const run = (await tx.get(projectCollection<{ runId: string; startedAt?: number; endedAt: number | null; endReason?: string | null; mode?: 'current_chat' }>('runs').doc(a.id))).data();
      const worker = view(a.id, s?.profileId === profileId ? s : undefined, at);
      if (closed || run?.runId !== s?.runId || run?.endedAt !== null) worker.available = false;
      const projectPause = pause && run?.endedAt === null && (run.mode === 'current_chat' || s?.runId === run.runId && !['stopped','completed'].includes(s.phase))
        ? { ...pause, externalChat: run.mode === 'current_chat', confirmedAt: s?.phase === 'paused' && s.projectPauseRevision === pause.revision
          && s.lastContactAt <= at && s.lastContactAt > at - 90000 ? s.lastContactAt : null } : undefined;
      return { agentId: a.id, agentName: a.data().name, ...(projectPause ? {projectPause} : {}), personaChoice: personaChoice(a.data().persona?.text ?? ''), focus: a.data().focus ?? null, worker, ...await readWorkerObservation(tx, a.id), backgroundControl: await readBackgroundControl(tx,profileId,a.id,at), run: await latestAgentRun(tx,profileId,currentProjectId(),a.id,at,s?.profileId === profileId ? {missionId:s.missionId,startedAt:s.startedAt} : null, run ?? null), participation: await readParticipationControl(tx,profileId,a.id,at),
        settings: workSettings(a.data()), lastRun: run ? { startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null, endReason: run.endReason ?? null } : null };
    }));
    return { agents: rows, queued: await queuedStarts(tx, profileId, currentProjectId(), at), projectClosed: closed, serverTime: at };
  }, { readOnly: true });
}
