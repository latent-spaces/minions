import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openRuntimeStore} from '../src/service/store.mjs';
import {createSteering} from '../src/service/steering.mjs';
const target={site:'https://synthetic.invalid',ownerId:'owner',projectId:'project',agentId:'agent'};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'mlswarm-shared-steering-'));const store=await openRuntimeStore({directory});t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});const start={version:2,operationId:randomUUID(),kind:'start',target,missionId:randomUUID(),payload:{scope:'Synthetic; never launch a model.',deadlineAt:Date.now()+300000,execution:{provider:'codex',model:null}}};const {mission}=await store.accept(start);const ref={missionId:mission.missionId,generation:mission.generation};await store.prepareCloudRun({...ref,startedAt:mission.createdAt});await store.bindCloudRun({...ref,runId:mission.missionId,cloudGeneration:1});return {store,start,ref,command:{version:2,operationId:randomUUID(),kind:'steer',target,...ref,payload:{message:'Shared guidance'}}};}
test('one shared operation records before intake and refuses operation collisions',async t=>{const {store,start,command,ref}=await fixture(t);let attempts=0;const service=createSteering({store,principal:target,accountClient:{async submitSteering(project,input){attempts++;return {message:{...input,actorProfileId:target.ownerId,createdAt:1,state:'queued'}};}}});await assert.rejects(service.submit({...command,operationId:start.operationId},'coding_chat'),e=>e.code==='conflict');assert.equal(attempts,0);await assert.rejects(service.submit(command,'local_app'),e=>e.code==='forbidden');assert.equal(attempts,0);await service.submit(command,'coding_chat');assert.equal((await store.getMission({...ref,target})).steering.length,0);await assert.rejects(store.accept(command),e=>e.code==='forbidden');await store.acceptSteering(command);const mission=await store.getMission({...ref,target});assert.equal(mission.steering.length,1);const turnId=randomUUID();await store.prepareTurn({...ref,turnId});await store.settleMission({...ref,reason:'operator',cleanupConfirmed:true});const reports=(await store.listReports({missionId:ref.missionId,limit:100})).reports;const ended=reports.find(r=>r.kind==='steering_receipt'&&r.payload.state==='ended');assert.equal(ended.payload.turnId,null);assert.ok(reports.some(r=>r.kind==='stop_run'));});
test('cloud failure never queues steering locally; retry preserves immutable intent',async t=>{const {store,command,ref}=await fixture(t);const service=createSteering({store,principal:target,accountClient:{async submitSteering(){throw Error('offline');}}});await assert.rejects(service.submit(command,'coding_chat'),/offline/);assert.equal((await store.getMission({...ref,target})).steering.length,0);await assert.rejects(service.submit({...command,payload:{message:'Changed'}},'coding_chat'),e=>e.code==='conflict');});
test('steering intake reserves bounded receipt capacity before adding a queue entry',async t=>{
 const {store,command,ref}=await fixture(t);let accepted=0;
 for(let n=0;n<64;n++){try{await store.acceptSteering({...command,operationId:randomUUID()});accepted++;}catch(e){assert.equal(e.code,'report_capacity');break;}}
 assert.ok(accepted>0&&accepted<64);await store.settleMission({...ref,reason:'operator',cleanupConfirmed:true});
 const reports=(await store.listReports({missionId:ref.missionId,limit:100})).reports;assert.ok(reports.some(r=>r.kind==='stop_run'));assert.ok(reports.length<=128);
});
test('restart reloads unpublished steering reservations before an early Stop effect',async t=>{
 const {commandFingerprint}=await import('../src/service/contracts.mjs');const directory=await mkdtemp(join(tmpdir(),'mlswarm-intent-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let store=await openRuntimeStore({directory});const steer={version:2,operationId:randomUUID(),kind:'steer',target,missionId:randomUUID(),generation:1,payload:{message:'Unconfirmed cloud publication'}};
 await store.reserveSteering(steer);await store.close();store=await openRuntimeStore({directory});try{const stop={...steer,kind:'stop',payload:{}};assert.throws(()=>store.reserveOperation({operationId:stop.operationId,fingerprint:commandFingerprint(stop)}),e=>e.code==='conflict');}finally{await store.close();}
});
test('a group reserves each recipient, records once before intake, and keeps its thread through store restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mlswarm-group-steering-'));let store=await openRuntimeStore({directory});t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
 const recipients=[];
 for(const agentId of ['first','second']){
  const ownTarget={...target,agentId};const {mission}=await store.accept({version:2,operationId:randomUUID(),kind:'start',target:ownTarget,missionId:randomUUID(),payload:{scope:'Synthetic only',deadlineAt:Date.now()+300000,execution:{provider:'codex',model:null}}});
  const ref={missionId:mission.missionId,generation:mission.generation};await store.prepareCloudRun({...ref,startedAt:mission.createdAt});await store.bindCloudRun({...ref,runId:mission.missionId,cloudGeneration:1});recipients.push({agentId,...ref});
 }
 let sent;const requests=[];
 const accountClient={async submitSteering(projectId,input){requests.push(input);sent={...input,id:`steer_${target.ownerId}_${input.operationId}`,threadId:`steer_${target.ownerId}_${input.operationId}`,actorProfileId:target.ownerId,deliveries:input.recipients,createdAt:1};return {created:true,message:sent};}};
 const service=createSteering({store,principal:{site:target.site,ownerId:target.ownerId},accountClient});const input={operationId:randomUUID(),projectId:target.projectId,recipients,message:'One instruction'};
 await service.submitMany(input);await service.submitMany(input);assert.deepEqual(requests[0],requests[1]);
 assert.equal(new Set(sent.deliveries.map(d=>d.operationId)).size,2);
 for(const d of sent.deliveries){
  const ownTarget={...target,agentId:d.agentId};assert.equal((await store.getMission({...d,target:ownTarget})).steering.length,0);
  await store.acceptSteering({version:2,kind:'steer',operationId:d.operationId,target:ownTarget,missionId:d.missionId,generation:d.generation,payload:{message:input.message,threadId:sent.id}});
 }
 await store.close();store=await openRuntimeStore({directory});
 for(const d of sent.deliveries)assert.equal((await store.getMission({...d,target:{...target,agentId:d.agentId}})).steering[0].threadId,sent.id);
 await assert.rejects(service.submitMany({...input,recipients:[recipients[0],recipients[0]]}),e=>e.code==='bad_input');
});
test('group tool binds the person implicitly and validates the entire request before calling steering',async()=>{
 const {createRuntimeTools}=await import('../src/service/runtime-tools.mjs');let seen;
 const runtime=createRuntimeTools({controllers:{},principal:{site:target.site,ownerId:target.ownerId},steering:{async submitMany(input){seen=input;return {ok:true};}}});
 const input={operationId:randomUUID(),projectId:'project',recipients:[{agentId:'agent',missionId:randomUUID(),generation:1}],message:'Guidance'};
 assert.ok(runtime.listTools().some(t=>t.name==='steer_agents'));
 assert.deepEqual(await runtime.callTool('steer_agents',input),{ok:true});assert.deepEqual(seen,input);
 await assert.rejects(runtime.callTool('steer_agents',{...input,ownerId:'someone-else'}),e=>e.code==='bad_input');
 await assert.rejects(runtime.callTool('steer_agents',{...input,recipients:[]}),e=>e.code==='bad_input');
});
test('an unconfirmed group freezes all recipients across restart before any cloud delivery',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mlswarm-group-intent-'));let store=await openRuntimeStore({directory});t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
 const input={operationId:randomUUID(),projectId:'project',message:'Shared guidance',recipients:['one','two'].map(agentId=>({agentId,missionId:randomUUID(),generation:1}))};let calls=0;
 const accountClient={async submitSteering(){calls++;throw Error('Offline');}};
 const make=()=>createSteering({store,principal:{site:target.site,ownerId:target.ownerId},accountClient});
 await assert.rejects(make().submitMany(input),/Offline/);await store.close();store=await openRuntimeStore({directory});
 await assert.rejects(make().submitMany({...input,recipients:[...input.recipients,{agentId:'three',missionId:randomUUID(),generation:1}]}),e=>e.code==='conflict');
 await assert.rejects(make().submitMany({...input,recipients:[input.recipients[0]]}),e=>e.code==='conflict');
 assert.equal(calls,1);await assert.rejects(make().submitMany(input),/Offline/);assert.equal(calls,2);
});

test('a pause update turn leaves queued steering for the next working turn',async t=>{const {store,command,ref}=await fixture(t);await store.acceptSteering(command);await store.prepareTurn({...ref,turnId:randomUUID(),steering:false});assert.deepEqual((await store.getMission({...ref,target})).steering.map(s=>s.state),['queued']);});
