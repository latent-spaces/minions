import { turnValues } from '../src/analytics/values.js';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { db, inProject, profiles } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { startRun } from '../src/v2/runs.js';
import { reportTurn } from '../src/v2/turn-reports.js';
import type { LastTurn } from '../src/v2/records.js';
import { turnReceipts } from '../src/v2/records.js';
import { backfillUsageMetrics, metricsBuckets, metricsPending, projectReceipt, reconcileUsageMetrics } from '../src/analytics/projection.js';
import { readPlatformAnalytics, readProjectAnalytics } from '../src/analytics/read.js';
import { resetEmulator, seed, TEST_PROJECT } from './helpers.js';
const at=Date.UTC(2026,9,28,12),now=()=>at;
const scope=<T>(fn:()=>T)=>inProject(TEST_PROJECT,fn);
const query={from:'2026-10-27',to:'2026-10-28'};
beforeEach(resetEmulator);
test('empty history still rejects invalid rebuild versions',async()=>{
 for(const version of [0,-1,1.5,1000,NaN])await expect(scope(()=>backfillUsageMetrics(undefined,now,version))).rejects.toThrow('Invalid metrics projection version.');
});
async function fixture(){
 const f=await seed({profiles:[{name:'Owner',email:'owner@example.test'},{name:'Member',email:'member@example.test'}],agents:[{person:0,name:'Agent'}]});
 const id=f.agents[0]!.agentId,run=await scope(()=>startRun(id,{clientRunId:randomUUID(),runnerVersion:'synthetic',takeover:false},now));
 return {...f,id,runId:run.run_id};
}
const turn=(sequence:number,semantics:'uncached'|'includes-cache'='includes-cache'):LastTurn=>({kind:'work',outcome:'succeeded',endedAt:at,
 usage:{sequence,seconds:2,provider:semantics==='uncached'?'claude':'codex',model:semantics+'-model',inputSemantics:semantics,
 tokens:{input:10,output:3,cacheRead:4,cacheWrite:2,modelCalls:1}}});

test('receipt outbox, concurrent projection, retries, late days and rebuild replay preserve exact normalized history',async()=>{
 const f=await fixture(),first=turn(1),late={...turn(2,'uncached'),endedAt:at-86400000};
 await scope(()=>reportTurn(f.id,f.runId,first,now));await scope(()=>reportTurn(f.id,f.runId,first,now));
 await scope(()=>reportTurn(f.id,f.runId,late,now));
 expect((await metricsPending().get()).size).toBe(2);
 const receipts=await scope(()=>turnReceipts().get());
 await Promise.all(receipts.docs.flatMap(r=>[projectReceipt(r.ref.path,at),projectReceipt(r.ref.path,at)]));
 expect((await metricsPending().get()).empty).toBe(true);
 const read=()=>scope(()=>readProjectAnalytics(f.personIds[0]!,query,now));
 const result=await read();
 expect(result.totals.reports).toBe(2);expect(result.totals.metrics.input).toEqual({sum:26,known:2,partial:0});
 expect(result.points.map(p=>p.reports)).toEqual([1,1]);expect(result.groups).toHaveLength(2);
 expect(result.totals.metrics.instructionBytes).toEqual({sum:0,known:0,partial:0});
 await scope(()=>backfillUsageMetrics(undefined,now));expect(await read()).toEqual(result);
 const before=await metricsBuckets().get();
 await scope(()=>backfillUsageMetrics(undefined,now,2));
 const candidate=await metricsBuckets(2).get();
 expect(candidate.docs.map(d=>[d.id,d.data()])).toEqual(before.docs.map(d=>[d.id,d.data()]));
 expect((await metricsBuckets().get()).docs.map(d=>[d.id,d.data()])).toEqual(before.docs.map(d=>[d.id,d.data()]));
 expect(await read()).toEqual(result);
 await scope(()=>backfillUsageMetrics(undefined,now,2));
 expect((await metricsBuckets(2).get()).docs.map(d=>[d.id,d.data()])).toEqual(candidate.docs.map(d=>[d.id,d.data()]));
});

test('worker retries failed projection without affecting accepted receipts',async()=>{
 const path=`projects/${TEST_PROJECT}/turnReports/${'a'.repeat(64)}`;
 const f=await fixture();await scope(()=>reportTurn(f.id,f.runId,turn(1),now));
 await metricsPending().doc('broken').set({receiptPath:path,nextAt:at,projectId:TEST_PROJECT});
 expect(await reconcileUsageMetrics(now)).toMatchObject({selected:2,applied:1,failed:1});
 expect((await metricsPending().doc('broken').get()).data()?.nextAt).toBe(at+60000);
 expect((await scope(()=>turnReceipts().get())).size).toBe(1);
});

test('readers reauthorize every request and refuse forged scopes, inactive accounts and broad queries',async()=>{
 const f=await fixture();await scope(()=>reportTurn(f.id,f.runId,turn(1),now));await reconcileUsageMetrics(now);
 const actor={kind:'person' as const,operatorId:f.personIds[0]!,adminAuthenticated:true,verifiedGithubSession:true};
 expect((await readPlatformAnalytics(actor,query,now)).totals.reports).toBe(1);
 await expect(readPlatformAnalytics({...actor,adminAuthenticated:false},query,now)).rejects.toMatchObject({code:'forbidden'});
 await expect(scope(()=>readProjectAnalytics(f.personIds[0]!,{...query,projectId:'*'},now))).rejects.toMatchObject({code:'bad_input'});
 await expect(scope(()=>readProjectAnalytics(f.personIds[0]!,{from:'2026-01-01',to:'2026-10-28'},now))).rejects.toMatchObject({code:'bad_input'});
 const member=f.personIds[1]!;
 expect((await scope(()=>readProjectAnalytics(member,query,now))).totals.reports).toBe(1);
 await membershipDoc(TEST_PROJECT,member).update({status:'removed'});
 await expect(scope(()=>readProjectAnalytics(member,query,now))).rejects.toMatchObject({code:'unauthorized'});
 await profiles.doc(actor.operatorId).update({removedAt:at});
 await expect(readPlatformAnalytics(actor,query,now)).rejects.toMatchObject({code:'unauthorized'});
});


test('project series exclude other projects while platform series include all numeric buckets',async()=>{
 const f=await fixture();await scope(()=>reportTurn(f.id,f.runId,turn(1),now));await reconcileUsageMetrics(now);
 const original=(await metricsBuckets().get()).docs[0]!.data();
 await metricsBuckets().doc('other-project').set({...original,projectId:'b'.repeat(64)});
 expect((await scope(()=>readProjectAnalytics(f.personIds[0]!,query,now))).totals.reports).toBe(1);
 const actor={kind:'person' as const,operatorId:f.personIds[0]!,adminAuthenticated:true,verifiedGithubSession:true};
 const global=await readPlatformAnalytics(actor,query,now);
 expect(global.totals.reports).toBe(2);expect(global.groups).toHaveLength(2);
 expect((await readPlatformAnalytics(actor,{...query,projectId:TEST_PROJECT},now)).totals.reports).toBe(1);
});


test('partial cache/context coverage remains distinct from observed zero',()=>{
 const input=turn(1,'uncached');input.usage!.tokens!.cacheWrite=null;
 input.usage!.context={scope:'minions-supplied',coverage:'partial',instructionBytes:10,turnPromptBytes:20,catalogRequests:0,catalogBytes:0,tools:[]};
 const values=turnValues(input);
 expect(values.metrics.input).toEqual({sum:0,known:0,partial:0});
 expect(values.metrics.output).toEqual({sum:3,known:1,partial:0});
 expect(values.metrics.catalogBytes).toEqual({sum:0,known:1,partial:1});
 expect(values.metrics.instructionBytes).toEqual({sum:10,known:1,partial:1});
});

test('per-source and per-tool numeric evidence survives projection and bounded run/turn readers',async()=>{
 const {PROMPT_SOURCES}=await import('@minions/contracts');
 const {projectContext,platformContext}=await import('../src/analytics/context.js');
 const f=await fixture(),input=turn(1);
 input.usage!.context={scope:'minions-supplied',coverage:'partial',instructionBytes:10,turnPromptBytes:21,promptSources:{...Object.fromEntries(PROMPT_SOURCES.map(k=>[k,0])),steering:21} as Record<typeof PROMPT_SOURCES[number],number>,steeringMessages:1,sessionMode:'resumed',catalogRequests:1,catalogBytes:100,tools:[],
 byTool:[{name:'read_thread',catalogDeliveries:1,definitionBytes:80,calls:1,argumentBytes:2,responseTextBytes:55,refusals:0}]};
 await scope(()=>reportTurn(f.id,f.runId,input,now));await reconcileUsageMetrics(now);
 const data=await scope(()=>readProjectAnalytics(f.personIds[0]!,query,now));
 expect(data.totals.metrics.steeringBytes).toEqual({sum:21,known:1,partial:1});
 expect(data.totals.metrics.conversationResponseBytes.sum).toBe(55);
 expect(data.totals.mcpTools.read_thread?.definitionBytes).toBe(80);
 const runPage=await scope(()=>projectContext(f.personIds[0]!,{},'runs'));
 expect('runs' in runPage&&runPage.runs[0]?.runId).toBe(f.runId);
 const selection={agentId:f.id,runId:f.runId};
 const turns=await scope(()=>projectContext(f.personIds[0]!,selection,'turns'));
 expect('turns' in turns&&turns.turns[0]?.context).toEqual(input.usage!.context);
 const ordinary={kind:'person' as const,operatorId:f.personIds[0]!,adminAuthenticated:false};
 await expect(platformContext(ordinary,{projectId:TEST_PROJECT,...selection},'turns')).rejects.toMatchObject({code:'forbidden'});
 await expect(scope(()=>projectContext(f.personIds[0]!,{...selection,projectId:'b'.repeat(64)},'turns'))).rejects.toMatchObject({code:'bad_input'});
 await membershipDoc(TEST_PROJECT,f.personIds[0]!).update({status:'removed'});
 await expect(scope(()=>projectContext(f.personIds[0]!,selection,'turns'))).rejects.toMatchObject({code:'unauthorized'});
});

test('context pages remain bounded and complete across equal-time runs and receipt sequence pages',async()=>{
 const {projectContext}=await import('../src/analytics/context.js');
 const {runHistory}=await import('../src/v2/records.js');
 const {runHistoryId}=await import('../src/v2/turn-reports.js');
 const {createHash}=await import('node:crypto');
 const f=await fixture();
 await scope(async()=>{
  const batch=db.batch();
  for(let i=0;i<21;i++){const runId=randomUUID();batch.set(runHistory().doc(runHistoryId(f.id,runId)),{agentId:f.id,runId,generation:1,startedAt:at,startInput:{runnerVersion:'synthetic'}});}
  for(let i=1;i<=52;i++){const lastTurn=turn(i);batch.set(turnReceipts().doc(createHash('sha256').update(String(i)).digest('hex')),{agentId:f.id,runId:f.runId,sequence:i,fingerprint:'synthetic',lastTurn,receivedAt:at});}
  await batch.commit();
 });
 const first=await scope(()=>projectContext(f.personIds[0]!,{},'runs'));
 if(!('runs' in first))throw new Error('Expected runs.');
 expect(first.runs).toHaveLength(20);expect(first.nextCursor).not.toBeNull();
 const next=await scope(()=>projectContext(f.personIds[0]!,{cursor:first.nextCursor},'runs'));
 if(!('runs' in next))throw new Error('Expected runs.');
 expect(next.runs).toHaveLength(2);expect(new Set([...first.runs,...next.runs].map(r=>r.runId)).size).toBe(22);
 const selection={agentId:f.id,runId:f.runId};
 const page=await scope(()=>projectContext(f.personIds[0]!,selection,'turns'));
 if(!('turns' in page))throw new Error('Expected turns.');
 expect(page.turns).toHaveLength(50);expect(page.nextSequence).toBe(50);
 const tail=await scope(()=>projectContext(f.personIds[0]!,{...selection,after:page.nextSequence},'turns'));
 if(!('turns' in tail))throw new Error('Expected turns.');
 expect(tail.turns.map(t=>t.sequence)).toEqual([51,52]);expect(tail.nextSequence).toBeNull();
});

test('the overview returns each agent\'s latest run with its last 12 turns, oldest first',async()=>{
 const {projectContext}=await import('../src/analytics/context.js');
 const {createHash}=await import('node:crypto');
 const f=await fixture();
 await scope(async()=>{
  const batch=db.batch();
  for(let i=1;i<=14;i++)batch.set(turnReceipts().doc(createHash('sha256').update(`now${i}`).digest('hex')),{agentId:f.id,runId:f.runId,sequence:i,fingerprint:'synthetic',lastTurn:turn(i),receivedAt:at});
  await batch.commit();
 });
 const overview=await scope(()=>projectContext(f.personIds[0]!,{},'now'));
 if(!('agents' in overview))throw new Error('Expected agents.');
 expect(overview.agents.map(a=>[a.agentId,a.runId])).toEqual([[f.id,f.runId]]);
 expect(overview.agents[0]!.turns.map(t=>t.sequence)).toEqual([3,4,5,6,7,8,9,10,11,12,13,14]);
 await expect(scope(()=>projectContext(f.personIds[0]!,{agentId:f.id},'now'))).rejects.toMatchObject({code:'bad_input'});
});

test('aggregate row limits refuse partial totals and pending counts disclose their bounded lower limit',async()=>{
 const {emptyValues}=await import('../src/analytics/values.js');
 const f=await fixture();
 for(let first=0;first<2002;first+=400){const batch=db.batch();for(let i=first;i<Math.min(first+400,2002);i++)batch.set(metricsPending().doc(`pending-${String(i).padStart(4,'0')}`),{receiptPath:`projects/${TEST_PROJECT}/turnReports/${'a'.repeat(64)}`,projectId:TEST_PROJECT,nextAt:at});await batch.commit();}
 const result=await scope(()=>readProjectAnalytics(f.personIds[0]!,query,now));
 expect(result.pendingReports).toBe(2001);expect(result.pendingReportsCapped).toBe(true);
 for(let first=0;first<2001;first+=400){const batch=db.batch();for(let i=first;i<Math.min(first+400,2001);i++)batch.set(metricsBuckets().doc(`row-${String(i).padStart(4,'0')}`),{...emptyValues(),schema:1,day:'2026-10-28',projectId:TEST_PROJECT,provider:'codex',model:`synthetic-${i}`,projectedAt:at});await batch.commit();}
 await expect(scope(()=>readProjectAnalytics(f.personIds[0]!,query,now))).rejects.toMatchObject({code:'bad_input'});
});
