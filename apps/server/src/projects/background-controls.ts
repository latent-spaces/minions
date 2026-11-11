import { assertComputerApproval } from '../owner/computer-access.js';
import { createHash } from 'node:crypto';
import type { Transaction } from '../firestore.js';
import { RUN_LENGTH } from '@mlswarm/contracts';
import type { BackgroundControlView, BackgroundControlState, BackgroundTarget } from '@mlswarm/contracts';
import { z } from 'zod';
import { agents, collection, currentProjectId, db, inProject, projectCollection } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertAgentMembership, assertProjectWritable } from './access.js';
import { runs } from '../v2/records.js';

const uuid = z.string().uuid(), time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^[\w-]{1,200}$/);
const target = z.object({ site: z.string().max(300).refine(value => {
  try { const url = new URL(value); return url.origin === value && (url.protocol === 'https:'
    || url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname)); } catch { return false; }
}), ownerId: identifier, projectId: z.string().regex(/^[a-f0-9]{64}$/), agentId: identifier }).strict();
const missionState = z.enum(['accepted','starting','running','waiting','blocked','pausing','paused','stopping','stopped','failed','recovery_required']);
export const BACKGROUND_SNAPSHOT = z.object({ target, missionId: uuid, generation: z.number().int().positive(),
  deadlineAt: time, state: missionState, pauseOperationId: uuid.nullable(), updatedAt: time,
  cloudRun: z.object({ runId: uuid, generation: z.number().int().positive() }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (['pausing','paused'].includes(value.state) && value.pauseOperationId === null)
    ctx.addIssue({code:'custom',message:'An operator pause needs its exact operation ID.'});
});
export const BACKGROUND_SYNC = z.object({ backgrounds: z.array(BACKGROUND_SNAPSHOT).max(32) }).strict();
export const BACKGROUND_CONTROL = z.object({ id: uuid, kind: z.enum(['pause','resume','stop']), missionId: uuid,
  generation: z.number().int().positive(), approved: z.literal(true), pauseOperationId: uuid.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'resume' ? value.pauseOperationId === undefined : value.pauseOperationId !== undefined)
    ctx.addIssue({code:'custom',message:'Only Resume names the exact Pause it releases.'});
});
export const BACKGROUND_RECEIPT = z.object({ state: z.enum(['accepted','applied','failed','expired']),
  message: z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f-\x9f]*$/).optional(),
}).strict();
type Snapshot = z.infer<typeof BACKGROUND_SNAPSHOT>;
type Saved = Snapshot & { connectionId: string; deviceLastSeenAt: number; pendingId: string | null };
type Command = { version: 2; operationId: string; kind: 'pause' | 'resume' | 'stop'; target: BackgroundTarget;
  missionId: string; generation: number; payload: { pauseOperationId?: string } };
type Mail = { id: string; profileId: string; connectionId: string; projectId: string; agentId: string; fingerprint: string; actorProfileId?: string; reason?:string;
  // deadlineAt is this command's own expiry, not the mission's.
  command: Command; approvedAt: number; deadlineAt: number; state: BackgroundControlState; message?: string; acknowledgedAt?: number; effectObservedAt?: number };
type Computer = {profileId:string|null;revokedAt:number|null;approvedAt:number|null;connectionExpiresAt:number|null};
const computers=collection<Computer>('computerConnections');
const approvedComputer=(computer:Computer|undefined,profileId:string,at:number)=>!!computer && computer.profileId===profileId && computer.revokedAt===null && computer.approvedAt!==null && (computer.connectionExpiresAt??0)>at;
const snapshots = () => projectCollection<Saved>('backgroundControls');
const mailbox = collection<Mail>('backgroundControls');
const key = (profileId: string, id: string) => createHash('sha256').update(JSON.stringify([profileId,id])).digest('hex');
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value);
  if (!result.success) throw new Refusal('bad_input','Some fields in this request are missing or not in the expected form.'); return result.data; };
const unresolved = (mail: Mail | undefined): mail is Mail & {state:'queued'|'accepted'} => !!mail && ['queued','accepted'].includes(mail.state);
// The job's end time does not end a mission: its worker finishes the turn and waits, and can still be paused, resumed or stopped.
const ended = (saved: Snapshot) => ['stopped','failed'].includes(saved.state);
async function own(tx: Transaction, profileId: string, agentId: string) {
  if (!identifier.safeParse(agentId).success) throw new Refusal('not_found','This agent wasn’t found.');
  await assertMembership(tx,profileId);
  const agent = (await tx.get(agents().doc(agentId))).data();
  if (!agent || agent.ownerProfileId !== profileId) throw new Refusal('forbidden','Only the person this agent works for can pause or resume it.');
  await assertAgentMembership(tx,agentId);
}
function publicView(saved: Saved, pending: Mail | undefined, at: number): BackgroundControlView {
  return {target:saved.target,missionId:saved.missionId,generation:saved.generation,deadlineAt:saved.deadlineAt,
    state:saved.state,pauseOperationId:saved.pauseOperationId,updatedAt:saved.updatedAt,deviceLastSeenAt:saved.deviceLastSeenAt,
    available:!ended(saved) && saved.deviceLastSeenAt >= at-90_000 && !['stopping','recovery_required'].includes(saved.state),
    pending:pending ? {id:pending.id,kind:pending.command.kind,...(pending.actorProfileId ? {actorProfileId:pending.actorProfileId}:{}),state:unresolved(pending) && pending.deadlineAt<=at ? 'expired':pending.state,
      approvedAt:pending.approvedAt,...(pending.message ? {message:pending.message}:{})}:null};
}
export async function readBackgroundControl(tx: Transaction, profileId: string, agentId: string, at: number) {
  const saved=(await tx.get(snapshots().doc(agentId))).data();
  if (!saved || saved.target.ownerId!==profileId) return null;
  const pending=saved.pendingId ? (await tx.get(mailbox.doc(key(profileId,saved.pendingId)))).data():undefined;
  const run=(await tx.get(runs().doc(agentId))).data(),computer=(await tx.get(computers.doc(saved.connectionId))).data();
  const result=publicView(saved,pending,at);
  if(!approvedComputer(computer,profileId,at) || saved.cloudRun && (run?.runId!==saved.missionId || run.endedAt!==null || run.generation!==saved.cloudRun.generation)) result.available=false;
  return result;
}
export async function syncBackgrounds(profileId: string, connectionId: string, input: unknown, now:()=>number) {
  const {backgrounds}=parse(BACKGROUND_SYNC,input),seen=new Set<string>();
  for(const snapshot of backgrounds) {
    if(snapshot.target.ownerId!==profileId) throw new Refusal('forbidden','Background mission belongs to another account.');
    const identity=JSON.stringify([snapshot.target.projectId,snapshot.target.agentId]);
    if(seen.has(identity)) throw new Refusal('bad_input','Publish each background agent once per batch.');seen.add(identity);
  }
  let failure:unknown;
  for(const snapshot of backgrounds) try {
    await inProject(snapshot.target.projectId,()=>db.runTransaction(async tx=>{
      await own(tx,profileId,snapshot.target.agentId);
      const ref=snapshots().doc(snapshot.target.agentId),saved=(await tx.get(ref)).data();
      const run=(await tx.get(runs().doc(snapshot.target.agentId))).data(),at=now();
      const pendingRef=saved?.pendingId ? mailbox.doc(key(profileId,saved.pendingId)):null;
      const pending=pendingRef ? (await tx.get(pendingRef)).data():undefined;
      const same=saved?.missionId===snapshot.missionId;
      if(saved && saved.connectionId!==connectionId && (!ended(saved) || same))
        throw new Refusal('runtime_conflict','This mission belongs to another approved computer.');
      if(saved && ((!same && snapshot.generation<=saved.generation) || snapshot.generation<saved.generation || same && (snapshot.generation!==saved.generation || snapshot.target.site!==saved.target.site)
        || !same && !ended(saved))) throw new Refusal('runtime_conflict','A different background mission already owns this agent.');
      if(same && saved!.state==='recovery_required' && !['recovery_required','stopped','failed'].includes(snapshot.state))
        throw new Refusal('runtime_conflict','Inspection-only recovery cannot become running work.');
      if(same && saved!.cloudRun && (snapshot.cloudRun?.runId!==saved!.cloudRun.runId || snapshot.cloudRun?.generation!==saved!.cloudRun.generation))
        throw new Refusal('runtime_conflict','The confirmed cloud run binding cannot be replaced or cleared.');
      if(same && snapshot.updatedAt<saved!.updatedAt) throw new Refusal('runtime_conflict','A newer background observation already exists.');
      if(same && ['stopped','failed'].includes(saved!.state) && snapshot.state!==saved!.state)
        throw new Refusal('runtime_conflict','A delayed observation cannot reopen ended work.');
      if(same && snapshot.deadlineAt<saved!.deadlineAt) throw new Refusal('runtime_conflict','A delayed observation cannot shorten the approved deadline.');
      if(snapshot.cloudRun && (snapshot.cloudRun.runId!==snapshot.missionId || run?.runId!==snapshot.missionId
        || run.generation!==snapshot.cloudRun.generation || run.mode==='current_chat'))
        throw new Refusal('runtime_conflict','The cloud has not confirmed this exact background run.');
      if(!snapshot.cloudRun && run?.endedAt===null && run.runId!==snapshot.missionId)
        throw new Refusal('run_active','Another run already owns this agent.');
      if(saved && saved.connectionId!==connectionId && (!snapshot.cloudRun || run?.endedAt!==null))
        throw new Refusal('runtime_conflict','Another computer must first confirm a fresh background run.');
      await assertComputerApproval(tx, connectionId, profileId, now());
      const effect= same && unresolved(pending) && pending.command.missionId===snapshot.missionId && pending.command.generation===snapshot.generation
        && (pending.command.kind==='stop' ? snapshot.state==='stopped' : !ended(snapshot) && (pending.command.kind==='pause'
          ? snapshot.state==='paused' && snapshot.pauseOperationId===pending.id
          : pending.state==='accepted' && snapshot.pauseOperationId===null && ['accepted','starting','running','waiting','blocked'].includes(snapshot.state)));
      // Retain proof of an observed effect across a lost ACK and later Stop/new Pause.
      if(effect && !pending!.effectObservedAt && pendingRef) tx.update(pendingRef,{effectObservedAt:at});
      tx.set(ref,{...snapshot,connectionId,deviceLastSeenAt:at,pendingId:same ? saved!.pendingId:null} satisfies Saved);
      tx.update(agents().doc(snapshot.target.agentId), { computerConnectionId: connectionId });
    }));
  } catch(error) {failure??=error;}
  if(failure) throw failure;
  return {ok:true};
}
export async function requestBackgroundControl(actorId:string,agentId:string,input:unknown,now:()=>number) {
  const value=parse(BACKGROUND_CONTROL,input);
  const fingerprint=createHash('sha256').update(JSON.stringify([currentProjectId(),agentId,value.kind,value.missionId,value.generation,value.pauseOperationId??null])).digest('hex');
  return db.runTransaction(async tx=>{
    await own(tx,actorId,agentId);
    const profileId=actorId;
    // A closed project can still pause its agents, never resume them.
    if(value.kind==='resume') await assertProjectWritable(tx);
    const ref=snapshots().doc(agentId),saved=(await tx.get(ref)).data(),receiptRef=mailbox.doc(key(profileId,value.id));
    const receipt=(await tx.get(receiptRef)).data(),at=now();
    if(!saved || saved.target.ownerId!==profileId) throw new Refusal('not_found','Update MyLittleSwarm on this computer, then try again.');
    if(receipt) {
      if(receipt.fingerprint!==fingerprint) throw new Refusal('duplicate','This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return {background:publicView(saved,receipt,at),replayed:true};
    }
    const pendingRef=saved.pendingId ? mailbox.doc(key(profileId,saved.pendingId)):null;
    const pending=pendingRef ? (await tx.get(pendingRef)).data():undefined;
    const run=(await tx.get(runs().doc(agentId))).data(),computer=(await tx.get(computers.doc(saved.connectionId))).data();
    const queued=await tx.get(mailbox.where('connectionId','==',saved.connectionId).where('state','in',['queued','accepted']).limit(33));
    if(!approvedComputer(computer,profileId,at)) throw new Refusal('runtime_conflict','This computer’s approval ended. Approve this computer again, then try again.');
    if(saved.missionId!==value.missionId || saved.generation!==value.generation)
      throw new Refusal('runtime_conflict','This agent’s work changed. Refresh, then try again.');
    if(ended(saved) || ['stopping','recovery_required'].includes(saved.state)) throw new Refusal('runtime_conflict','This agent already stopped working, so it can’t be paused or resumed. Start it again instead.');
    if(saved.cloudRun && (run?.runId!==saved.missionId || run.endedAt!==null || run.generation!==saved.cloudRun.generation))
      throw new Refusal('runtime_conflict','This agent was started again somewhere else. Refresh, then try again.');
    if(unresolved(pending) && pending.deadlineAt>at && (value.kind!=='stop'||pending.command.kind==='stop')) throw new Refusal('runtime_conflict','Wait for the computer to confirm the last action, then try again.');
    if(value.kind==='resume' && (saved.state!=='paused' || saved.pauseOperationId!==value.pauseOperationId))
      throw new Refusal('runtime_conflict','There’s no confirmed pause to resume. Refresh, then try again.');
    if(value.kind==='pause' && !['accepted','starting','running','waiting'].includes(saved.state))
      throw new Refusal('runtime_conflict','This agent isn’t working right now, so there’s nothing to pause.');
    // Stop may replace this exact queued command without increasing mailbox load.
    const replacesPending=value.kind==='stop' && unresolved(pending) && pendingRef!==null
      && queued.docs.some(doc=>doc.ref.path===pendingRef.path);
    if(queued.size-Number(replacesPending)>=32) throw new Refusal('bad_input','This computer has 32 changes waiting. Wait for it to come back online, then try again.');
    const command:Command={version:2,operationId:value.id,kind:value.kind,target:saved.target,missionId:saved.missionId,generation:saved.generation,
      payload:value.kind==='resume' ? {pauseOperationId:value.pauseOperationId!}:{}};
    const mail:Mail={id:value.id,profileId,actorProfileId:actorId,connectionId:saved.connectionId,projectId:currentProjectId(),agentId,fingerprint,command,
      approvedAt:at,deadlineAt:at+RUN_LENGTH.maxMinutes*60_000,state:'queued'};
    if(unresolved(pending) && pendingRef) tx.update(pendingRef,{state:value.kind==='stop'?'failed':'expired',message:'Superseded by a newer control.',acknowledgedAt:at});
    tx.create(receiptRef,mail);const next={...saved,pendingId:value.id};tx.set(ref,next);
    return {background:publicView(next,mail,at),replayed:false};
  });
}
export async function readBackgroundCommands(profileId:string,connectionId:string,query:unknown,now:()=>number) {
  parse(z.object({}).strict(),query);
  const found=await mailbox.where('connectionId','==',connectionId).where('state','in',['queued','accepted']).limit(32).get();
  return {commands:found.docs.map(doc=>doc.data()).filter(mail=>mail.profileId===profileId)
    .sort((a,b)=>a.approvedAt-b.approvedAt || a.id.localeCompare(b.id)).map(mail=>({id:mail.id,command:mail.command,deadlineAt:mail.deadlineAt})),serverTime:now()};
}
export async function acknowledgeBackgroundCommand(profileId:string,connectionId:string,id:string,input:unknown,now:()=>number) {
  parse(uuid,id);const receipt=parse(BACKGROUND_RECEIPT,input);
  await db.runTransaction(async tx=>{
    const ref=mailbox.doc(key(profileId,id)),mail=(await tx.get(ref)).data();
    if(!mail || mail.profileId!==profileId || mail.connectionId!==connectionId) throw new Refusal('not_found','Background control unavailable.');
    if(!unresolved(mail)) {
      if(mail.state!==receipt.state || mail.message!==receipt.message) throw new Refusal('duplicate','Keep the original background outcome.');return;
    }
    if(receipt.state==='accepted' && mail.state==='accepted') return;
    if(receipt.state==='applied' && !mail.effectObservedAt)
      throw new Refusal('runtime_conflict','Publish the exact confirmed control effect before acknowledging it.');
    tx.update(ref,{...receipt,acknowledgedAt:now()});
  });return {ok:true};
}
