import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { claimWorkerCheckout, inspectWorkerCheckout } from '../src/checkout-ownership.mjs';
import { stopOrphanedMission } from '../src/service/orphan-stop.mjs';

const target={site:'https://recovery.invalid',ownerId:'owner',projectId:'park',agentId:'claude'};
const other={...target,projectId:'garden',agentId:'codex'};
const principal={site:target.site,ownerId:target.ownerId},caller={kind:'owner',...principal};
const start=(selected=target)=>({version:2,operationId:randomUUID(),kind:'start',missionId:randomUUID(),target:selected,
  payload:{scope:'Synthetic recovery, never execute a model.',deadlineAt:Date.now()+300000,execution:{provider:selected===target?'claude':'codex',model:null}}});
const query=mission=>({missionId:mission.missionId,target:mission.target});
const publicInput = ({ version, target, ...input }) => ({ ...input, target: { projectId: target.projectId, agentId: target.agentId } });
const recovery=(mission,extra={})=>({version:1,operationId:randomUUID(),...query(mission),generation:mission.generation,
  action:'finalize',reason:'Close safely interrupted synthetic work.',approved:true,...extra});
const reject=(action,code)=>assert.rejects(async()=>action(),error=>error.code===code);
async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'minions-safe-recovery-'))),directory=join(root,'ledger'),registryRoot=join(root,'ownership');
  const folders=[join(root,'park'),join(root,'garden')];for(const folder of [...folders,registryRoot])await mkdir(folder,{mode:0o700});
  let store=await openRuntimeStore({directory}),controllers,inspections=0;
  const folder=mission=>folders[mission.target.projectId==='park'?0:1];
  const compose=()=>controllers=createRuntimeControllers({store,adapterFactory:()=>assert.fail('Recovery must never construct a model adapter'),
    stopOrphanedMission:mission=>stopOrphanedMission(mission,{folder:folder(mission),registryRoot}),
    inspectRecoveryCheckout:mission=>{inspections++;return inspectWorkerCheckout({folder:folder(mission),
      agentId:mission.target.agentId,project:mission.target.projectId,registryRoot});}});
  t.after(async()=>{await controllers?.close();await store?.close();await rm(root,{recursive:true,force:true});});
  return {directory,registryRoot,folders,get store(){return store;},get inspections(){return inspections;},
    compose,async reopen(){await controllers?.close();controllers=undefined;await store.close();store=await openRuntimeStore({directory});},
    async closeStore(){await controllers?.close();controllers=undefined;await store.close();store=undefined;},
    async openStore(){store=await openRuntimeStore({directory});}};
}
async function seed(store,selected=target,{settled=true}={}) {
  const command=start(selected),{mission}=await store.accept(command),ref={missionId:mission.missionId,generation:mission.generation};
  await store.prepareCloudRun({...ref,startedAt:mission.createdAt});await store.bindCloudRun({...ref,runId:mission.missionId,cloudGeneration:1});
  const turnId=randomUUID();await store.acceptSteering({version:2,operationId:randomUUID(),kind:'steer',target:selected,...ref,payload:{message:'Preserve this instruction.'}});
  await store.prepareTurn({...ref,turnId});await store.markTurnSubmitted({...ref,turnId});
  if(settled)await store.recordTurn({...ref,turnId,text:'Synthetic result retained across recovery.',startedAt:Date.now(),endedAt:Date.now(),
    outcome:{delivery:'acknowledged',failed:false,interrupted:false,retryable:false,cleanupConfirmed:true}});
  // A settled worker waiting between turns survives a restart; one whose Stop the restart interrupted needs recovery.
  if(settled)await store.accept({version:2,operationId:randomUUID(),kind:'stop',target:selected,...ref,payload:{}});
  return store.getMission(query(mission));
}
async function crashAfterCommit(f,command,claim) {
  await f.closeStore();
  const child=fork(new URL('./fixtures/mission-recovery-crash.mjs',import.meta.url),[JSON.stringify({directory:f.directory,command,claim})],{stdio:['ignore','ignore','pipe','ipc']});
  let result;
  try {
    result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Recovery crash fixture timed out')),5000);
      child.once('message',message=>{clearTimeout(timer);resolve(message.result);});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Recovery fixture exited ${code}`));});
    });
  } finally {if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}}
  await f.openStore();return result;
}
test('finalization survives a real post-COMMIT crash and exact retry without losing results, steering or reports',async t=>{
  const f=await fixture(t),a=await seed(f.store),b=await seed(f.store,other);
  const reports=(await f.store.listReports(query(a))).reports;
  await f.reopen();const before=await f.store.getMission(query(a));
  const command=recovery(a),committed=await crashAfterCommit(f,command);
  const controllers=f.compose(),retried=await controllers.recoverMission(command);
  assert.equal(committed.created,true);assert.equal(retried.created,false);assert.deepEqual(retried.receipt,committed.receipt);
  assert.equal(retried.mission.state,'stopped');assert.equal(f.inspections,0,'Receipt retry never needs paths or repeats side effects');
  assert.deepEqual(retried.mission.outcomes,before.outcomes);assert.deepEqual(retried.mission.steering,before.steering);
  const saved=(await f.store.listReports(query(a))).reports;assert.equal(saved.filter(r=>r.kind==='stop_run').length,1);
  assert.deepEqual(saved.find(r=>r.kind==='turn_report'),reports.find(r=>r.kind==='turn_report'));
  assert.equal((await f.store.getMission(query(b))).state,'recovery_required');
  assert.equal(retried.receipt.executionReplayed,false);assert.equal(retried.receipt.deliveryConfirmed,false);
  await reject(()=>controllers.recoverMission({...command,reason:'Changed input'}),'conflict');
});
test('unsettled submission stays protected from finalization; a live claim refuses Stop and only a confirmed kill settles it',async t=>{
  const f=await fixture(t),mission=await seed(f.store,target,{settled:false});await f.reopen();const controllers=f.compose();
  const before=await f.store.getMission(query(mission));
  await reject(()=>controllers.recoverMission(recovery(mission)),'recovery_not_safe');
  assert.equal(f.inspections,0);
  const stop=()=>controllers.accept({version:2,operationId:randomUUID(),kind:'stop',...query(mission),generation:mission.generation,payload:{}});
  // This live test process stands in for another running connector that still owns the worker.
  const live=await claimWorkerCheckout({folder:f.folders[0],registryRoot:f.registryRoot,agentId:target.agentId,project:target.projectId});live.beginTurn();
  await stop();
  const saved=await f.store.getMission(query(mission));assert.equal(saved.state,'recovery_required');
  assert.equal(saved.currentTurnId,before.currentTurnId);assert.equal(saved.steering[0].state,'uncertain');
  assert.equal((await f.store.listReports(query(mission))).reports.some(r=>r.kind==='stop_run'),false);
  assert.equal((await readdir(f.registryRoot)).filter(name=>name.startsWith('claim-')).length,1,'a live owner keeps its claim');
  live.endTurn({cleanupConfirmed:true});live.release();
  await stop();
  const ended=await f.store.getMission(query(mission));assert.equal(ended.state,'stopped');assert.equal(ended.currentTurnId,null);
  assert.equal(ended.steering[0].state,'uncertain','the abandoned turn is never reported as applied');
  assert.equal((await f.store.listReports(query(mission))).reports.filter(r=>r.kind==='stop_run').length,1);
});
for(const phase of ['idle','spawning','running'])test(`a ${phase} exact checkout claim is never removed by recovery`,async t=>{
  const f=await fixture(t),mission=await seed(f.store);await f.reopen();
  const claim=await claimWorkerCheckout({folder:f.folders[0],registryRoot:f.registryRoot,agentId:target.agentId,project:target.projectId});
  if(phase!=='idle')claim.beginTurn();if(phase==='running'){claim.guardStarted(process.pid);claim.nativeStarted(process.pid);}
  const path=join(f.registryRoot,(await readdir(f.registryRoot)).find(name=>name.startsWith('claim-'))),before=await readFile(path);
  await reject(()=>f.compose().recoverMission(recovery(mission)),'recovery_not_safe');
  assert.deepEqual(await readFile(path),before);assert.equal((await f.store.getMission(query(mission))).state,'recovery_required');
  assert.equal((await readdir(f.registryRoot)).length,1,'Inspection created no cleanup ticket or extra writer');
});
test('foreign owner/worker, stale generation and missing binding cannot reach recovery mutation',async t=>{
  const f=await fixture(t),mission=await seed(f.store);await f.reopen();const controllers=f.compose(),app=createRuntimeApplication({controllers,principal});
  for(const [identity,input] of [[caller,{...publicInput(recovery(mission)),target:{...target,ownerId:'other'}}],
    [{kind:'worker',target,missionId:mission.missionId,generation:mission.generation},publicInput(recovery(mission))],
    [caller,{...publicInput(recovery(mission)),approved:false}]])assert.equal((await app.callTool(identity,'recover_agent_run',input)).isError,true);
  assert.equal(f.inspections,0);await reject(()=>controllers.recoverMission({...recovery(mission),generation:99}),'stale_generation');
  const missing=createRuntimeControllers({store:f.store,adapterFactory:()=>assert.fail('No native'),inspectRecoveryCheckout:()=>null});
  await reject(()=>missing.recoverMission(recovery(mission)),'recovery_not_safe');await missing.close();
});

for(const phase of ['idle','spawning','running'])test(`dead ${phase} owner: only recorded idle cleanup permits finalization, never claim deletion`,async t=>{
  const f=await fixture(t),mission=await seed(f.store);
  await crashAfterCommit(f,null,{folder:f.folders[0],registryRoot:f.registryRoot,agentId:target.agentId,project:target.projectId,phase});
  const path=join(f.registryRoot,(await readdir(f.registryRoot)).find(name=>name.startsWith('claim-'))),before=await readFile(path);
  const controllers=f.compose(),command=recovery(mission);
  if(phase==='idle')assert.equal((await controllers.recoverMission(command)).mission.state,'stopped');
  else await reject(()=>controllers.recoverMission(command),'recovery_not_safe');
  assert.deepEqual(await readFile(path),before);assert.equal((await readdir(f.registryRoot)).length,1);
});
