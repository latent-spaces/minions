import express from 'express';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {beforeAll,afterAll,beforeEach,expect,test} from 'vitest';
import {hashToken,newToken} from '../src/auth.js';
import {agents,collection,db,inProject} from '../src/firestore.js';
import {ownerRoutes} from '../src/owner/routes.js';
import {connectOwnAgent} from '../src/owner/agents.js';
import {createWebAgentStart,publishRuntimeReadiness,readAgentStarts,queuedStarts,readWebAgentStart,acceptAgentStart,receiptAgentStart} from '../src/owner/web-agent-starts.js';
import {membershipDoc} from '../src/projects/access.js';
import {platformSettings} from '../src/platform/settings.js';
import {idTokenFor,resetEmulator,seed,TEST_PROJECT,seedRuntime} from './helpers.js';
let server:Server,base:string,at:number;
const now=()=>at;
beforeAll(async()=>{const app=express();app.use('/api/owner',ownerRoutes(now));server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/owner`;});
afterAll(async()=>new Promise<void>(r=>server.close(()=>r())));
beforeEach(async()=>{await resetEmulator();at=2_000_000_000_000;});
async function http(path:string,token?:string,body?:object,profileId?:string){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(profileId?{'X-Mlswarm-Profile-Id':profileId}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
async function fixture(){
  const f=await seed({profiles:[{name:'Owner',email:'owner@example.test'},{name:'Other',email:'other@example.test'}]});
  // The job has ten minutes left.
  await seedRuntime(TEST_PROJECT,{endsAt:at+600_000});
  const owner=f.personIds[0],other=f.personIds[1],incarnation=randomUUID();
  const readiness={protocol:1,version:'0.1.0',incarnation,platform:'darwin',providers:[{id:'codex',available:true,reason:'ready'},{id:'claude',available:false,reason:'unavailable'}]};
  const publish=(v:object=readiness)=>publishRuntimeReadiness(owner,v,now);await publish();
  const input={id:randomUUID(),projectId:TEST_PROJECT,name:'Research',scope:'Review the documented problem',execution:{provider:'codex',model:null},approved:true};
  const create=(v:object=input)=>createWebAgentStart(owner,v,now);
  const accept=()=>acceptAgentStart(owner,input.id,{incarnation},now);
  const connect=(body:object={})=>inProject(TEST_PROJECT,()=>connectOwnAgent(owner,{name:input.name,candidateTokenHash:hashToken('test-token'),clientName:'test',folder:'/tmp/test-agent',webStartId:input.id,...body},now));
  return {owner,other,incarnation,readiness,publish,input,create,accept,connect};
}
test('an older connector still reports readiness with its update report, which is neither stored nor answered',async()=>{
  const f=await fixture();
  const updates={protocol:1,state:'current',latestVersion:'0.1.0-beta.73',checkedAt:at,registryStatus:'checked',targetVersion:null,message:null};
  expect(await f.publish({...f.readiness,updates})).toEqual({ok:true,serverTime:at});
  const saved=(await collection('ownerRuntimeReadiness').doc(f.owner).get()).data()!;
  expect(saved).not.toHaveProperty('updates');expect(saved.version).toBe('0.1.0');
});
test('Windows readiness permits a verified provider and refuses an unavailable guard',async()=>{
  const f=await fixture();
  await f.publish({...f.readiness,platform:'win32',providers:[{id:'codex',available:false,reason:'unavailable'}]});
  await expect(f.create()).rejects.toMatchObject({code:'runtime_conflict'});
  await f.publish({...f.readiness,platform:'win32'});
  expect((await f.create()).request.state).toBe('pending');
  expect((await f.accept()).request.state).toBe('accepted');
});
test('an online computer must offer the provider; an offline one queues the start',async()=>{
  const f=await fixture();
  await expect(f.create({...f.input,execution:{provider:'claude',model:'sonnet'}})).rejects.toMatchObject({code:'runtime_conflict'});
  await f.publish({...f.readiness,platform:'unsupported_os'});await expect(f.create()).rejects.toMatchObject({code:'runtime_conflict'});
  at+=45_000;
  expect((await f.create()).request).toMatchObject({state:'pending',incarnation:null});
  expect((await readWebAgentStart(f.owner,f.input.id,now)).request.waitingFor).toBe('computer');
  // My agents shows the queued new agent to its owner only.
  const queued=(profileId:string)=>inProject(TEST_PROJECT,()=>db.runTransaction(tx=>queuedStarts(tx,profileId,TEST_PROJECT,at)));
  expect(await queued(f.owner)).toEqual([{id:f.input.id,name:f.input.name,waitingFor:'computer'}]);
  expect(await queued(f.other)).toEqual([]);
});
test('project start releases only the existing approved request and preserves its identity and work window',async()=>{
  const f=await fixture();await seedRuntime(TEST_PROJECT,{started:false,paused:true,awaitingKickoff:true});
  await f.create();
  expect((await readWebAgentStart(f.owner,f.input.id,now)).request.waitingFor).toBe('project');
  expect((await f.accept()).request.state).toBe('pending');
  expect((await inProject(TEST_PROJECT,()=>agents().get())).size).toBe(0);
  await seedRuntime(TEST_PROJECT,{started:true,paused:false,awaitingKickoff:false});
  const accepted=await f.accept();
  expect(accepted.request).toMatchObject({id:f.input.id,state:'accepted',deadlineAt:at+10*60_000});
  expect((await f.accept()).request).toEqual(accepted.request);
  expect((await inProject(TEST_PROJECT,()=>agents().get())).size).toBe(0);
});
test('a start waits for the job to have time, then works until the job end time',async()=>{
  const f=await fixture();await f.create();
  const queued=()=>inProject(TEST_PROJECT,()=>db.runTransaction(tx=>queuedStarts(tx,f.owner,TEST_PROJECT,at)));
  for(const endsAt of [undefined,at]){
    await seedRuntime(TEST_PROJECT,{endsAt});
    expect((await readWebAgentStart(f.owner,f.input.id,now)).request).toMatchObject({state:'pending',waitingFor:'time'});
    expect(await queued()).toEqual([{id:f.input.id,name:f.input.name,waitingFor:'time'}]);
    expect((await f.accept()).request).toMatchObject({state:'pending',deadlineAt:null});
  }
  // A project that isn't running is still what the start waits for first.
  await seedRuntime(TEST_PROJECT,{paused:true});
  expect((await readWebAgentStart(f.owner,f.input.id,now)).request.waitingFor).toBe('project');
  await seedRuntime(TEST_PROJECT,{paused:false,endsAt:at+45*60_000});
  expect((await readWebAgentStart(f.owner,f.input.id,now)).request.waitingFor).toBeNull();
  const accepted=await f.accept();
  expect(accepted.request).toMatchObject({state:'accepted',deadlineAt:at+45*60_000});
  expect(accepted.request).not.toHaveProperty('minutes');
  await expect(f.create({...f.input,id:randomUUID(),name:'Timed',minutes:10})).rejects.toMatchObject({code:'bad_input'});
});
test('a start accepted just before the job end time stays listed for its launch window, and a working one is not listed',async()=>{
  const f=await fixture();await seedRuntime(TEST_PROJECT,{endsAt:at+30_000});await f.create();
  expect((await f.accept()).request).toMatchObject({state:'accepted',deadlineAt:at+30_000,launchByAt:at+180_000});
  // Past the end time, inside the launch window: the computer still sees it and starts it waiting for more time.
  at+=60_000;await f.publish();
  expect((await readAgentStarts(f.owner,{},now)).requests.map(r=>[r.id,r.state])).toEqual([[f.input.id,'accepted']]);
  const connected=await f.connect();
  await receiptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,state:'working',agentId:connected.agentId},now);
  expect((await readAgentStarts(f.owner,{},now)).requests).toEqual([]);
});
test('pickup expiry is not a delayed launch; boot fencing, membership and completed project rechecked on acceptance',async()=>{
  const f=await fixture();await f.create();at+=7*86400_000;await f.publish();
  expect((await f.accept()).request.state).toBe('expired');
  expect((await readWebAgentStart(f.owner,f.input.id,now)).request.state).toBe('expired');
  expect((await readAgentStarts(f.owner,{},now)).requests).toEqual([]);
  const g=await fixture();await g.create();await g.publish({...g.readiness,incarnation:randomUUID()});await expect(g.accept()).rejects.toMatchObject({code:'runtime_conflict'});
  await g.publish();await membershipDoc(TEST_PROJECT,g.owner).update({status:'left'});await expect(g.accept()).rejects.toMatchObject({code:'unauthorized'});
  await membershipDoc(TEST_PROJECT,g.owner).update({status:'active'});await seedRuntime(TEST_PROJECT,{completedAt:at,paused:true});await expect(g.accept()).rejects.toMatchObject({code:'forbidden'});
});
test('accepted deadline is immutable; registration is new-only, exact token replay and owned receipt are fenced',async()=>{
  const f=await fixture();await f.create();const accepted=await f.accept();
  expect(accepted.request).toMatchObject({acceptedAt:at,deadlineAt:at+600_000,launchByAt:at+180_000});
  at+=1000;expect((await f.accept()).request).toEqual(accepted.request);
  await expect(receiptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,state:'working'},now)).rejects.toMatchObject({code:'runtime_conflict'});
  const connected=await f.connect();expect(connected.created).toBe(true);expect(connected.settings).toEqual({involvement:'on_own'});
  expect((await inProject(TEST_PROJECT,()=>agents().doc(connected.agentId).get())).data()?.workSettings).toEqual({involvement:'on_own'});expect((await f.connect()).replayed).toBe(true);
  await membershipDoc(TEST_PROJECT,f.owner).update({status:'left'});await expect(f.accept()).rejects.toMatchObject({code:'unauthorized'});
  await membershipDoc(TEST_PROJECT,f.owner).update({status:'active'});
  await expect(f.connect({candidateTokenHash:hashToken('other-token')})).rejects.toMatchObject({code:'duplicate'});
  await expect(receiptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,state:'working',agentId:'not-my-agent'},now)).rejects.toMatchObject({code:'forbidden'});
  const working=await receiptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,state:'working',agentId:connected.agentId},now);
  expect(working.request.state).toBe('working');
  await expect(receiptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,state:'failed',code:'launch_failed'},now)).rejects.toMatchObject({code:'duplicate'});expect((await receiptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,state:'starting'},now)).request.state).toBe('working');
  expect((await inProject(TEST_PROJECT,()=>agents().get())).size).toBe(1);
  await expect(f.create({...f.input,id:randomUUID()})).rejects.toMatchObject({code:'duplicate'});
});
test('the website and the connector both use the owner session; the website start needs the exact selected profile',async()=>{
  const f=await fixture(),session=await idTokenFor('owner@example.test'),otherSession=await idTokenFor('other@example.test');
  for(const token of [undefined,newToken()]) expect((await http('/runtime/readiness',token,f.readiness)).status).toBe(401);
  expect((await http('/runtime/readiness',session,f.readiness)).status).toBe(200);
  const input={...f.input};
  expect((await http('/web-agent-starts',session,input)).status).toBe(401);
  expect((await http('/web-agent-starts',session,input,f.other)).status).toBe(401);
  expect((await http('/web-agent-starts',session,{...input,connectionId:randomUUID()},f.owner)).status).toBe(400);
  expect((await http('/web-agent-starts',session,input,f.owner)).status).toBe(200);
  expect((await http(`/web-agent-starts/${input.id}`,otherSession)).status).toBe(404);
  expect((await http('/agent-starts',session)).body.requests).toHaveLength(1);
  expect((await http('/agent-starts',otherSession)).body.requests).toEqual([]);
  const query=new URLSearchParams({projectId:TEST_PROJECT,agentId:`queued-${input.id}`});
  expect((await http(`/agent-starts/${input.id}?${query}`,otherSession)).status).toBe(404);
  expect((await http(`/agent-starts/${input.id}?${query}`,session)).body.request.state).toBe('pending');
  const cancellationId=randomUUID();
  expect((await http(`/agent-start-controls/${cancellationId}?${query}`,session)).body).toEqual({cancellation:null});
  expect((await http(`/agent-starts/${input.id}/cancel`,session,{operationId:cancellationId,target:{projectId:TEST_PROJECT,agentId:`queued-${input.id}`}})).body.cancelled).toBe(true);
  expect((await http(`/agent-start-controls/${cancellationId}?${query}`,session)).body.cancellation.cancelled).toBe(true);
  expect((await http('/runtime',session)).body.runtime).toMatchObject({online:true,incarnation:f.incarnation});
  expect((await http('/runtime',otherSession)).body).toEqual({runtime:null});
});
test('the agents-per-person limit is a platform setting, refused before pickup, and lowering it revokes nothing',async()=>{
  const f=await fixture();await platformSettings.set({revision:1,maxContributors:null,maxAgentsPerParticipant:2,reviewerEmails:[],updatedAt:1,updatedBy:null});
  for(const name of ['One','Two'])await inProject(TEST_PROJECT,()=>agents().doc(name).set({ownerProfileId:f.owner,name,connectionEpoch:0,tokenHash:'',tokenIssuedAt:null,createdAt:at,revokedAt:null}));
  await expect(f.create()).rejects.toMatchObject({code:'limit_reached',limit:{scope:'agents_per_participant',limit:2,used:2}});
  await expect(f.connect({webStartId:undefined})).rejects.toMatchObject({code:'limit_reached'});
  await platformSettings.update({maxAgentsPerParticipant:1});
  expect((await inProject(TEST_PROJECT,()=>agents().where('ownerProfileId','==',f.owner).where('revokedAt','==',null).get())).docs.map(d=>d.data().name).sort()).toEqual(['One','Two']);
  expect((await f.create({...f.input,name:'Two',agentId:'Two'})).request.state).toBe('pending');
  await platformSettings.update({maxAgentsPerParticipant:3});
  expect((await f.create({...f.input,id:randomUUID()})).request.state).toBe('pending');
});

test('queued starts expose safe repository evidence and clear it when accepted',async()=>{
  const f=await fixture();await f.create();await f.connect();
  const repository={waitingFor:'github',code:'git_authentication_failed',checkedAt:at};
  const waiting=await acceptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,waitingFor:'github',repository},now);
  expect(waiting.request).toMatchObject({state:'pending',repository});
  expect((await readWebAgentStart(f.owner,f.input.id,now)).request).toMatchObject({waitingFor:'github',repository});
  await expect(acceptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,waitingFor:'github',repository:{...repository,code:'empty_repository'}},now)).rejects.toMatchObject({code:'bad_input'});
  await expect(acceptAgentStart(f.owner,f.input.id,{incarnation:f.incarnation,waitingFor:'github',repository:{...repository,checkedAt:at-181_000}},now)).rejects.toMatchObject({code:'bad_input'});
  expect((await f.accept()).request).toMatchObject({state:'accepted',repository:null,waitingOn:null});
});

test('queued stop is durable, target-bound, and remains stopped after readiness recovers or the computer restarts',async()=>{
  const {cancelAgentStart,inspectAgentStart,readAgentStartCancellation}=await import('../src/owner/web-agent-starts.js');
  const f=await fixture();await f.create();const agentId=(await f.connect()).agentId;
  const target={projectId:TEST_PROJECT,agentId},input={operationId:randomUUID(),target};
  expect((await inspectAgentStart(f.owner,f.input.id,target,now)).request.state).toBe('pending');
  expect(await cancelAgentStart(f.owner,f.input.id,input,now)).toMatchObject({cancelled:true,replayed:false,request:{state:'failed',code:'cancelled'}});
  expect(await cancelAgentStart(f.owner,f.input.id,input,now)).toMatchObject({cancelled:true,replayed:true});
  expect(await readAgentStartCancellation(f.owner,input.operationId,target,now)).toMatchObject({cancelled:true});
  await f.publish({...f.readiness,incarnation:randomUUID()});
  expect((await readAgentStarts(f.owner,{},now)).requests).toEqual([]);
  expect((await f.accept()).request).toMatchObject({state:'failed',code:'cancelled',acceptedAt:null});
  for(const [owner,t] of [[f.other,target],[f.owner,{...target,agentId:'someone-else'}]] as const){
    await expect(inspectAgentStart(owner,f.input.id,t,now)).rejects.toMatchObject({code:'not_found'});
    await expect(cancelAgentStart(owner,f.input.id,{...input,target:t},now)).rejects.toMatchObject({code:'not_found'});
  }
});

test('queued Stop and pickup serialize: exactly one wins and a launch grant is never called cancelled',async()=>{
  const {cancelAgentStart}=await import('../src/owner/web-agent-starts.js');
  for(let attempt=0;attempt<4;attempt++){
    await resetEmulator();
    const f=await fixture();await f.create();const agentId=(await f.connect()).agentId;
    const [stop,pickup]=await Promise.allSettled([
      cancelAgentStart(f.owner,f.input.id,{operationId:randomUUID(),target:{projectId:TEST_PROJECT,agentId}},now),
      f.accept(),
    ]);
    const saved=(await readWebAgentStart(f.owner,f.input.id,now)).request;
    if(stop.status==='fulfilled'){
      expect(saved).toMatchObject({state:'failed',code:'cancelled',acceptedAt:null});
      expect(pickup.status==='fulfilled' && pickup.value.request.state).toBe('failed');
    }else{
      expect(stop.reason).toMatchObject({code:'runtime_conflict'});expect(saved.state).toBe('accepted');
    }
  }
},100_000); // Four bounded reset rounds (4 × 20 s), plus fixture and race checks.

test('an offline request can be stopped before any agent is registered',async()=>{
  const {cancelAgentStart,inspectAgentStart}=await import('../src/owner/web-agent-starts.js');
  const f=await fixture();at+=45_000;await f.create();
  const target={projectId:TEST_PROJECT,agentId:`queued-${f.input.id}`};
  expect((await inspectAgentStart(f.owner,f.input.id,target,now)).request.agentId).toBeNull();
  expect(await cancelAgentStart(f.owner,f.input.id,{operationId:randomUUID(),target},now)).toMatchObject({cancelled:true,request:{agentId:null,state:'failed',code:'cancelled'}});
  await f.publish();expect((await readAgentStarts(f.owner,{},now)).requests).toEqual([]);
});
