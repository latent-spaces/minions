import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openRuntimeStore} from '../src/service/store.mjs';
import {createRuntimeControllers} from '../src/service/controllers.mjs';
import {createRuntimeApplication} from '../src/service/application.mjs';

const target={site:'https://fixture.invalid',ownerId:'owner',projectId:'project',agentId:'agent'};
const start=()=>({version:2,operationId:randomUUID(),kind:'start',missionId:randomUUID(),target,payload:{scope:'Synthetic review',deadlineAt:Date.now()+300000,execution:{provider:'codex',model:null}}});
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'mlswarm-report-recovery-'));let store=await openRuntimeStore({directory});
 t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
 return {get store(){return store;},async reopen(){await store.close();store=await openRuntimeStore({directory});}};
}
async function seed(store,{confirmed=false,outcome=false,uncertain=false}={}){
 const command=start(),{mission}=await store.accept(command),ref={missionId:mission.missionId,generation:mission.generation};
 await store.prepareCloudRun({...ref,startedAt:mission.createdAt});
 if(confirmed||outcome||uncertain)await store.bindCloudRun({...ref,runId:mission.missionId,cloudGeneration:1});
 if(outcome||uncertain){const turnId=randomUUID();await store.prepareTurn({...ref,turnId});await store.markTurnSubmitted({...ref,turnId});
  if(outcome)await store.recordTurn({...ref,turnId,text:'Real result must survive',startedAt:mission.createdAt,endedAt:mission.createdAt+100,outcome:{delivery:'acknowledged',failed:false,interrupted:false,retryable:false,cleanupConfirmed:true}});
 }
 await store.settleMission({...ref,reason:'cloud_refused',cleanupConfirmed:!uncertain});
 const reports=(await store.listReports({target,missionId:mission.missionId})).reports;
 const report=reports.find(r=>r.kind==='stop_run');
 if(report)await store.failReport({reportId:report.reportId,errorCode:'run_superseded',retryAt:null});
 return {command,mission,report,reports};
}
const publicInput = ({ version, target, ...input }) => ({ ...input, target: { projectId: target.projectId, agentId: target.agentId }, action: 'archive_failed_launch_report' });
const recovery=s=>({version:1,operationId:randomUUID(),target,missionId:s.mission.missionId,reportId:s.report.reportId,expectedErrorCode:'run_superseded',reason:'Verified pre-model launch failure; keep evidence without claiming delivery.',approved:true});
const rejects=(p,code)=>assert.rejects(p,e=>e.code===code);

test('recovery preserves reports, audits exact replay and survives reopen without fake delivery',async t=>{
 const f=await fixture(t),s=await seed(f.store),command=recovery(s);
 const before=(await f.store.listReports({target,missionId:s.mission.missionId})).reports[0];
 const results=await Promise.all([f.store.archiveFailedLaunchReport(command),f.store.archiveFailedLaunchReport(command)]);
 assert.equal(results.filter(r=>r.created).length,1);assert.deepEqual(results[0].receipt,results[1].receipt);
 const archived=results[0].report;assert.equal(archived.state,'archived');assert.equal(archived.deliveryState,'attention');assert.equal(archived.archive.deliveryConfirmed,false);
 for(const key of ['payload','errorCode','attempts','runId','expectedReceiptId','createdAt','updatedAt'])assert.deepEqual(archived[key],before[key]);
 await rejects(f.store.acknowledgeReport({reportId:s.report.reportId,receiptId:s.report.expectedReceiptId}),'conflict');
 assert.equal((await f.store.failReport({reportId:s.report.reportId,errorCode:'delivery_unavailable',retryAt:Date.now()})).state,'archived');
 assert.equal((await f.store.listDueReports()).length,0);
 await rejects(f.store.archiveFailedLaunchReport({...command,reason:'Changed reason'}),'conflict');
 await rejects(f.store.accept({...start(),operationId:command.operationId}),'conflict');
 await f.reopen();assert.deepEqual((await f.store.archiveFailedLaunchReport(command)).receipt,results[0].receipt);
 assert.deepEqual(await f.store.getOperation({ target, operationId: command.operationId }), results[0].receipt);
 await rejects(f.store.getOperation({target:{...target,projectId:'foreign-project'},operationId:command.operationId}),'forbidden');
 await rejects(f.store.getOperation({target:{...target,ownerId:'foreign-owner'},operationId:command.operationId}),'forbidden');
 assert.deepEqual((await f.store.getMission({target,missionId:s.mission.missionId})).reportDelivery,{pending:0,delivered:0,attention:0,archived:1});
 assert.equal((await f.store.accept(start())).created,true);
});

test('confirmed registration, actual result and uncertain execution cannot be archived',async t=>{
 for(const options of [{confirmed:true},{outcome:true},{uncertain:true}]){
  await t.test(JSON.stringify(options),async t=>{const f=await fixture(t),s=await seed(f.store,options);
   if(s.report)await rejects(f.store.archiveFailedLaunchReport(recovery(s)),'recovery_not_safe');
   else {const real=s.reports[0];assert.equal(real,undefined);assert.equal((await f.store.getMission({target,missionId:s.mission.missionId})).state,'recovery_required');}
   const saved=await f.store.getMission({target,missionId:s.mission.missionId});
   if(options.outcome)assert.equal(saved.outcomes[0].text,'Real result must survive');
  });
 }
});

test('recovery is owner scoped and rejects foreign targets, unsupported refusal, unapproved input and operation reuse',async t=>{
 const f=await fixture(t),s=await seed(f.store),cmd=recovery(s),controllers=createRuntimeControllers({store:f.store,adapterFactory:()=>assert.fail('No model launch')}),principal={site:target.site,ownerId:target.ownerId};
 t.after(()=>controllers.close());const app=createRuntimeApplication({controllers,principal}),caller={kind:'owner',...principal};
 const foreign=await app.callTool(caller,'recover_agent_run',{...publicInput(cmd),target:{...publicInput(cmd).target,ownerId:'other'}});assert.equal(foreign.isError,true);
 const worker=await app.callTool({kind:'worker',target,missionId:s.mission.missionId,generation:s.mission.generation},'recover_agent_run',publicInput(cmd));assert.equal(worker.isError,true);
 await rejects(f.store.archiveFailedLaunchReport({...cmd,approved:false}),'invalid_command');
 await rejects(f.store.archiveFailedLaunchReport({...cmd,operationId:s.command.operationId}),'conflict');
 await rejects(f.store.archiveFailedLaunchReport({...cmd,expectedErrorCode:'unauthorized'}),'invalid_command');
 const ok=await app.callTool(caller,'recover_agent_run',publicInput(cmd));assert.ok(!ok.isError);const archived=JSON.parse(ok.content[0].text);assert.equal(archived.report.state,'archived');
 const lookup=await app.callTool(caller,'get_agent_control_result',{operationId:cmd.operationId,target:publicInput(cmd).target});
 assert.deepEqual(JSON.parse(lookup.content[0].text),archived.receipt);
 const duplicate=await app.callTool(caller,'recover_agent_run',publicInput(cmd));assert.equal(JSON.parse(duplicate.content[0].text).created,false);
 assert.equal((await app.callTool(caller,'runtime_archive_failed_launch_report',publicInput(cmd))).isError,true);
});
