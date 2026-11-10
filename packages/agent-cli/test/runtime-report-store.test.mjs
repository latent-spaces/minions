import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeStore } from '../src/service/store.mjs';
import { turnReportId } from '../src/service/cloud-reports.mjs';
const target={site:'https://example.test',ownerId:'owner',projectId:'project',agentId:'agent'};
const outcome={delivery:'acknowledged',failed:false,interrupted:false,retryable:false,cleanupConfirmed:true,usage:{model:'actual-model',modelSource:'provider-report',tokens:{input:10,output:2}}};
async function setup(t){const directory=await mkdtemp(join(tmpdir(),'mlswarm-report-store-'));const store=await openRuntimeStore({directory});t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});const missionId=randomUUID();const {mission}=await store.accept({version:2,operationId:randomUUID(),kind:'start',missionId,target,payload:{scope:'Synthetic report check',deadlineAt:Date.now()+60000,execution:{provider:'codex',model:null}}});return {store,ref:{missionId,generation:mission.generation}};}
async function turn(f){const turnId=randomUUID();await f.store.prepareTurn({...f.ref,turnId});return f.store.recordTurn({...f.ref,turnId,text:'Private local result',outcome,startedAt:1000,endedAt:2000});}
test('cloud intent fences unconfirmed execution and immutable binding precedes atomic completion',async t=>{const f=await setup(t);const intent=await f.store.prepareCloudRun({...f.ref,startedAt:1000});assert.equal(intent.cloudRun.generation,null);await assert.rejects(f.store.prepareTurn({...f.ref,turnId:randomUUID()}),{code:'conflict'});await f.store.bindCloudRun({...f.ref,runId:f.ref.missionId,cloudGeneration:4});await assert.rejects(f.store.bindCloudRun({...f.ref,runId:f.ref.missionId,cloudGeneration:5}),{code:'conflict'});await turn(f);const {reports}=await f.store.listReports({missionId:f.ref.missionId});assert.equal(reports.length,1);assert.deepEqual((await f.store.getMission({missionId:f.ref.missionId,target})).reportDelivery,{pending:1,delivered:0,attention:0});assert.equal(reports[0].reportId,turnReportId(target.agentId,f.ref.missionId,1));assert.equal(reports[0].payload.last_turn.usage.seconds,1);assert.equal(JSON.stringify(reports).includes('Private local result'),false);await assert.rejects(f.store.acknowledgeReport({reportId:reports[0].reportId,receiptId:'wrong'}),{code:'conflict'});assert.equal((await f.store.listDueReports()).length,1);});
