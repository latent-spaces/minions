import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRuntimeTools} from '../src/service/runtime-tools.mjs';
const principal={site:'https://example.test',ownerId:'synthetic-owner'},target={projectId:'a'.repeat(64),agentId:'synthetic-agent'};
const missing=()=>{throw Object.assign(new Error('Mission not found'),{code:'not_found'});};
function fixture(){
 const calls=[],request={id:randomUUID(),state:'pending',acceptedAt:null,repository:{code:'git_authentication_failed',checkedAt:123}};
 const controllers={reserveCloudOperation:async()=>{},getMission:async()=>missing(),accept:async()=>{assert.fail('A queued stop must never submit a native command');},health:async()=>({ready:true})};
 const ownerClient={inspectAgentStart:async(...args)=>{calls.push(['read',...args]);return {request};},cancelAgentStart:async(...args)=>{calls.push(['cancel',...args]);return {cancelled:true,request:{...request,state:'failed',code:'cancelled'}};}};
 return {request,calls,controllers,ownerClient,tools:createRuntimeTools({principal,controllers,ownerClient})};
}
test('a queued request is inspectable and stoppable without a mission or generation',async()=>{
 const f=fixture(),query={missionId:f.request.id,target};
 for(const name of ['get_agent_run','get_agent_run_diagnostics']){
  const result=await f.tools.callTool(name,query);assert.equal(result.kind,'queued_start');assert.equal(result.modelStarted,false);assert.equal(result.request.repository.code,'git_authentication_failed');
 }
 const operationId=randomUUID();assert.equal((await f.tools.callTool('control_agent',{...query,operationId,kind:'stop',payload:{}})).cancelled,true);
 assert.deepEqual(f.calls.at(-1),['cancel',f.request.id,{operationId,target},{expectedProfileId:principal.ownerId}]);
});
test('uncertain storage never falls back to cancelling a cloud request',async()=>{
 const f=fixture();f.controllers.getMission=async()=>{throw Object.assign(new Error('storage'),{code:'storage_failure'});};
 await assert.rejects(f.tools.callTool('control_agent',{target,missionId:f.request.id,operationId:randomUUID(),kind:'stop',payload:{}}),{code:'storage_failure'});assert.deepEqual(f.calls,[]);
});
test('a pickup race is refused and never presented as cancelled',async()=>{
 const f=fixture();f.ownerClient.cancelAgentStart=async()=>{throw Object.assign(new Error('Already accepted; reread'),{code:'runtime_conflict'});};
 await assert.rejects(f.tools.callTool('control_agent',{target,missionId:f.request.id,operationId:randomUUID(),kind:'stop',payload:{}}),{code:'runtime_conflict'});
});
test('an accepted cloud request with no local evidence does not claim the model never ran',async()=>{
 const f=fixture();f.request.state='working';f.request.acceptedAt=123;
 assert.equal((await f.tools.callTool('get_agent_run_diagnostics',{target,missionId:f.request.id})).modelStarted,null);
});
test('computer status distinguishes cloud freshness from the legacy descriptor field',async()=>{
 const f=fixture(),cloud={state:'connected',lastSuccessAt:123,lastAttemptAt:123};
 const tools=createRuntimeTools({...f,principal,connectionStatus:()=>cloud});
 const status=await tools.callTool('get_computer_status',{});assert.equal(status.localReady,true);assert.deepEqual(status.cloudConnection,cloud);assert.match(status.cloudReadyMeaning,/not a connectivity check/);
});

test('queued Stop and local commands share a durable operation-ID fence in both directions and after restart',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {openRuntimeStore}=await import('../src/service/store.mjs');
 const directory=await mkdtemp(join(tmpdir(),'minions-queued-stop-fence-'));
 let store=await openRuntimeStore({directory});t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
 const bound={...principal,...target};let effects=0;
 const start=operationId=>({version:2,kind:'start',operationId,target:bound,missionId:randomUUID(),payload:{scope:'Synthetic store-only check',deadlineAt:Date.now()+60000,execution:{provider:'codex',model:null}}});
 const controllers={getMission:input=>store.getMission(input),reserveCloudOperation:input=>store.reserveCloudOperation(input)};
 const tools=createRuntimeTools({principal,controllers,ownerClient:{cancelAgentStart:async()=>{effects++;return {cancelled:true};}}});
 const stop=operationId=>({kind:'stop',operationId,missionId:randomUUID(),target,payload:{}});
 const first=await store.accept(start(randomUUID()));
 await assert.rejects(tools.callTool('control_agent',stop(first.receipt.operationId)),{code:'conflict'});assert.equal(effects,0);
 const cancelled=stop(randomUUID());await tools.callTool('control_agent',cancelled);assert.equal(effects,1);
 await assert.rejects(store.accept(start(cancelled.operationId)),{code:'conflict'});
 await store.close();store=await openRuntimeStore({directory});
 await assert.rejects(store.accept(start(cancelled.operationId)),{code:'conflict'});
 await assert.rejects(tools.callTool('control_agent',{...cancelled,missionId:randomUUID()}),{code:'conflict'});assert.equal(effects,1);
 await tools.callTool('control_agent',cancelled);assert.equal(effects,2,'an identical retry may retry only its original cancellation');
});

test('queued Stop never contacts the cloud without a durable reservation capability',async()=>{
 const f=fixture();delete f.controllers.reserveCloudOperation;
 await assert.rejects(f.tools.callTool('control_agent',{target,missionId:f.request.id,operationId:randomUUID(),kind:'stop',payload:{}}),{code:'unavailable'});assert.deepEqual(f.calls,[]);
});
