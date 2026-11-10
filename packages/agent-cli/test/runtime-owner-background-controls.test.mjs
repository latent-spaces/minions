import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openRuntimeStore} from '../src/service/store.mjs';
import {createRuntimeControllers} from '../src/service/controllers.mjs';
import {createOwnerParticipationControls} from '../src/service/owner-participation-controls.mjs';
import {createNativeAdapterFactory} from '../src/service/native-bindings.mjs';
import {makeMixedNativeFixtures,nativeEvents} from './fixtures/mixed-native-fixtures.mjs';
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function until(read,predicate,label){const deadline=Date.now()+12000;let value;while(Date.now()<deadline){value=await read();if(predicate(value))return value;await sleep(15);}assert.fail(`${label}: ${JSON.stringify(value)}`);}
const command=(mission,kind,payload={})=>({version:2,operationId:randomUUID(),kind,target:mission.target,missionId:mission.missionId,generation:mission.generation,payload});
const envelope=command=>({id:command.operationId,command,deadlineAt:Date.now()+60000});
function mailbox(targets){
  const principal={site:targets[0].site,ownerId:targets[0].ownerId},inbox=[],acks=[],snapshots=[],saved=new Map();let loseApplied=false;
  const client={
    async syncParticipations(){return {ok:true};},async listParticipationControls(){return {commands:[],serverTime:Date.now()};},
    async acceptParticipationControl(){assert.fail('No chat Wake');},async acknowledgeParticipationControl(){assert.fail('No chat control');},
    async syncBackgrounds(body,options){assert.equal(options.expectedProfileId,principal.ownerId);snapshots.push(structuredClone(body));return {ok:true};},
    async listBackgroundControls(options){assert.equal(options.expectedProfileId,principal.ownerId);return {commands:inbox.filter(item=>!['applied','failed','expired'].includes(saved.get(item.id)?.state)),serverTime:Date.now()};},
    async acknowledgeBackgroundControl(id,receipt,options){
      assert.equal(options.expectedProfileId,principal.ownerId);acks.push({id,...structuredClone(receipt)});
      if(receipt.state==='applied'&&loseApplied){loseApplied=false;throw new Error('Synthetic lost acknowledgement before commit');}
      saved.set(id,structuredClone(receipt));return {ok:true};
    },
  };
  return {principal,inbox,acks,snapshots,saved,client,set loseApplied(value){loseApplied=value;}};
}
function pump(store,controllers,m){return createOwnerParticipationControls({store,controllers,principal:m.principal,targets:m.targets,ownerClient:m.client,
  participation:{command:()=>assert.fail('Background command is not chat participation')},intervalMs:20,timeoutMs:500});}
async function setup(t,{holdOutcome=false}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'mlswarm-website-background-'))),fixture=await makeMixedNativeFixtures(root,[['park','claude'],['garden','codex']],label=>[{gate:join(root,`${label}-one`)},{gate:join(root,`${label}-two`)}]);
  const store=await openRuntimeStore({directory:join(root,'ledger')});
  let releaseOutcome;const held=new Promise(done=>{releaseOutcome=done;});const applied=new Set(),sessions=[],projectPauses=new Map();
  const tracked={...store,async markTurnApplied(input){const result=await store.markTurnApplied(input);applied.add(input.missionId);return result;},async recordTurn(input){if(holdOutcome&&input.missionId===missions[0]?.missionId)await held;return store.recordTurn(input);}};
  const controllers=createRuntimeControllers({store:tracked,adapterFactory:await createNativeAdapterFactory(fixture),observeIntervalMs:15,
    cloudFactory:async mission=>({start:async()=>({runId:mission.missionId,cloudGeneration:7}),observe:async()=>({project:{started:true,paused:projectPauses.has(mission.target.projectId),closed:false,revision:projectPauses.has(mission.target.projectId)?3:2,...(projectPauses.has(mission.target.projectId)?{pauseRequest:projectPauses.get(mission.target.projectId)}:{})},pending:0,acknowledged:0}),
      workerSession:async(_mission,session)=>{sessions.push(structuredClone(session));return {missionId:mission.missionId,messages:[]};},phase:async()=>{},reportStatus:async()=>{}})});
  const missions=[];for(const binding of fixture.bindings)missions.push((await controllers.accept({version:2,operationId:randomUUID(),kind:'start',target:binding.target,missionId:randomUUID(),payload:{scope:'Synthetic website control only.',execution:{provider:binding.target.agentId,model:null}}})).mission);
  const m=mailbox(fixture.bindings.map(item=>item.target));m.targets=fixture.bindings.map(item=>item.target);
  const transportStore={...store,latestParticipationsForTargets:async()=>[]};const delivery=pump(transportStore,controllers,m);
  t.after(async()=>{releaseOutcome();await delivery.close();await controllers.close();await store.close();await rm(root,{recursive:true,force:true});});
  return {root,controllers,missions,m,releaseOutcome,sessions,applied,projectPauses,read:mission=>controllers.getMission({missionId:mission.missionId,target:mission.target}),
    turns:async()=>(await nativeEvents(fixture.events)).filter(event=>event.type==='turn')};
}

test('website Pause uses independent polling during fake Claude work; pausing is not applied and Codex continues',{timeout:40000},async t=>{
  const f=await setup(t,{holdOutcome:true});await until(f.turns,rows=>rows.length===2,'both native providers');await until(()=>f.applied.size,n=>n===2,'durable turn acknowledgement');
  const first=f.missions[0],pause=command(first,'pause');f.m.inbox.push(envelope(pause));
  await until(()=>f.m.saved.get(pause.operationId),value=>value?.state==='accepted','durable Pause accepted without native completion');
  const pausing=await f.read(first);assert.equal(pausing.state,'pausing');assert.equal(pausing.deadlineAt,first.deadlineAt);
  await sleep(75);assert.ok(!f.m.acks.some(ack=>ack.id===pause.operationId&&ack.state==='applied'));
  const ownSessions=f.sessions.filter(session=>session.missionId===first.missionId);assert.ok(ownSessions.some(session=>session.phase==='working'));
  assert.ok(!ownSessions.some(session=>session.phase==='paused'),'no false cloud Paused while outcome unsettled');
  assert.equal((await f.read(f.missions[1])).state,'running','other project remains active');
  f.m.loseApplied=true;await writeFile(join(f.root,`${first.target.projectId}-${first.target.agentId}-one`),'go');f.releaseOutcome();await until(()=>f.m.saved.get(pause.operationId),value=>value?.state==='applied','confirmed Pause with lost ACK retry');
  const paused=await f.read(first);assert.equal(paused.state,'paused');assert.equal(paused.outcomes.length,1);assert.equal(paused.outcomes[0].outcome.cleanupConfirmed,true);
  const resumed=command(first,'resume',{pauseOperationId:pause.operationId});f.m.inbox.push(envelope(resumed));
  await until(()=>f.m.saved.get(resumed.operationId),value=>value?.state==='applied','exact Resume');
  // The paused turn finished on its own, so Resume alone starts no turn; the agent is back on its normal schedule.
  await until(()=>f.read(first),m=>m.state!=='paused','resumed');await sleep(150);assert.equal((await f.turns()).length,2,'Resume does not invent a turn');
  assert.equal((await f.read(first)).deadlineAt,first.deadlineAt);
  const snapshot=f.m.snapshots.at(-1).backgrounds.find(row=>row.missionId===first.missionId);
  assert.equal(snapshot.generation,first.generation);assert.equal(snapshot.cloudRun.generation,7);
  assert.deepEqual(Object.keys(snapshot),['target','missionId','generation','state','pauseOperationId','cloudRun','updatedAt']);
  assert.ok(!JSON.stringify(f.m.snapshots).includes(f.root),'no native folder leak');
  assert.ok(f.m.acks.findIndex(ack=>ack.id===resumed.operationId&&ack.state==='accepted')<f.m.acks.findIndex(ack=>ack.id===resumed.operationId&&ack.state==='applied'));
});

test('stale Resume, foreign target, deadline expiry and Stop refuse without extra native execution',{timeout:35000},async t=>{
  const f=await setup(t);await until(()=>f.applied.size,n=>n===2,'both turns acknowledged');
  const mission=f.missions[1],pause=command(mission,'pause');f.m.inbox.push(envelope(pause));await writeFile(join(f.root,`${mission.target.projectId}-${mission.target.agentId}-one`),'go');await until(()=>f.m.saved.get(pause.operationId),r=>r?.state==='applied','remote Pause');
  const newer=command(mission,'pause');await f.controllers.accept(newer);
  const stale=command(mission,'resume',{pauseOperationId:pause.operationId}),foreign={...command(mission,'pause'),target:{...mission.target,ownerId:'foreign'}},expired=command(f.missions[0],'pause');
  f.m.inbox.push(envelope(stale),envelope(foreign),{...envelope(expired),deadlineAt:Date.now()-1});
  for(const [id,state]of [[stale.operationId,'failed'],[foreign.operationId,'failed'],[expired.operationId,'expired']])await until(()=>f.m.saved.get(id),r=>r?.state===state,state);
  assert.equal((await f.read(mission)).pauseOperationId,newer.operationId);assert.equal((await f.read(f.missions[0])).state,'running');
  await f.controllers.accept(command(mission,'stop'));
  const resumed=command(mission,'resume',{pauseOperationId:newer.operationId});f.m.inbox.push(envelope(resumed));await until(()=>f.m.saved.get(resumed.operationId),r=>r?.state==='failed','Stop dominates Resume');
  assert.equal((await f.turns()).length,2);
});

test('website Stop interrupts fake native work and confirms cleanup, with an exact lost-ACK retry',{timeout:40000},async t=>{
  const f=await setup(t);await until(()=>f.applied.size,n=>n===2,'both fake provider turns');
  f.m.loseApplied=true;
  for(const mission of f.missions){
    const stop=command(mission,'stop');f.m.inbox.push(envelope(stop));
    await until(()=>f.m.saved.get(stop.operationId),r=>['applied','failed'].includes(r?.state),'Stop cleanup confirmed');
    assert.equal(f.m.saved.get(stop.operationId).state,'applied',JSON.stringify(await f.read(mission)));
    const stopped=await f.read(mission);assert.equal(stopped.state,'stopped');assert.equal(stopped.deadlineAt,mission.deadlineAt);
    assert.equal(stopped.guardPid,null);assert.equal(stopped.currentTurnId,null);
    assert.ok(stopped.outcomes.every(row=>row.outcome.cleanupConfirmed));
  }
  assert.equal((await f.turns()).length,2,'stopping never creates a new native turn');
});

for(const provider of ['claude','codex'])test(`project Pause lets fake ${provider} work finish its turn and confirms after cleanup`,{timeout:40000},async t=>{
  const f=await setup(t);await until(()=>f.applied.size,n=>n===2,'both providers running');
  const mission=f.missions.find(item=>item.target.agentId===provider);
  f.projectPauses.set(mission.target.projectId,{revision:3,requestedAt:Date.now()});
  // Pause lets the running turn finish (owner decision, 9 November 2026): no confirmation while the gate is closed.
  await sleep(400);assert.equal(f.sessions.some(row=>row.missionId===mission.missionId&&row.phase==='paused'),false,'not paused before the turn ends');
  assert.equal((await f.read(mission)).outcomes.length,0);
  await writeFile(join(f.root,`${mission.target.projectId}-${mission.target.agentId}-one`),'go');
  await until(()=>f.sessions,rows=>rows.some(row=>row.missionId===mission.missionId&&row.projectPauseRevision===3&&row.phase==='paused'),'exact project Pause confirmation');
  const held=await f.read(mission);
  assert.equal(held.outcomes[0].outcome.interrupted,false);
  assert.equal(held.outcomes[0].outcome.cleanupConfirmed,true);
  assert.equal((await f.turns()).length,2);
  assert.equal((await f.read(f.missions.find(item=>item!==mission))).state,'running','another project stays active');
});
