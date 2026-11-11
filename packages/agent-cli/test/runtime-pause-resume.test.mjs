import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from './fixtures/recorded-controllers.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { createNativeAdapterFactory } from '../src/service/native-bindings.mjs';
import { makeMixedNativeFixtures, nativeEvents } from './fixtures/mixed-native-fixtures.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const query = mission => ({missionId:mission.missionId,target:mission.target});
const command = (mission,kind,payload={}) => ({version:2,operationId:randomUUID(),kind,...query(mission),generation:mission.generation,payload});
const publicCommand = ({ version, target, ...input }) => ({ ...input, target: { projectId: target.projectId, agentId: target.agentId } });
const resume = (mission,pause) => command(mission,'resume',{pauseOperationId:pause.operationId});
const absent = pid => { try { process.kill(pid,0); return false; } catch(error) { if(error.code!=='ESRCH')throw error; return true; } };
async function until(read,predicate,label) {
  const deadline=Date.now()+12000;let value;
  while(Date.now()<deadline){value=await read();if(predicate(value))return value;await sleep(15);}
  assert.fail(`Timed out: ${label}; ${JSON.stringify(value)}`);
}
async function setup(t,{selections,firstResult,hooks={}}={}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'mlswarm-native-pause-')));
  const fixtures=await makeMixedNativeFixtures(root,selections,(label)=>[{gate:join(root,`${label}-first`),...(firstResult?{result:firstResult}:{})},{gate:join(root,`${label}-second`)}]);
  const store=await openRuntimeStore({directory:join(root,'ledger')}),adapterFactory=await createNativeAdapterFactory(fixtures);
  // A hook runs before the real store call, so a test can land a control inside that exact window.
  const hooked=Object.fromEntries(Object.entries(hooks).map(([name,hook])=>[name,async input=>{await hook(input);return store[name](input);}]));
  const applied=new Map(),tracked={...store,...hooked,async markTurnApplied(input){const value=await store.markTurnApplied(input);applied.set(input.missionId,input.turnId);return value;}};
  const controllers=createRuntimeControllers({store:tracked,adapterFactory,observeIntervalMs:20,
    cloudFactory:async mission=>({start:async()=>({runId:mission.missionId,cloudGeneration:1}),
      observe:async()=>({project:{started:true,paused:false,closed:false},pending:0,acknowledged:0}),
      workerSession:async()=>({missionId:mission.missionId,messages:[]}),phase:async()=>{},reportStatus:async()=>{}})});
  t.after(async()=>{await controllers.close();await store.close();await rm(root,{recursive:true,force:true});});
  const initial=(binding,deadline=Date.now()+45000)=>({version:2,operationId:randomUUID(),kind:'start',target:binding.target,missionId:randomUUID(),
    payload:{scope:'Synthetic Pause/Resume acceptance only.',deadlineAt:deadline,execution:{provider:binding.target.agentId,model:null}}});
  return {...fixtures,root,store,controllers,initial,applied,read:mission=>controllers.getMission(query(mission)),
    turns:async()=> (await nativeEvents(fixtures.events)).filter(event=>event.type==='turn')};
}

const acknowledged = (f,mission) => until(()=>f.read(mission),m=>m.currentTurnId&&f.applied.get(mission.missionId)===m.currentTurnId,'native acknowledgement committed');

const gate=(f,mission,turn)=>writeFile(join(f.root,`${mission.target.projectId}-${mission.target.agentId}-${turn}`),'go');

test('mixed projects pause only selected workers, letting the turn finish; exact Resume retains results, steering, identity and deadline', {timeout:45000},async t=>{
  const f=await setup(t),missions=(await Promise.all(f.bindings.map(b=>f.controllers.accept(f.initial(b))))).map(result=>result.mission);
  await until(f.turns,events=>events.length===4,'four fake native turns');
  for(const mission of [missions[0],missions[3]]){
    await acknowledged(f,mission);
    const own=(await f.turns()).find(e=>e.cwd===f.bindings.find(b=>b.target.projectId===mission.target.projectId&&b.target.agentId===mission.target.agentId).folder);
    const pause=command(mission,'pause');const accepted=await f.controllers.accept(pause);
    assert.equal(accepted.receipt.kind,'pause');assert.equal((await f.controllers.accept(pause)).created,false);
    // Pause lets the running turn finish (owner decision, 9 November 2026): pausing until the gate opens.
    const pausing=await until(()=>f.read(mission),m=>m.state==='pausing','pausing while the turn finishes');
    assert.equal(pausing.pauseOperationId,pause.operationId);await sleep(100);
    assert.equal(absent(own.pid),false,'Pause does not interrupt the native turn');assert.equal((await f.read(mission)).state,'pausing');
    await gate(f,mission,'first');
    const paused=await until(()=>f.read(mission),m=>m.state==='paused','confirmed paused once the turn ended');
    assert.equal(paused.pauseOperationId,pause.operationId);assert.equal(paused.deadlineAt,mission.deadlineAt);
    assert.equal(paused.guardPid,null);assert.equal(paused.currentTurnId,null);assert.equal(paused.outcomes.length,1);
    assert.equal(paused.outcomes[0].outcome.interrupted,false);assert.equal(paused.outcomes[0].outcome.cleanupConfirmed,true);
    await until(()=>absent(own.pid),Boolean,'only owned native exits');
    assert.equal((await f.store.listReports(query(mission))).reports.length,1);
    await f.controllers.accept(command(mission,'steer',{message:'Preserve this instruction while paused.'}));
    const restarting=resume(mission,pause);await f.controllers.accept(restarting);
    await until(f.turns,events=>events.filter(e=>e.cwd===own.cwd).length===2,'resumed native turn');
    const current=(await f.turns()).filter(e=>e.cwd===own.cwd)[1];assert.equal(current.sessionId,own.sessionId);
    assert.match(current.prompt,/Preserve this instruction while paused/);
    await f.controllers.accept(pause);await sleep(40);
    assert.equal((await f.read(mission)).state,'running','old Pause retry cannot reapply after Resume');
    assert.equal(absent(current.pid),false);
    await acknowledged(f,mission);
    const nextPause=command(mission,'pause');await f.controllers.accept(nextPause);
    await until(()=>f.read(mission),m=>m.state==='pausing','second Pause waits for the turn');await gate(f,mission,'second');
    await until(()=>f.read(mission),m=>m.state==='paused','second confirmed Pause');
    assert.equal((await f.controllers.accept(restarting)).created,false,'old Resume returns its receipt only');
    await assert.rejects(f.controllers.accept(resume(mission,pause)),{code:'conflict'});
    assert.equal((await f.read(mission)).pauseOperationId,nextPause.operationId);
    await f.controllers.accept(resume(mission,nextPause));
    // The paused turn finished on its own, so Resume alone starts nothing; the next instruction does.
    await until(()=>f.read(mission),m=>m.state!=='paused','resumed');await sleep(100);assert.equal((await f.read(mission)).outcomes.length,2,'Resume does not invent a turn');
    await f.controllers.accept(command(mission,'steer',{message:'Continue after the second Resume.'}));
    const final=await until(()=>f.read(mission),m=>m.outcomes.length===3,'third fake outcome');
    assert.equal(final.deadlineAt,mission.deadlineAt);assert.equal(final.outcomes.length,3);
    assert.equal((await f.store.listReports(query(mission))).reports.filter(r=>r.kind==='turn_report').length,3);
  }
  for(const i of [1,2]){
    const event=(await f.turns()).find(e=>e.cwd===f.bindings[i].folder);
    assert.equal(absent(event.pid),false,'other project/provider keeps working');
    await gate(f,missions[i],'first');
    await until(()=>f.read(missions[i]),m=>m.outcomes.length===1,'unrelated result');
  }
});

test('the job\'s time keeps counting while paused; the end time does not end a paused worker, and Resume after it waits for more time',{timeout:15000},async t=>{
  const f=await setup(t,{selections:[['park','claude']]});
  const {mission}=await f.controllers.accept(f.initial(f.bindings[0],Date.now()+3500));
  await until(f.turns,e=>e.length===1,'initial native');await acknowledged(f,mission);const pause=command(mission,'pause');await f.controllers.accept(pause);
  await gate(f,mission,'first');await until(()=>f.read(mission),m=>m.state==='paused','paused before the end time');
  await sleep(Math.max(0,mission.deadlineAt-Date.now())+300);
  const held=await f.read(mission);assert.equal(held.state,'paused');assert.equal(held.deadlineAt,mission.deadlineAt);
  await f.controllers.accept(resume(mission,pause));
  await until(()=>f.read(mission),m=>m.state==='waiting','resumed worker waits for more time');
  await sleep(300);
  assert.equal((await f.turns()).length,1);
  assert.equal((await f.store.listReports(query(mission))).reports.filter(r=>r.kind==='stop_run').length,0);
});

test('owner boundary and global IDs refuse before Pause holds a native worker',{timeout:20000},async t=>{
  const f=await setup(t,{selections:[['garden','claude']]}),initial=f.initial(f.bindings[0]);
  const {mission}=await f.controllers.accept(initial);const events=await until(f.turns,e=>e.length===1,'fake native');
  const principal={site:mission.target.site,ownerId:mission.target.ownerId};const app=createRuntimeApplication({controllers:f.controllers,principal});
  await acknowledged(f,mission);
  const pause=command(mission,'pause');
  for(const [caller,input] of [[{kind:'owner',...principal},{...pause,target:{...mission.target,ownerId:'foreign'}}],
    [{kind:'worker',target:mission.target,missionId:mission.missionId,generation:mission.generation},pause]])
    assert.equal((await app.callTool(caller,'control_agent',input)).isError,true);
  await assert.rejects(f.controllers.accept({...pause,operationId:initial.operationId}),{code:'conflict'});
  await assert.rejects(f.controllers.accept({...pause,operationId:randomUUID(),generation:999}),{code:'stale_generation'});
  assert.equal(absent(events[0].pid),false);assert.equal((await f.read(mission)).state,'running');
  const result=await app.callTool({kind:'owner',...principal},'control_agent',publicCommand(pause));assert.ok(!result.isError,JSON.stringify(result));
  await until(()=>f.read(mission),m=>m.state==='pausing','owner MCP Pause');await gate(f,mission,'first');
  await until(()=>f.read(mission),m=>m.state==='paused','paused once the turn ended');
  const report=(await f.store.listReports(query(mission))).reports[0];await f.store.failReport({reportId:report.reportId,errorCode:'unauthorized',retryAt:null});
  await assert.rejects(f.controllers.accept(resume(mission,pause)),{code:'report_attention'});
  assert.equal((await f.read(mission)).state,'paused');
});

for (const window of ['recordGuard','markTurnSubmitted']) test(`a Pause landing in ${window} while the turn starts lets the prepared turn run in full`,{timeout:20000},async t=>{
  let entered,release;const held=new Promise(resolve=>{entered=resolve;}),opened=new Promise(resolve=>{release=resolve;});
  let first=true;
  const f=await setup(t,{selections:[['garden','claude']],hooks:{[window]:async()=>{if(!first)return;first=false;entered();await opened;}}});
  const {mission}=await f.controllers.accept(f.initial(f.bindings[0]));
  await held;
  const pause=command(mission,'pause');await f.controllers.accept(pause);
  release();
  await until(f.turns,e=>e.length===1,'the prepared turn reaches the native worker');
  await until(()=>f.read(mission),m=>m.state==='pausing','pausing while the turn finishes');
  await gate(f,mission,'first');
  const paused=await until(()=>f.read(mission),m=>m.state==='paused','paused once the turn ended');
  assert.equal(paused.outcomes.length,1);assert.equal(paused.outcomes[0].outcome.failed,false);
  assert.equal(paused.outcomes[0].outcome.interrupted,false);assert.equal(paused.outcomes[0].outcome.delivery,'acknowledged');
  await f.controllers.accept(resume(mission,pause));
  await until(()=>f.read(mission),m=>m.state==='waiting','resumed');
  await f.controllers.accept(command(mission,'steer',{message:'Continue after Resume.'}));
  await gate(f,mission,'second');
  const next=await until(()=>f.read(mission),m=>m.outcomes.length===2,'next turn after Resume');
  assert.equal(next.outcomes[1].outcome.failed,false);assert.notEqual(next.state,'stopped');
});

test('Resume continues on its own when the paused turn ended WORK_NEXT: runnable',{timeout:20000},async t=>{
  const f=await setup(t,{selections:[['garden','claude']],firstResult:'Synthetic first turn.\nWORK_NEXT: runnable'});
  const {mission}=await f.controllers.accept(f.initial(f.bindings[0]));
  await until(f.turns,e=>e.length===1,'initial native');await acknowledged(f,mission);
  const pause=command(mission,'pause');await f.controllers.accept(pause);
  await gate(f,mission,'first');
  await until(()=>f.read(mission),m=>m.state==='paused','paused once the runnable turn ended');
  await sleep(150);assert.equal((await f.turns()).length,1,'no turn starts while paused');
  await f.controllers.accept(resume(mission,pause));
  await until(f.turns,e=>e.length===2,'Resume continues the runnable work without new input');
  await gate(f,mission,'second');
  await until(()=>f.read(mission),m=>m.outcomes.length===2,'continued turn recorded');
});

test('Kill during pausing ends the running turn and the worker',{timeout:20000},async t=>{
  const f=await setup(t,{selections:[['garden','claude']]});
  const {mission}=await f.controllers.accept(f.initial(f.bindings[0]));
  const [event]=await until(f.turns,e=>e.length===1,'initial native');await acknowledged(f,mission);
  await f.controllers.accept(command(mission,'pause'));
  await until(()=>f.read(mission),m=>m.state==='pausing','pausing while the turn finishes');
  await f.controllers.accept(command(mission,'stop'));
  const stopped=await until(()=>f.read(mission),m=>m.state==='stopped','Kill settles the pausing worker');
  assert.equal(stopped.guardPid,null);assert.equal(stopped.currentTurnId,null);
  await until(()=>absent(event.pid),Boolean,'Kill ends the native turn without waiting for it');
  assert.equal(stopped.outcomes.at(-1)?.outcome.interrupted,true);
});
