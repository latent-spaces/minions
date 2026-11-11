import { prepareOnboardingProgress } from '../onboarding/progress.js';
import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { agents, collection, currentProjectId, db, inProject } from '../firestore.js';
import { Refusal } from '../errors.js';
import { agentLimit, agentLimitReached } from '../onboarding/store.js';
import { AGENTS_PER_PARTICIPANT_CEILING } from '../platform/settings.js';
import { assertAgentMembership, assertMembership, assertProjectWritable, currentConnectionEpoch } from '../projects/access.js';
import { projects } from '../projects/records.js';

const uuid = z.string().uuid();
// Adding an agent means it will work: without a task it works toward the project's goal.
export const DEFAULT_AGENT_TASK = "Work toward the project's goal.";
// A run waits for its project to start, the job to have time and its computer to come online. It works until the job's end time.
const WAIT_MS = 7*86400_000;
const identifier = z.string().regex(/^[\w-]{1,200}$/);
// Connectors from before the 10 November 2026 local-package decision still send an update report. It is accepted so
// their readiness keeps working, and is neither stored nor read; remove it once no such connector reports readiness.
const readinessInput = z.object({ updates: z.unknown().optional(), protocol:z.literal(1), version:z.string().min(1).max(80).regex(/^[\w.+-]+$/), incarnation:uuid,
  platform:z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/),
  providers:z.array(z.object({id:z.enum(['codex','claude']),available:z.boolean(),reason:z.enum(['ready','unavailable','unsupported_platform'])}).strict()).max(2),
  // Whether gh on that computer is signed in, for the website's Connect GitHub step. Optional while computers on
  // connector 0.1.0-beta.46 and earlier, which don't send it, are connected; required once they are gone.
  github:z.enum(['ready','signed_out','missing']).optional(),
}).strict().refine(v=>new Set(v.providers.map(p=>p.id)).size===v.providers.length);
const startInput = z.object({ id:uuid, connectionId:uuid, projectId:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().regex(/^[\w-]{1,64}$/),
  scope:z.string().trim().min(1).max(8000).refine(v=>Buffer.byteLength(v,'utf8')<=8000&&!v.includes('\0')).default(DEFAULT_AGENT_TASK),
  agentId:z.string().regex(/^[\w-]{1,200}$/).optional(),
  execution:z.object({provider:z.enum(['codex','claude']),model:z.string().regex(/^[A-Za-z0-9_:.-]{1,150}$/).nullable()}).strict(),approved:z.literal(true),
}).strict();
const receiptInput = z.object({incarnation:uuid,state:z.enum(['starting','working','failed','expired','recovery_required']),agentId:identifier.optional(),
  code:z.enum(['preparation_failed','provider_unavailable','request_expired','recovery_required','launch_failed','unsupported_runtime','membership_lost','cancelled']).optional(),
}).strict();
type Readiness = Omit<z.infer<typeof readinessInput>,'updates'> & {profileId:string;connectionId:string;lastSeenAt:number};
type RepositoryWait = 'github'|'empty_repository';
const repositoryWait = z.enum(['github','empty_repository']);
const repositoryCheck = z.object({waitingFor:repositoryWait.nullable(),code:z.enum(['ready','invalid_repository','git_missing','empty_repository','network_timeout','dns_failed','tls_failed','git_authentication_failed','repository_access_denied','git_failed']),checkedAt:z.number().int().nonnegative()}).strict();
type StartState = 'pending'|'accepted'|'starting'|'working'|'failed'|'expired'|'recovery_required';
export type WebAgentStart = Omit<z.infer<typeof startInput>,'approved'|'agentId'> & {profileId:string;fingerprint:string;incarnation:string|null;state:StartState;
  createdAt:number;activeUntil:number;pickupByAt:number;acceptedAt:number|null;launchByAt:number|null;deadlineAt:number|null;agentId:string|null;code?:string;
  // Set by the computer while it can't reach the project's repository yet, or the repository has no commit to work
  // from; the start waits instead of failing.
  waitingOn?:RepositoryWait|null; repository?:z.infer<typeof repositoryCheck>|null};
export const runtimeReadiness = collection<Readiness>('ownerRuntimeReadiness');
export const webAgentStarts = collection<WebAgentStart>('webAgentStarts');
const connections = collection<{profileId:string|null;approvedAt:number|null;revokedAt:number|null;connectionExpiresAt:number|null}>('computerConnections');
export const webStartKey = (profileId:string,id:string)=>hashToken(JSON.stringify([profileId,id]));
const parse = <T>(schema:z.ZodType<T>,input:unknown):T=>{const v=schema.safeParse(input);if(!v.success)throw new Refusal('bad_input','Some fields in this request are missing or not in the expected form.');return v.data;};
const missing = ()=>new Refusal('not_found','This Add agent request wasn’t found. Add the agent again.');
const terminal = (state:StartState)=>['working','failed','expired','recovery_required'].includes(state);
function view(saved:WebAgentStart,at:number) {
  const {profileId:_,fingerprint:__,activeUntil:___,...v}=saved;
  return {...v,state:(v.state==='pending'&&at>=v.pickupByAt?'expired':['accepted','starting'].includes(v.state)&&at>=v.launchByAt!?'recovery_required':v.state) as StartState};
}
export function readinessView(value:Readiness|undefined,at:number) {
  if(!value)return null;
  // A readiness record saved before 10 November 2026 can still hold an update report; it is not read.
  const {profileId:_,connectionId:__,updates:___,...v}=value as Readiness&{updates?:unknown};
  return {...v,online:at>=v.lastSeenAt&&at-v.lastSeenAt<45_000};
}
async function connection(tx:Transaction,profileId:string,connectionId:string,at:number) {
  const c=(await tx.get(connections.doc(connectionId))).data();
  if(!c||c.profileId!==profileId||c.approvedAt===null||c.revokedAt!==null||c.connectionExpiresAt===null||c.connectionExpiresAt<=at)
    throw new Refusal('unauthorized','This computer approval expired or was ended. Approve this computer again.');
}
async function access(tx:Transaction,profileId:string,projectId:string) {
  return inProject(projectId,async()=>{await assertMembership(tx,profileId);await assertProjectWritable(tx);return currentConnectionEpoch(tx,profileId);});
}
// What keeps the project from letting agents work now: it is not started, paused or closed ('project'), or its job
// has no time left ('time'). endsAt is the job's end time once nothing does.
async function projectWait(projectId:string,at:number,tx?:Transaction) {
  const ref=projects.doc(projectId),e=(tx?(await tx.get(ref)):(await ref.get())).data()?.execution;
  if(!e||!e.started||e.paused||e.completedAt!==null)return {wait:'project' as const};
  return e.endsAt!==undefined&&e.endsAt>at?{wait:null,endsAt:e.endsAt}:{wait:'time' as const};
}
export async function publishRuntimeReadiness(profileId:string,connectionId:string,input:unknown,now:()=>number) {
  const {updates:_,...value}=parse(readinessInput,input);
  // The service probes the native guard before offering a provider. Unsupported
  // platforms cannot advertise execution merely by supplying a boolean.
  const providers=value.providers.map(p=>!['darwin','linux','win32'].includes(value.platform)?{...p,available:false,reason:'unsupported_platform' as const}:
    {...p,available:p.available&&p.reason==='ready'});
  return db.runTransaction(async tx=>{const at=now();await connection(tx,profileId,connectionId,at);
    const progress = value.github === 'ready' ? await prepareOnboardingProgress(tx, profileId, at) : null;
    progress?.(['github']);
    tx.set(runtimeReadiness.doc(connectionId),{...value,providers,profileId,connectionId,lastSeenAt:at});return {ok:true,serverTime:at};});
}
// An offline approved computer queues the start and picks it up when it comes online (owner decision, 20 October 2026).
export async function createWebAgentStart(profileId:string,input:unknown,now:()=>number) {
  const {approved:_,agentId:existing,...value}=parse(startInput,input);
  const fingerprint=hashToken(JSON.stringify([value.connectionId,value.projectId,value.name,value.scope,value.execution.provider,value.execution.model,existing??null]));
  return db.runTransaction(async tx=>{
    const ref=webAgentStarts.doc(webStartKey(profileId,value.id)),previous=(await tx.get(ref)).data(),at=now();
    // Retry identity precedes changing availability, membership and name observations.
    if(previous){if(previous.fingerprint!==fingerprint)throw new Refusal('duplicate','This request ID was already used with different details. Send the original request again, or use a new request ID.');return {request:view(previous,at)};}
    await connection(tx,profileId,value.connectionId,at);
    const epoch=await access(tx,profileId,value.projectId);
    // An online computer must offer the provider.
    const ready=(await tx.get(runtimeReadiness.doc(value.connectionId))).data();
    if(ready&&ready.profileId===profileId&&readinessView(ready,at)?.online&&!ready.providers.some(p=>p.id===value.execution.provider&&p.available&&p.reason==='ready'))
      throw new Refusal('runtime_conflict','That coding tool isn’t available on this computer. Choose another one.');
    if(existing){
      const agent=(await inProject(value.projectId,()=>tx.get(agents().doc(existing)))).data();
      if(!agent||agent.ownerProfileId!==profileId||agent.revokedAt!==null||agent.connectionEpoch!==epoch||agent.name!==value.name)throw new Refusal('not_found','Choose one of your own agents in this project.');
    }else{
      const [owned,limit]=await Promise.all([inProject(value.projectId,()=>tx.get(agents().where('ownerProfileId','==',profileId).where('revokedAt','==',null).where('connectionEpoch','==',epoch).limit(AGENTS_PER_PARTICIPANT_CEILING))),agentLimit(tx)]);
      if(owned.docs.some(d=>d.data().name===value.name&&d.data().revokedAt===null&&d.data().connectionEpoch===epoch))throw new Refusal('duplicate','Choose a new agent name. You already own an agent with this name.');
      // Refuse a new agent here rather than after the computer picks the start up.
      if(owned.size>=limit)throw agentLimitReached(limit,owned.size);
    }
    // A per-computer fence serializes concurrent creation and keeps the pending bound exact.
    const fence=collection<{revision:number}>('webAgentStartOwners').doc(value.connectionId), revision=(await tx.get(fence)).data()?.revision??0;
    const outstanding=await tx.get(webAgentStarts.where('connectionId','==',value.connectionId).where('state','in',['pending','accepted','starting']).where('activeUntil','>',at).limit(8));
    if(outstanding.docs.filter(d=>{const r=d.data();return r.profileId===profileId&&(r.state==='pending'?r.pickupByAt>at:r.launchByAt!>at);}).length>=8)
      throw new Refusal('bad_input','This computer is already starting eight agents. Wait for them to finish, then try again.');
    const saved:WebAgentStart={...value,profileId,fingerprint,incarnation:null,state:'pending',createdAt:at,activeUntil:at+WAIT_MS,pickupByAt:at+WAIT_MS,acceptedAt:null,launchByAt:null,deadlineAt:null,agentId:existing??null};
    tx.create(ref,saved);tx.set(fence,{revision:revision+1});return {request:view(saved,at)};
  });
}
// An agent's most recent run: whether one is still waiting, and which computer it last ran on.
// A start that failed or expired never ran, so a mission that started after it (a restart from a
// coding agent, which leaves no website start) replaces it: it is reported as superseded.
// What a pending start waits for: its project to start, the job to have time, its computer to come online, then access to the repository.
async function waitingFor(tx:Transaction,r:WebAgentStart,at:number) {
  return (await projectWait(r.projectId,at,tx)).wait??(!readinessView((await tx.get(runtimeReadiness.doc(r.connectionId))).data(),at)?.online?'computer' as const
    :r.waitingOn??null);
}
// Agents added on the website whose computer was offline, so none exists yet: everyone in the project sees them
// as Waiting until the computer comes online and creates them. Ids are `queued-` plus the request's key.
export async function projectQueuedStarts(projectId:string,at:number) {
  const rows=(await webAgentStarts.where('projectId','==',projectId).where('agentId','==',null).where('state','==','pending').where('pickupByAt','>',at).limit(20).get()).docs;
  return rows.map(d=>({id:`queued-${d.id}`,name:d.data().name,profileId:d.data().profileId,createdAt:d.data().createdAt}));
}
export async function queuedStart(id:string,at:number) {
  const key=/^queued-([a-f0-9]{64})$/.exec(id)?.[1];if(!key)return null;
  const r=(await webAgentStarts.doc(key).get()).data();
  return r&&r.projectId===currentProjectId()&&r.agentId===null&&r.state==='pending'&&r.pickupByAt>at?{id,name:r.name,profileId:r.profileId,createdAt:r.createdAt}:null;
}
// New agents started from the website that no computer has registered yet: queued, accepted or starting.
export async function queuedStarts(tx:Transaction,profileId:string,projectId:string,at:number) {
  const query=webAgentStarts.where('profileId','==',profileId).where('projectId','==',projectId).where('agentId','==',null);
  // Expired rows persist for history. Filter each live window before the bounded reads,
  // so old pending or missed launches cannot crowd every live request out of the page.
  const pages=await Promise.all([
    tx.get(query.where('state','==','pending').where('pickupByAt','>',at).limit(20)),
    tx.get(query.where('state','in',['accepted','starting']).where('launchByAt','>',at).limit(20)),
  ]);
  const live=pages.flatMap(page=>page.docs.map(d=>d.data())).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).slice(0,20);
  return Promise.all(live.map(async r=>({id:r.id,name:r.name,waitingFor:r.state==='pending'?await waitingFor(tx,r,at):null})));
}
// The latest start request keeps its own lifecycle, which ends at 'working'. Read beside the agent's current mission
// and run, a start that a newer mission replaced is 'superseded' and one whose own run has ended is 'ended', so it never
// contradicts worker.session or lastRun in the same answer.
export async function latestAgentRun(tx:Transaction,profileId:string,projectId:string,agentId:string,at:number,mission:{missionId:string;startedAt:number}|null=null,
  run:{runId:string;endedAt:number|null}|null=null) {
  const r=(await tx.get(webAgentStarts.where('profileId','==',profileId).where('projectId','==',projectId).where('agentId','==',agentId).orderBy('createdAt','desc').limit(1))).docs[0]?.data();
  if(!r)return null;
  const viewed=view(r,at).state;
  const state=['failed','expired','working'].includes(viewed)&&mission!==null&&mission.missionId!==r.id&&mission.startedAt>=r.createdAt?'superseded' as const
    :viewed==='working'&&run?.runId===r.id&&run.endedAt!==null?'ended' as const:viewed;
  return {id:r.id,state,waitingFor:state==='pending'?await waitingFor(tx,r,at):null,connectionId:r.connectionId,execution:r.execution,repository:r.repository??null};
}
export async function readWebAgentStart(profileId:string,id:string,now:()=>number) {
  parse(uuid,id);const r=(await webAgentStarts.doc(webStartKey(profileId,id)).get()).data();if(!r||r.profileId!==profileId)throw missing();
  const at=now(),request=view(r,at);
  if(request.state!=='pending')return {request:{...request,waitingFor:null}};
  const online=!!readinessView((await runtimeReadiness.doc(r.connectionId).get()).data(),at)?.online;
  return {request:{...request,waitingFor:(await projectWait(r.projectId,at)).wait??(!online?'computer' as const:r.waitingOn??null)}};
}
export async function readAgentStarts(profileId:string,connectionId:string,query:unknown,now:()=>number) {
  parse(z.object({}).strict(),query);
  const at=now();
  const pending=await webAgentStarts.where('connectionId','==',connectionId).where('state','in',['pending','accepted','starting']).where('activeUntil','>',at).limit(8).get();
  // A run reaches its computer only once its project lets agents work. A new agent's request comes at once, so the
  // computer creates the agent while it waits, the same as adding one from a coding agent.
  const open=new Map<string,boolean>();
  for(const d of pending.docs){const r=d.data();if(r.state==='pending'&&!open.has(r.projectId))open.set(r.projectId,(await projectWait(r.projectId,at)).wait===null);}
  return {requests:pending.docs.map(d=>d.data()).filter(r=>r.profileId===profileId&&(r.state==='pending'?r.pickupByAt>at&&(r.agentId===null||open.get(r.projectId)):r.launchByAt!>at))
    .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).map(r=>view(r,at)),serverTime:at};
}
export async function acceptAgentStart(profileId:string,connectionId:string,id:string,input:unknown,now:()=>number) {
  parse(uuid,id);const {incarnation,waitingFor,repository}=parse(z.object({incarnation:uuid,waitingFor:repositoryWait.optional(),repository:repositoryCheck.optional()}).strict(),input);
  if(repository && (repository.waitingFor!==waitingFor || repository.code==='ready' || (repository.code==='empty_repository')!==(waitingFor==='empty_repository')))throw new Refusal('bad_input','Repository evidence must match the waiting reason.');
  return db.runTransaction(async tx=>{const ref=webAgentStarts.doc(webStartKey(profileId,id)),r=(await tx.get(ref)).data(),at=now();
    if(!r||r.profileId!==profileId||r.connectionId!==connectionId)throw missing();
    if(r.incarnation!==null&&r.incarnation!==incarnation)throw new Refusal('runtime_conflict','This request was made before MyLittleSwarm restarted on this computer. Add the agent again.');
    if(terminal(r.state))return {request:view(r,at)};
    await connection(tx,profileId,connectionId,at);await access(tx,profileId,r.projectId);
    const ready=(await tx.get(runtimeReadiness.doc(connectionId))).data();
    if(!ready||ready.incarnation!==incarnation||!readinessView(ready,at)?.online)throw new Refusal('runtime_conflict','MyLittleSwarm on this computer restarted or stopped. Add the agent again.');
    if(r.state!=='pending')return {request:view(r,at)};
    if(at>=r.pickupByAt){tx.update(ref,{state:'expired'});return {request:view({...r,state:'expired'},at)};}
    const project=await projectWait(r.projectId,at,tx);
    if(project.wait!==null)return {request:view(r,at)};
    // The computer can't reach the repository yet, or it is empty: the start keeps waiting and says why, instead of failing.
    if(waitingFor){
      if(repository && (repository.checkedAt>at+30_000||repository.checkedAt<at-180_000))throw new Refusal('bad_input','Repository check expired. Check again.');
      const next={...r,waitingOn:waitingFor,...(repository?{repository}:{})};
      tx.update(ref,{waitingOn:waitingFor,...(repository?{repository}:{})});return {request:view(next,at)};
    }
    // The run works until the job's end time, like every other worker of the project. It stays listed for its launch
    // window even when the end time comes first: the computer then starts it waiting for more time.
    const next={...r,waitingOn:null,repository:null,incarnation,state:'accepted' as const,acceptedAt:at,launchByAt:at+180_000,deadlineAt:project.endsAt,activeUntil:Math.max(project.endsAt,at+180_000)};tx.set(ref,next);return {request:view(next,at)};
  });
}
// Called inside the existing registration transaction before any agent writes. This is a
// new-only association: even an unpaired same-name agent cannot be adopted by web creation.
export async function associateWebStart(tx:Transaction,profileId:string,connectionId:string|undefined,projectId:string,id:string,name:string,
  agentId:string,existing:{id:string;tokenHash:string}|undefined,tokenHash:string,at:number) {
  const ref=webAgentStarts.doc(webStartKey(profileId,id)),r=(await tx.get(ref)).data();
  if(!r||r.profileId!==profileId||r.connectionId!==connectionId||r.projectId!==projectId||r.name!==name)throw missing();
  await connection(tx,profileId,connectionId!,at);
  const replay=!!existing&&r.agentId===existing.id&&existing.tokenHash===tokenHash;
  if(existing&&!replay)throw new Refusal('duplicate','Choose a new name. Adding an agent from the website always creates a new agent.');
  if(replay)return;
  const ready=(await tx.get(runtimeReadiness.doc(connectionId!))).data();
  // Registered while it waits (pending, on an online computer) or at launch (accepted by this service incarnation).
  const waiting=r.state==='pending'&&at<r.pickupByAt&&!!readinessView(ready,at)?.online;
  if(!waiting&&(r.state!=='accepted'||r.launchByAt===null||at>=r.launchByAt||!ready||ready.incarnation!==r.incarnation))
    throw new Refusal('runtime_conflict','This computer didn’t pick up the request in time. Add the agent again.');
  if(r.agentId!==null)throw new Refusal('duplicate','This request already belongs to another agent.');
  tx.update(ref,{agentId});
  return {involvement:'on_own' as const};
}
export async function receiptAgentStart(profileId:string,connectionId:string,id:string,input:unknown,now:()=>number) {
  parse(uuid,id);const receipt=parse(receiptInput,input);
  return db.runTransaction(async tx=>{const ref=webAgentStarts.doc(webStartKey(profileId,id)),r=(await tx.get(ref)).data(),at=now();
    if(!r||r.profileId!==profileId||r.connectionId!==connectionId)throw missing();
    if(r.incarnation!==receipt.incarnation)throw new Refusal('runtime_conflict','This request was picked up before MyLittleSwarm restarted on this computer. Add the agent again.');
    if(receipt.agentId!==undefined&&receipt.agentId!==r.agentId)throw new Refusal('forbidden','This receipt belongs to another agent.');
    if(r.state==='working'&&receipt.state==='starting')return {ok:true,request:view(r,at)};
    if(terminal(r.state)){
      if(r.state!==receipt.state||(r.code??null)!==(receipt.code??null))throw new Refusal('duplicate','Keep the original start outcome.');
      return {ok:true,request:view(r,at)};
    }
    if(r.state==='pending')throw new Refusal('runtime_conflict','Accept this request before reporting its outcome.');
    if(['starting','working'].includes(receipt.state)) {
      if(!r.agentId)throw new Refusal('runtime_conflict','Register the new agent before reporting execution.');
      await inProject(r.projectId,async()=>{await assertAgentMembership(tx,r.agentId!);const a=(await tx.get(agents().doc(r.agentId!))).data();if(a?.ownerProfileId!==profileId||a.name!==r.name)throw new Refusal('forbidden','This receipt belongs to another agent.');});
    }
    const next={...r,state:receipt.state,...(receipt.code?{code:receipt.code}:{})};tx.set(ref,next);return {ok:true,request:view(next,at)};
  });
}

// Reads/cancellation use the exact queued request, agent and approved computer;
// no caller-selected identity can adopt another person's request.
const startTarget = z.object({projectId:z.string().regex(/^[a-f0-9]{64}$/),agentId:identifier}).strict();
function assertStartTarget(r:WebAgentStart|undefined,profileId:string,connectionId:string,target:z.infer<typeof startTarget>) {
  if(!r||r.profileId!==profileId||r.connectionId!==connectionId||r.projectId!==target.projectId||(r.agentId??`queued-${r.id}`)!==target.agentId)throw missing();
  return r;
}
export async function inspectAgentStart(profileId:string,connectionId:string,id:string,input:unknown,now:()=>number) {
  parse(uuid,id);const target=parse(startTarget,input);
  const r=assertStartTarget((await webAgentStarts.doc(webStartKey(profileId,id)).get()).data(),profileId,connectionId,target);
  await inProject(r.projectId,()=>db.runTransaction(async tx=>{await connection(tx,profileId,connectionId,now());await assertMembership(tx,profileId);}));
  return readWebAgentStart(profileId,id,now);
}
export async function cancelAgentStart(profileId:string,connectionId:string,id:string,input:unknown,now:()=>number) {
  parse(uuid,id);
  const value=parse(z.object({operationId:uuid,target:startTarget}).strict(),input);
  const fingerprint=hashToken(JSON.stringify([connectionId,id,value.target.projectId,value.target.agentId]));
  return db.runTransaction(async tx=>{
    const ref=webAgentStarts.doc(webStartKey(profileId,id));
    const receiptRef=collection<{fingerprint:string;requestId:string;cancelledAt:number;profileId:string;connectionId:string;target:z.infer<typeof startTarget>}>('agentStartCancellations').doc(webStartKey(profileId,value.operationId));
    const [doc,receipt]=await Promise.all([tx.get(ref),tx.get(receiptRef)]);
    const r=assertStartTarget(doc.data(),profileId,connectionId,value.target),at=now();
    await connection(tx,profileId,connectionId,at);
    await inProject(r.projectId,()=>assertMembership(tx,profileId));
    if(receipt.exists){
      if(receipt.data()!.fingerprint!==fingerprint)throw new Refusal('duplicate','Retry the original stop request.');
      return {cancelled:true,replayed:true,request:view(r,at)};
    }
    // Transactional serialization with acceptance: Stop either cancels before pickup,
    // or explicitly refuses. It never reports cancellation after a launch grant exists.
    if(r.state!=='pending')throw new Refusal('runtime_conflict','This request is no longer waiting. Read its current run before stopping it.');
    const next={...r,state:'failed' as const,code:'cancelled',waitingOn:null,repository:null};
    tx.update(ref,{state:next.state,code:next.code,waitingOn:null,repository:null});
    tx.create(receiptRef,{fingerprint,requestId:id,cancelledAt:at,profileId,connectionId,target:value.target});
    return {cancelled:true,replayed:false,request:view(next,at)};
  });
}

export async function readAgentStartCancellation(profileId:string,connectionId:string,operationId:string,input:unknown,now:()=>number) {
  parse(uuid,operationId);const target=parse(startTarget,input);
  const receipt=(await collection<{requestId:string;connectionId:string;target:z.infer<typeof startTarget>}>('agentStartCancellations').doc(webStartKey(profileId,operationId)).get()).data();
  if(!receipt)return null;
  if(receipt.connectionId!==connectionId||receipt.target.projectId!==target.projectId||receipt.target.agentId!==target.agentId)throw missing();
  return {cancelled:true,replayed:true,...await inspectAgentStart(profileId,connectionId,receipt.requestId,target,now)};
}
