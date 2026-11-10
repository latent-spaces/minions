import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { assertComputerApproval } from '../owner/computer-access.js';
import { createHash, randomUUID } from 'node:crypto';
import { RUN_LENGTH, validRunMinutes } from '@mlswarm/contracts';
import type { Transaction } from '../firestore.js';
import type { ParticipationControlView, ParticipationControlKind, ParticipationControlState } from '@mlswarm/contracts';
import { z } from 'zod';
import { agents, collection, currentProjectId, db, inProject, projectCollection } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertAgentMembership, assertProjectWritable } from './access.js';
import { presence, runs, runHistory, chatParticipationEnds } from '../v2/records.js';
import { runHistoryId } from '../v2/turn-reports.js';
import { operatorStopFingerprint, prepareChatExtension } from '../v2/runs.js';

const uuid = z.string().uuid(), time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^[\w-]{1,200}$/), projectId = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.enum(['approved', 'active', 'expired', 'released', 'recovery_required']);
const target = z.object({ site: z.string().max(300).refine(value => {
  try { const u = new URL(value); return u.origin === value && (value === 'https://karma42.ai'
    || u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)); } catch { return false; }
}), ownerId: identifier, projectId, agentId: identifier }).strict();
export const PARTICIPATION_SNAPSHOT = z.object({ target, participationId: uuid, generation: z.number().int().positive(), state,
  scope: z.string().trim().min(1).max(8000).refine(value=>Buffer.byteLength(value,'utf8')<=8000), approvedAt: time, deadlineAt: time,
  cloudRun: z.object({ runId: uuid, generation: z.number().int().positive().nullable(), deadlineAt: time.nullable() }).strict().nullable(),
}).strict();
export const PARTICIPATION_SYNC = z.object({ participations: z.array(PARTICIPATION_SNAPSHOT).max(32) }).strict();
export const PARTICIPATION_CONTROL = z.object({ id: uuid, kind: z.enum(['extend','release','wake','cancel_wake']), participationId: uuid,
  generation: z.number().int().positive(), expectedDeadlineAt: time, wakeId: uuid.optional(),
  minutes: z.number().refine(validRunMinutes).optional(), approved: z.literal(true),
}).strict().superRefine((v, ctx) => {
  const grant = v.kind === 'extend' || v.kind === 'wake';
  if (grant ? v.minutes === undefined : v.minutes !== undefined)
    ctx.addIssue({ code: 'custom', message: 'Only Extend and Wake have an explicit lifetime.' });
  if (v.kind === 'cancel_wake' ? v.wakeId === undefined : v.wakeId !== undefined)
    ctx.addIssue({ code: 'custom', message: 'Cancel Wake identifies the exact queued Wake.' });
});
export const PARTICIPATION_CONTROL_RECEIPT = z.object({ state: z.enum(['applied','expired','failed']),
  message: z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f-\x9f]*$/).optional(),
}).strict();
type Snapshot = z.infer<typeof PARTICIPATION_SNAPSHOT>;
type Control = { version: 1; operationId: string; kind: ParticipationControlKind; target: Snapshot['target'];
  participationId: string; generation: number; payload: Record<string, unknown> };
type Mail = { id: string; profileId: string; connectionId: string; projectId: string; agentId: string;
  fingerprint: string; actorProfileId?:string; reason?:string; command: Control; approvedAt: number; deadlineAt: number | null;
  state: ParticipationControlState; message?: string; acknowledgedAt?: number; acceptedAt?: number };
type Saved = Snapshot & { connectionId: string; updatedAt: number; deviceLastSeenAt: number; pendingId: string | null };
const snapshots = () => projectCollection<Saved>('chatControls');
const mailbox = collection<Mail>('participationControls');
const key = (profileId: string, id: string) => createHash('sha256').update(JSON.stringify([profileId,id])).digest('hex');
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value);
  if (!result.success) throw new Refusal('bad_input','Check the command and how much time you chose.'); return result.data; };
const pendingDelivery = (mail: Mail | undefined): mail is Mail => mail?.state === 'queued' || mail?.state === 'accepted';
const terminal = (value: Snapshot, at: number) => ['expired','released'].includes(value.state) || value.deadlineAt <= at;
async function own(tx: Transaction, profileId: string, agentId: string) {
  if (!identifier.safeParse(agentId).success) throw new Refusal('not_found','This agent wasn’t found.');
  await assertMembership(tx,profileId);
  const agent = (await tx.get(agents().doc(agentId))).data();
  if (!agent || agent.ownerProfileId !== profileId) throw new Refusal('forbidden','Only the person this agent works for can change its time.');
  await assertAgentMembership(tx,agentId);
}
function publicView(saved: Saved, pending: Mail | undefined, at: number): ParticipationControlView {
  const actual = saved.state === 'released' ? 'released' : saved.deadlineAt <= at ? 'expired' : saved.state;
  return { participationId:saved.participationId,generation:saved.generation,scope:saved.scope,
    approvedAt:saved.approvedAt,deadlineAt:saved.deadlineAt,state:actual,updatedAt:saved.updatedAt,deviceLastSeenAt:saved.deviceLastSeenAt,
    pending:pending ? {id:pending.id,kind:pending.command.kind,...(pending.actorProfileId ? {actorProfileId:pending.actorProfileId}:{}),state:pendingDelivery(pending) && pending.deadlineAt!==null && pending.deadlineAt<=at ? 'expired' : pending.state,approvedAt:pending.approvedAt,
      deadlineAt:pending.deadlineAt,...(pending.message ? {message:pending.message} : {})} : null };
}
export async function readParticipationControl(tx: Transaction, profileId: string, agentId: string, at: number) {
  const saved = (await tx.get(snapshots().doc(agentId))).data();
  if (!saved || saved.target.ownerId !== profileId) return null;
  const pending = saved.pendingId ? (await tx.get(mailbox.doc(key(profileId,saved.pendingId)))).data() : undefined;
  return publicView(saved,pending,at);
}

export async function syncParticipations(profileId: string, connectionId: string, input: unknown, now: () => number) {
  const {participations} = parse(PARTICIPATION_SYNC,input);
  const seen = new Set<string>();
  for (const snapshot of participations) {
    if (snapshot.target.ownerId !== profileId) throw new Refusal('forbidden','Participation belongs to another account.');
    const identity = `${snapshot.target.projectId}:${snapshot.target.agentId}`;
    if (seen.has(identity)) throw new Refusal('bad_input','Publish each agent once per snapshot batch.'); seen.add(identity);
  }
  // Every target is independently fenced; no all-project transaction or credentials are accepted.
  let failure: unknown;
  for (const snapshot of participations) {
    try {
      await inProject(snapshot.target.projectId,() => db.runTransaction(async tx => {
        await own(tx,profileId,snapshot.target.agentId);
        const ref = snapshots().doc(snapshot.target.agentId), saved = (await tx.get(ref)).data(), at = now();
        const run = (await tx.get(runs().doc(snapshot.target.agentId))).data();
        const pending = saved?.pendingId ? (await tx.get(mailbox.doc(key(profileId,saved.pendingId)))).data() : undefined;
        if (saved && saved.connectionId !== connectionId && (!terminal(saved,at)
          || pendingDelivery(pending) && (pending.deadlineAt===null || pending.deadlineAt>at)))
          throw new Refusal('runtime_conflict','This agent is working with you from another computer. Use End there first.');
        if (saved && saved.connectionId!==connectionId && (snapshot.participationId===saved.participationId
          || snapshot.state!=='active' || snapshot.deadlineAt<=at || snapshot.cloudRun?.generation==null
          || run?.runId!==snapshot.participationId || run.mode!=='current_chat' || run.endedAt!==null))
          throw new Refusal('runtime_conflict','A different computer must explicitly claim a new cloud-confirmed participation. Saved terminal snapshots never transfer its binding.');
        if (saved && saved.connectionId === connectionId) {
          if (snapshot.generation < saved.generation || snapshot.generation === saved.generation && snapshot.participationId !== saved.participationId)
            throw new Refusal('runtime_conflict','A newer participation snapshot already exists.');
          if (snapshot.participationId !== saved.participationId && !terminal(saved,at))
            throw new Refusal('runtime_conflict','End the previous participation before publishing another.');
          if (snapshot.participationId === saved.participationId && snapshot.generation !== saved.generation)
            throw new Refusal('runtime_conflict','The participation generation changed.');
          if (snapshot.participationId===saved.participationId && (snapshot.scope!==saved.scope || snapshot.approvedAt!==saved.approvedAt))
            throw new Refusal('runtime_conflict','The approved scope and original approval cannot change inside a participation.');
          if(snapshot.participationId===saved.participationId && snapshot.deadlineAt<saved.deadlineAt)
            throw new Refusal('runtime_conflict','A delayed snapshot cannot shorten the current approved deadline.');
        }
        const cloud = snapshot.cloudRun;
        if (cloud && cloud.runId !== snapshot.participationId) throw new Refusal('bad_input','Cloud identity does not match participation.');
        if (snapshot.state === 'active' && (cloud?.generation == null || cloud.deadlineAt !== snapshot.deadlineAt || run?.mode !== 'current_chat'
          || run.runId !== snapshot.participationId || run.generation !== cloud.generation || run.endedAt !== null
          || ![snapshot.deadlineAt, pending?.command.kind === 'extend' ? pending.deadlineAt : null].includes(run.deadlineAt ?? null))) {
          // End may already have fenced this generation while its final local snapshot is in flight.
          if (!(pending?.command.kind === 'release' && pending.command.participationId === snapshot.participationId && run?.endedAt !== null))
            throw new Refusal('runtime_conflict','The cloud has not confirmed this exact active participation.');
        }
        if (!terminal(snapshot,at) && run?.endedAt === null && run.runId !== snapshot.participationId
          && (run.mode!=='current_chat' || (run.deadlineAt ?? Infinity)>at))
          throw new Refusal('run_active','Another current run already owns this agent.');
        const ended = pending?.command.kind === 'release' && pending.command.participationId === snapshot.participationId;
        await assertComputerApproval(tx, connectionId, profileId, now());
        tx.set(ref,{...snapshot,...(ended ? {state:'released' as const} : {}),connectionId,updatedAt:at,deviceLastSeenAt:at,pendingId:saved?.pendingId ?? null});
        tx.update(agents().doc(snapshot.target.agentId), { computerConnectionId: connectionId });
      }));
    } catch (error) {
      // Keep the refusal visible, but do not suppress independently authorized rows.
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return {ok:true};
}

export async function requestParticipationControl(actorId: string, agentId: string, input: unknown, now: () => number) {
  const v = parse(PARTICIPATION_CONTROL,input);
  // Property order is explicit so key order in an HTTP retry does not change its fingerprint.
  const fp = fingerprint([currentProjectId(),agentId,v.kind,v.participationId,v.generation,v.expectedDeadlineAt,v.minutes ?? null,...(v.kind === 'cancel_wake' ? [v.wakeId] : [])]);
  return db.runTransaction(async tx => {
    const profileId=actorId;
    await own(tx,profileId,agentId);
    // Ending or cancelling stays possible on a closed project; waking or extending does not.
    if (v.kind !== 'release' && v.kind !== 'cancel_wake') await assertProjectWritable(tx);
    const ref = snapshots().doc(agentId), saved = (await tx.get(ref)).data(), receiptRef = mailbox.doc(key(profileId,v.id));
    const receipt = (await tx.get(receiptRef)).data(), at = now();
    if (!saved || saved.target.ownerId !== profileId) throw new Refusal('not_found','Update MyLittleSwarm on this computer, then try again.');
    const pendingRef = saved.pendingId ? mailbox.doc(key(profileId,saved.pendingId)) : null;
    const pending = pendingRef ? (await tx.get(pendingRef)).data() : undefined;
    if (receipt) {
      if (receipt.fingerprint !== fp) throw new Refusal('duplicate','This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return {participation:publicView(saved,v.kind === 'cancel_wake' ? pending : receipt,at),replayed:true};
    }
    if (v.kind === 'cancel_wake') {
      const wakeRef = mailbox.doc(key(profileId,v.wakeId!)), wake = (await tx.get(wakeRef)).data();
      if (!wake || wake.agentId !== agentId || wake.projectId !== currentProjectId()
        || wake.command.kind !== 'wake' || wake.command.participationId !== v.participationId
        || wake.command.generation !== v.generation || saved.pendingId !== wake.id)
        throw new Refusal('runtime_conflict','This Wake changed. Refresh, then try again.');
      if (wake.state !== 'queued') throw new Refusal('runtime_conflict',wake.state === 'accepted' || wake.state === 'applied'
        ? 'This computer already started this Wake. Refresh, and use End once its new time shows.'
        : 'This Wake isn’t waiting anymore. Refresh to see what happened.');
      if (saved.deadlineAt !== v.expectedDeadlineAt) throw new Refusal('runtime_conflict','The time left changed. Refresh, then cancel the Wake again.');
      // Acceptance and cancellation contend on this same durable mailbox row.
      // A fetched envelope alone grants no permission to apply the Wake.
      tx.update(wakeRef,{state:'cancelled',message:'Wake cancelled before device acceptance.',acknowledgedAt:at});
      tx.create(receiptRef,{id:v.id,profileId,connectionId:wake.connectionId,projectId:currentProjectId(),agentId,
        fingerprint:fp,command:{...wake.command,operationId:v.id,kind:'cancel_wake',payload:{wakeId:wake.id}},
        approvedAt:at,deadlineAt:null,state:'applied'} satisfies Mail);
      const next={...saved,updatedAt:at};tx.set(ref,next);
      return {participation:publicView(next,{...wake,state:'cancelled',message:'Wake cancelled before device acceptance.'},at),replayed:false};
    }
    if (saved.participationId !== v.participationId || saved.generation !== v.generation || saved.deadlineAt !== v.expectedDeadlineAt)
      throw new Refusal('runtime_conflict','This agent’s time changed. Refresh to see the time left, then try again.');
    const pendingLive=pendingDelivery(pending) && (pending.deadlineAt===null || pending.deadlineAt>at);
    if (pendingLive && (v.kind !== 'release' || pending.command.kind === 'wake' && pending.command.payload.nextParticipationId !== saved.participationId))
      throw new Refusal('runtime_conflict','Wait for this computer to confirm the last change, then try again.');
    const active = !terminal(saved,at);
    if (v.kind === 'extend' && (!active || saved.state !== 'active')) throw new Refusal('bad_input','You can only add time while the agent is working with you in this chat.');
    if (v.kind === 'wake' && active) throw new Refusal('bad_input','Use End first, then Wake the agent with new time.');
    const runRef = runs().doc(agentId), run = (await tx.get(runRef)).data();
    const historyRef = runHistory().doc(runHistoryId(agentId,saved.participationId));
    const history = (await tx.get(historyRef)).data();
    const endRef=chatParticipationEnds().doc(runHistoryId(agentId,saved.participationId)), previousEnd=(await tx.get(endRef)).data();
    // Completed immutable receipts are ordinary history. Bound live pending work,
    // without a permanent history cap that would eventually prevent End.
    const [grants, ends] = await Promise.all([
      tx.get(mailbox.where('connectionId','==',saved.connectionId).where('state','in',['queued','accepted']).where('deadlineAt','>',at).limit(33)),
      tx.get(mailbox.where('connectionId','==',saved.connectionId).where('state','in',['queued','accepted']).where('deadlineAt','==',null).limit(33)),
    ]);
    if (grants.size + ends.size >= 32 && !(v.kind === 'release' && pendingLive))
      throw new Refusal('bad_input','This computer has 32 changes waiting. Wait for it to come back online, then try again.');
    const deadlineAt = v.kind === 'release' ? null : (v.kind === 'wake' ? at : saved.deadlineAt) + v.minutes! * 60_000;
    if (deadlineAt !== null && deadlineAt - at > RUN_LENGTH.maxMinutes * 60_000) throw new Refusal('bad_input','Keep the time left to 24 hours or less.');
    const command:Control = {version:1,operationId:v.id,kind:v.kind,target:saved.target,participationId:saved.participationId,
      generation:saved.generation,payload:v.kind === 'release' ? {} : {approved:true,approvedAt:at,deadlineAt,
        ...(v.kind === 'extend' ? {expectedDeadlineAt:saved.deadlineAt} : {nextParticipationId:randomUUID()})}};
    const mail:Mail = {id:v.id,profileId,actorProfileId:actorId,connectionId:saved.connectionId,projectId:currentProjectId(),agentId,
      fingerprint:fp,command,approvedAt:at,deadlineAt,state:'queued'};
    if (v.kind === 'extend') {
      await prepareChatExtension(tx,agentId,saved.participationId,{clientRequestId:v.id,expectedDeadlineAt:saved.deadlineAt,approvedAt:at,deadlineAt:deadlineAt!},now);
    } else if (v.kind === 'release' && run?.runId === saved.participationId && run.mode === 'current_chat' && run.endedAt === null) {
      if (!history || history.mode !== 'current_chat') throw new Refusal('runtime_conflict','Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
      const statusProgress = await prepareCurrentStateProgress(tx, [presence().doc(agentId)]);
      tx.update(runRef,{endedAt:at,endReason:'operator'});
      // The status document's run group records the end with the run (stage E1); a blind merge, as at the start.
      statusProgress(presence().doc(agentId));
      tx.set(presence().doc(agentId),{runEndedAt:at},{mergeFields:['runEndedAt']});
      tx.update(historyRef,{endedAt:at,stopFingerprint:operatorStopFingerprint()});
    } else if (v.kind === 'wake' && run?.endedAt === null && (run.mode !== 'current_chat' || (run.deadlineAt ?? Infinity) > at)) {
      throw new Refusal('run_active','This agent is already working somewhere else. Stop or End it there first.');
    }
    if (v.kind === 'release' && pendingDelivery(pending) && pendingRef) tx.update(pendingRef,{state:'failed',message:'Superseded by End participation.',acknowledgedAt:at});
    else if (pendingDelivery(pending) && pending.deadlineAt!==null && pending.deadlineAt<=at && pendingRef) tx.update(pendingRef,{state:'expired',acknowledgedAt:at});
    tx.create(receiptRef,mail);
    if(v.kind==='release' && !previousEnd) tx.create(endRef,{agentId,runId:saved.participationId,endedAt:at});
    const next = {...saved,...(v.kind === 'release' ? {state:'released' as const} : {}),pendingId:v.id,updatedAt:at};
    tx.set(ref,next);
    return {participation:publicView(next,mail,at),replayed:false};
  });
}

export async function readParticipationCommands(profileId: string, connectionId: string, query: unknown, now: () => number) {
  parse(z.object({}).strict(),query);
  const found = await mailbox.where('connectionId','==',connectionId).where('state','in',['queued','accepted']).limit(32).get();
  return {commands:found.docs.map(doc=>doc.data()).filter(mail=>mail.profileId===profileId)
    .sort((a,b)=>a.approvedAt-b.approvedAt || a.id.localeCompare(b.id)).map(mail=>({id:mail.id,command:mail.command})),serverTime:now()};
}
// Claim only Wake: cancellation must win before the device can create local intent.
// An unknown/lost reply is retried with the same ID, never treated as acceptance.
export async function acceptParticipationCommand(profileId: string, connectionId: string, id: string, input: unknown, now: () => number) {
  parse(uuid,id);parse(z.object({}).strict(),input);
  return db.runTransaction(async tx=>{
    const ref=mailbox.doc(key(profileId,id)),mail=(await tx.get(ref)).data();
    if (!mail || mail.profileId!==profileId || mail.connectionId!==connectionId) throw new Refusal('not_found','Participation command unavailable.');
    if (mail.command.kind!=='wake') throw new Refusal('bad_input','Only Wake needs device acceptance.');
    await inProject(mail.projectId,()=>own(tx,profileId,mail.agentId));
    if (mail.state==='queued') {tx.update(ref,{state:'accepted',acceptedAt:now()});return {state:'accepted' as const};}
    return {state:mail.state};
  });
}
export async function acknowledgeParticipationCommand(profileId: string, connectionId: string, id: string, input: unknown, now: () => number) {
  parse(uuid,id);const receipt=parse(PARTICIPATION_CONTROL_RECEIPT,input);
  await db.runTransaction(async tx=>{
    const ref=mailbox.doc(key(profileId,id)), mail=(await tx.get(ref)).data();
    if (!mail || mail.profileId!==profileId || mail.connectionId!==connectionId) throw new Refusal('not_found','Participation command unavailable.');
    if (mail.state!=='queued' && mail.state!=='accepted') {
      if(mail.state!==receipt.state || mail.message!==receipt.message) throw new Refusal('duplicate','Keep the original participation outcome.');
      return;
    }
    // A removed membership can refuse acceptance before any local intent exists.
    // Its inert failure/expiry must still drain; only applied claims authority.
    if (mail.command.kind==='wake' && mail.state!=='accepted' && receipt.state==='applied')
      throw new Refusal('runtime_conflict','Accept this Wake before recording an applied outcome.');
    tx.update(ref,{...receipt,acknowledgedAt:now()});
  });return {ok:true};
}
