import { beforeEach, expect, test } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { inProject, projectDoc } from '../src/firestore.js';
import { requestHuman, readHumanRequests, readAgentHumanRequests, answerHumanRequest, acknowledgeHumanAnswer, resolveHumanRequest, humanRequestWithSource } from '../src/projects/human-requests.js';
import { humanRequestRoutes } from '../src/projects/human-request-routes.js';
import { projects } from '../src/projects/records.js';
import { membershipDoc } from '../src/projects/access.js';
import { startRun } from '../src/v2/runs.js';
import { workSignalDoc } from '../src/v2/work-signals.js';
import { recordWorkIntent } from '../src/v2/work-intents.js';
import { exportPerson } from '../src/store/person-export.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { v2Routes } from '../src/v2/routes.js';
import { scoped } from './helpers.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from './helpers.js';

beforeEach(resetEmulator);
const scope=<T>(fn:()=>T)=>inProject(TEST_PROJECT,fn);
const question={dedupe_key:'research-access',visibility:'private',title:'Research repository access',question:'Please check the permitted research access.',context:'The dependent license check is waiting. Checked the repository reader; access was refused.'};
async function fixture() {
  const f=await seed({profiles:[{name:'Alice',email:'alice@example.test'},{name:'Bob',email:'bob@example.test'},{name:'Carol',email:'carol@example.test'}],agents:[{person:0,name:'Fox'},{person:1,name:'Owl'}]});
  const run=await scope(()=>startRun(f.agents[0].agentId,{clientRunId: randomUUID(), runnerVersion:'fake',takeover:false},()=>1000));
  const otherRun=await scope(()=>startRun(f.agents[1].agentId,{clientRunId: randomUUID(), runnerVersion:'fake',takeover:false},()=>1000));
  const create=(input=question)=>scope(()=>requestHuman(f.agents[0].agentId,run.run_id,input,()=>1100));
  return {...f,run,otherRun,create};
}
test('private stays with the agent owner; shared decisions are member-visible and project-owner answered, deduplicated across agents',async()=>{
  const f=await fixture(), privateRequest=(await f.create()).request;
  // Even the project owner cannot read another participant's private request.
  await scope(()=>projectDoc().update({ownerProfileId:f.personIds[1]}));
  expect((await readHumanRequests(f.personIds[0],{})).items).toHaveLength(1);
  expect((await readHumanRequests(f.personIds[0],{project_id:TEST_PROJECT})).items.map(r=>r.id)).toEqual([privateRequest.id]);
  expect((await readHumanRequests(f.personIds[1],{})).items).toHaveLength(0);
  expect((await readHumanRequests(f.personIds[1],{project_id:TEST_PROJECT})).items).toHaveLength(0);
  await expect(answerHumanRequest(f.personIds[1],privateRequest.id,{expected_revision:1,client_request_id:'bad',body:'Allowed'},()=>1200)).rejects.toMatchObject({code:'not_found'});
  const shared={...question,visibility:'project'};
  const first=(await f.create(shared)).request;
  const same=await scope(()=>requestHuman(f.agents[1].agentId,f.otherRun.run_id,shared,()=>1200));
  expect(same.request.id).toBe(first.id);
  const owner=(await scope(()=>projectDoc().get())).data()!.ownerProfileId;
  expect(first.assigneeProfileId).toBe(owner);
  expect((await readHumanRequests(f.personIds[1],{project_id:TEST_PROJECT})).items.map(r=>r.id)).toEqual([first.id]);
  expect(new Set((await readHumanRequests(f.personIds[0],{project_id:TEST_PROJECT})).items.map(r=>r.id))).toEqual(new Set([first.id,privateRequest.id]));
  await expect(answerHumanRequest(f.personIds[0],first.id,{expected_revision:1,client_request_id:'not-owner',body:'My choice'},()=>1300)).rejects.toMatchObject({code:'not_found'});
  expect((await scope(()=>readAgentHumanRequests(f.agents[1].agentId,f.otherRun.run_id,{scope:'project'}))).items.map(r=>r.id)).toEqual([first.id]);
  expect((await scope(()=>readAgentHumanRequests(f.agents[1].agentId,f.otherRun.run_id,{}))).items).toHaveLength(0);
});
test('answers survive run replacement, wake only through the scheduling hint, preserve other work and resolve exactly once',async()=>{
  const f=await fixture(), agent=f.agents[0].agentId, request=(await f.create()).request;
  const input={expected_revision:1,client_request_id:'answer',body:'I checked access; use the approved repository reader.'};
  await scope(()=>recordWorkIntent(agent,f.run.run_id,{intent_id:'other-task',client_request_id:'intent',expected_revision:0,state:'runnable',next_step:'Continue unrelated tests'},()=>1150));
  const first=await answerHumanRequest(f.personIds[0],request.id,input,()=>1200);
  expect((await scope(()=>workSignalDoc(agent).get())).data()).toMatchObject({runnable:true,runnableCount:1,humanAnswerCount:1});
  expect(await answerHumanRequest(f.personIds[0],request.id,input,()=>1300)).toMatchObject({replayed:true,request:first.request});
  await expect(answerHumanRequest(f.personIds[0],request.id,{...input,body:'Different'},()=>1300)).rejects.toMatchObject({code:'intent_conflict'});
  const replacement=await scope(()=>startRun(agent,{clientRunId: randomUUID(), runnerVersion:'replacement',takeover:true},()=>1400));
  const seen=await scope(()=>readAgentHumanRequests(agent,replacement.run_id,{status:'answered'}));
  expect(seen.items[0].answer?.body).toBe(input.body);
  await expect(scope(()=>readAgentHumanRequests(agent,f.run.run_id,{status:'answered'}))).rejects.toMatchObject({code:'run_superseded'});
  const resolve={request_id:request.id,expected_revision:2,client_request_id:'resolve',summary:'Confirmed access and continued the research.'};
  await scope(()=>resolveHumanRequest(agent,replacement.run_id,resolve,()=>1500));
  await scope(()=>resolveHumanRequest(agent,replacement.run_id,resolve,()=>1600));
  expect((await scope(()=>workSignalDoc(agent).get())).data()).toMatchObject({runnable:true,runnableCount:1,humanAnswerCount:0});
  expect((await readHumanRequests(f.personIds[0],{status:'resolved'})).items[0]).toMatchObject({question:question.question,answer:{body:input.body},resolution:{body:resolve.summary}});
});
test('revoked membership fences reads, answers and historical receipts; guest and agent tokens cannot use human HTTP',async()=>{
  const f=await fixture(), request=(await f.create()).request;
  const app=express();app.use('/api/needs-you',humanRequestRoutes(()=>1200));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/needs-you`;
  const call=(token?:string,profileId=f.personIds[0],body?:object)=>fetch(base+(body?`/${request.id}/answer`:''),{method:body?'POST':'GET',headers:{...(token?{authorization:`Bearer ${token}`} : {}),'X-Mlswarm-Profile-Id':profileId,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  try {
    expect((await call()).status).toBe(401);
    expect((await call(f.agents[0].token)).status).toBe(401);
    const token=await idTokenFor('alice@example.test');
    expect((await call(token,f.personIds[1])).status).toBe(401);
    const body={expected_revision:1,client_request_id:randomUUID(),body:'Checked.'};
    expect((await call(token,f.personIds[0],body)).status).toBe(200);
    expect((await call(token)).headers.get('cache-control')).toBe('no-store');
    const owner=(await scope(()=>projectDoc().get())).data()!.ownerProfileId;
    const nonowner=f.personIds.find(id=>id!==owner)!;
    const ownAgent=f.agents[f.personIds.indexOf(nonowner)];
    if(ownAgent) {
      await membershipDoc(TEST_PROJECT,nonowner).update({status:'removed',statusChangedAt:1300});
      expect((await readHumanRequests(nonowner,{status:'answered'})).items).toHaveLength(0);
      await expect(answerHumanRequest(nonowner,request.id,body,()=>1400)).rejects.toMatchObject({code:'unauthorized'});
      await expect(readHumanRequests(nonowner,{project_id:TEST_PROJECT})).rejects.toMatchObject({code:'unauthorized'});
    }
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('real MCP exposes durable questions and provenance-labeled answers without starting a model',async()=>{
  const f=await fixture(), app=createMcpExpressApp();let clock=1500;app.use('/v2',scoped(v2Routes(()=>clock)));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const client=new Client({name:'needs-you-test',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/v2/mcp`),{requestInit:{headers:{Authorization:`Bearer ${f.agents[0].token}`,'X-Pilot-Run':f.run.run_id}}}));
    const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args});expect(r.isError).not.toBe(true);return JSON.parse((r.content as {text:string}[])[0].text);};
    const first=await call('request_human_help',{...question,selection_mode:'multiple',suggested_options:['Continue the permitted work']});
    expect(first.request.suggestedOptions[0]).toMatchObject({trust:'untrusted',content:'Continue the permitted work'});
    const retired=await client.callTool({name:'request_human_help',arguments:{...question,dedupe_key:'retired',blocker_title:'Source access blocked'}});
    expect(retired.isError).toBe(true);
    expect(first.request.question).toMatchObject({trust:'untrusted',source:{type:'agent'},content:question.question});
    await answerHumanRequest(f.personIds[0],first.request.id,{expected_revision:1,client_request_id:'human',option_indices:[0],custom_answer:'Please continue the permitted work.'},()=>1600);
    clock=1700;
    expect(first.request.selectionMode).toBe('multiple');
    const seen=await call('list_human_requests',{status:'answered',detail:true});
    expect(seen.items[0].answer.customAnswer).toMatchObject({trust:'untrusted',source:{type:'person'},content:'Please continue the permitted work.'});
    expect(seen.items[0].answer.body).toMatchObject({trust:'untrusted',source:{type:'person',personId:f.personIds[0]},content:'Continue the permitted work\n\nPlease continue the permitted work.'});
    expect(seen.items[0].answer.acknowledged).toBeUndefined();
    const receipt=await call('acknowledge_human_answer',{request_id:first.request.id,expected_revision:2,client_request_id:'seen'});
    expect(receipt.request).toMatchObject({status:'answered',revision:3,answer:{acknowledged:{agentId:f.agents[0].agentId,runId:f.run.run_id}}});
    expect((await call('acknowledge_human_answer',{request_id:first.request.id,expected_revision:2,client_request_id:'seen'})).replayed).toBe(true);
    clock=1800;
    await call('resolve_human_request',{request_id:first.request.id,expected_revision:3,client_request_id:'done',summary:'Handled.'});
    expect((await call('list_human_requests',{status:'resolved'})).items).toHaveLength(1);
    const exported=await exportPerson(f.personIds[0],()=>1700);
    expect(exported.records.find(r=>r.path===`humanRequests/${first.request.id}`)).toBeTruthy();
    expect((await exportPerson(f.personIds[1],()=>1700)).records.some(r=>r.path===`humanRequests/${first.request.id}`)).toBe(false);
  } finally {await client.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});


test('blockers require context; suggestions are bounded, distinct and part of deduplication',async()=>{
  const f=await fixture();
  await expect(f.create({...question,context:''})).rejects.toMatchObject({code:'bad_input'});
  const options={...question,suggested_options:['Use approved mirror — quickest','Wait for access','Skip this dependent task']};
  const first=await scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,options,()=>1100));
  expect(first.request.suggestedOptions).toEqual(options.suggested_options);
  expect(humanRequestWithSource(first.request).suggestedOptions?.[0]).toMatchObject({trust:'untrusted',source:{type:'agent'},content:options.suggested_options[0]});
  expect((await scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,options,()=>1200))).deduplicated).toBe(true);
  for(const changed of [{suggested_options:['Different']},{context:'Different context'}]) {
    await expect(scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,{...options,...changed},()=>1200))).rejects.toMatchObject({code:'intent_conflict'});
  }
  for(const invalid of [['A','B','C','D'],['A',' A '],[''],['x'.repeat(81)]]) {
    await expect(scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,{...options,dedupe_key:'invalid',suggested_options:invalid},()=>1200))).rejects.toMatchObject({code:'bad_input'});
  }
});

test('option answers support optional notes, reject invalid selections, fence retries and remain answered until agent resolution',async()=>{
  const f=await fixture();
  const created=await scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,{...question,suggested_options:['Use the mirror','Wait for access']},()=>1100));
  const id=created.request.id;
  for(const bad of [{},{option_index:2},{option_index:-1},{option_index:0.5}]) {
    await expect(answerHumanRequest(f.personIds[0],id,{expected_revision:1,client_request_id:'bad',...bad},()=>1200)).rejects.toMatchObject({code:'bad_input'});
  }
  const input={expected_revision:1,client_request_id:'choose',option_index:0,body:'Only the approved mirror.'};
  const answered=await answerHumanRequest(f.personIds[0],id,input,()=>1200);
  expect(answered.request).toMatchObject({status:'answered',resolution:null,answer:{optionIndex:0,body:'Use the mirror\n\nOnly the approved mirror.'}});
  expect((await answerHumanRequest(f.personIds[0],id,input,()=>1300)).replayed).toBe(true);
  await expect(answerHumanRequest(f.personIds[0],id,{...input,option_index:1},()=>1300)).rejects.toMatchObject({code:'intent_conflict'});
  const other=await scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,{...question,dedupe_key:'option-only',suggested_options:['Wait']},()=>1400));
  expect((await answerHumanRequest(f.personIds[0],other.request.id,{expected_revision:1,client_request_id:'no-note',option_index:0},()=>1500)).request.answer).toMatchObject({body:'Wait',optionIndex:0});
});


test('multiple selections and custom answers are canonical, bounded and replayed once',async()=>{
 const f=await fixture();
 const input={...question,selection_mode:'multiple',suggested_options:['Use mirror','Export CSV','Keep notes']};
 const created=await scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,input,()=>1100));
 await expect(scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,{...input,selection_mode:'single'},()=>1100))).rejects.toMatchObject({code:'intent_conflict'});
 const answer={expected_revision:1,client_request_id:'multi',option_indices:[2,0],custom_answer:'Also verify the license.',body:'Public sources only.'};
 for(const invalid of [{option_indices:[0,0]},{option_indices:[3]},{option_indices:[1.5]},{option_index:0},{custom_answer:''},{body:'x'.repeat(2000)}]) {
  await expect(answerHumanRequest(f.personIds[0],created.request.id,{...answer,...invalid},()=>1200)).rejects.toMatchObject({code:'bad_input'});
 }
 const result=await answerHumanRequest(f.personIds[0],created.request.id,answer,()=>1200);
 expect(result.request.answer).toMatchObject({optionIndices:[0,2],customAnswer:answer.custom_answer,body:'Use mirror\nKeep notes\n\nAlso verify the license.\n\nPublic sources only.'});
 expect((await answerHumanRequest(f.personIds[0],created.request.id,{...answer,option_indices:[0,2]},()=>1300)).replayed).toBe(true);
 expect((await scope(()=>workSignalDoc(f.agents[0].agentId).get())).data()!.humanAnswerCount).toBe(1);
});

test('single selection permits one suggestion or a custom answer and rejects combinations',async()=>{
 const f=await fixture();
 const created=await scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,{...question,suggested_options:['Mirror','Wait']},()=>1100));
 expect(created.request.selectionMode).toBe('single');
 for(const invalid of [{option_indices:[0,1]},{option_indices:[0],custom_answer:'Both'},{option_indices:[]}]) {
  await expect(answerHumanRequest(f.personIds[0],created.request.id,{expected_revision:1,client_request_id:'single',...invalid},()=>1200)).rejects.toMatchObject({code:'bad_input'});
 }
 expect((await answerHumanRequest(f.personIds[0],created.request.id,{expected_revision:1,client_request_id:'single',option_indices:[],custom_answer:'Export CSV instead.'},()=>1200)).request.answer).toMatchObject({body:'Export CSV instead.',optionIndices:[],customAnswer:'Export CSV instead.'});
});


test('a request to a person is short: over-limit requests are refused, never trimmed; retired fields are refused',async()=>{
 const f=await fixture(), create=(raw:unknown)=>scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,raw,()=>1100));
 const atLimit=await create({...question,dedupe_key:'at-limit',question:'q'.repeat(140),context:'c'.repeat(300),suggested_options:['o'.repeat(80)]});
 expect(atLimit.request).toMatchObject({question:'q'.repeat(140),context:'c'.repeat(300)});
 await expect(create({...question,dedupe_key:'long-question',question:'q'.repeat(141)})).rejects.toMatchObject({code:'bad_input',message:expect.stringMatching(/140 characters \(this one has 141\)/)});
 await expect(create({...question,dedupe_key:'long-context',context:'c'.repeat(301)})).rejects.toMatchObject({code:'bad_input',message:expect.stringMatching(/300 characters \(this one has 301\)/)});
 await expect(create({...question,dedupe_key:'long-option',suggested_options:['o'.repeat(81)]})).rejects.toMatchObject({code:'bad_input'});
 for(const retired of [{attempted:'Tried the reader.'},{blocker_title:'Blocked'},{attempted_title:'Tried'}])await expect(create({...question,dedupe_key:'retired',...retired})).rejects.toMatchObject({code:'bad_input'});
});

test('requests stored before the short format keep attempted, untrusted, and never return their retired headings',async()=>{
 const f=await fixture(), {request}=await scope(()=>requestHuman(f.agents[0].agentId,f.run.run_id,question,()=>1100));
 const legacy=humanRequestWithSource({...request,attempted:'Checked the approved reader.',blockerTitle:'Reader refused',attemptedTitle:'Checked reader'} as typeof request);
 expect(legacy.attempted).toMatchObject({trust:'untrusted',source:{type:'agent'},content:'Checked the approved reader.'});
 expect(legacy).not.toHaveProperty('blockerTitle');
 expect(legacy).not.toHaveProperty('attemptedTitle');
});

test('explicit acknowledgment is requesting-agent-only, versioned, replayable, and does not change scheduling or resolution',async()=>{
 const f=await fixture(), agent=f.agents[0].agentId, request=(await f.create()).request;
 const acknowledge=(input:unknown,runId=f.run.run_id)=>scope(()=>acknowledgeHumanAnswer(agent,runId,input,()=>1300));
 const input={request_id:request.id,expected_revision:2,client_request_id:'ack'};
 await expect(acknowledge({...input,expected_revision:1})).rejects.toMatchObject({code:'intent_conflict'});
 await answerHumanRequest(f.personIds[0],request.id,{expected_revision:1,client_request_id:'answer',body:'Keep the existing settings.'},()=>1200);
 const before=(await scope(()=>workSignalDoc(agent).get())).data();
 expect((await scope(()=>readAgentHumanRequests(agent,f.run.run_id,{status:'answered'}))).items[0].answer?.acknowledged).toBeUndefined();
 await expect(scope(()=>acknowledgeHumanAnswer(f.agents[1].agentId,f.otherRun.run_id,input,()=>1300))).rejects.toMatchObject({code:'not_found'});
 await expect(acknowledge({...input,expected_revision:1})).rejects.toMatchObject({code:'intent_conflict'});
 const result=await acknowledge(input);
 expect(result.request).toMatchObject({revision:3,status:'answered',resolution:null,answer:{body:'Keep the existing settings.',acknowledged:{agentId:agent,runId:f.run.run_id,at:1300}}});
 expect((await acknowledge(input)).replayed).toBe(true);
 await expect(acknowledge({...input,expected_revision:3})).rejects.toMatchObject({code:'intent_conflict'});
 await expect(acknowledge({...input,expected_revision:3,client_request_id:'another'})).rejects.toMatchObject({code:'intent_conflict'});
 expect((await scope(()=>workSignalDoc(agent).get())).data()).toEqual(before);
 await expect(scope(()=>resolveHumanRequest(agent,f.run.run_id,{request_id:request.id,expected_revision:2,client_request_id:'resolve',summary:'Handled.'},()=>1400))).rejects.toMatchObject({code:'intent_conflict'});
 await scope(()=>resolveHumanRequest(agent,f.run.run_id,{request_id:request.id,expected_revision:3,client_request_id:'resolve',summary:'Handled.'},()=>1400));
 expect((await readHumanRequests(f.personIds[0],{status:'resolved'})).items[0].answer?.acknowledged?.at).toBe(1300);
 expect((await scope(()=>workSignalDoc(agent).get())).data()!.humanAnswerCount).toBe(0);
});

test('acknowledgment respects replaced runs, revoked membership and read-only projects, including retries',async()=>{
 const f=await fixture(), agent=f.agents[0].agentId, request=(await f.create()).request;
 await answerHumanRequest(f.personIds[0],request.id,{expected_revision:1,client_request_id:'answer',body:'Keep settings.'},()=>1200);
 const input={request_id:request.id,expected_revision:2,client_request_id:'ack'};
 const replacement=await scope(()=>startRun(agent,{clientRunId:randomUUID(),runnerVersion:'replacement',takeover:true},()=>1250));
 await expect(scope(()=>acknowledgeHumanAnswer(agent,f.run.run_id,input,()=>1300))).rejects.toMatchObject({code:'run_superseded'});
 await projects.doc(TEST_PROJECT).update({'execution.completedAt':1300,'execution.paused':true});
 await expect(scope(()=>acknowledgeHumanAnswer(agent,replacement.run_id,input,()=>1300))).rejects.toMatchObject({code:'forbidden'});
 await projects.doc(TEST_PROJECT).update({'execution.completedAt':null,'execution.paused':false});
 await scope(()=>acknowledgeHumanAnswer(agent,replacement.run_id,input,()=>1300));
 const other=(await scope(()=>requestHuman(f.agents[1].agentId,f.otherRun.run_id,{...question,dedupe_key:'other'},()=>1400))).request;
 await answerHumanRequest(f.personIds[1],other.id,{expected_revision:1,client_request_id:'other-answer',body:'Keep settings.'},()=>1450);
 await membershipDoc(TEST_PROJECT,f.personIds[1]).update({status:'removed'});
 await expect(scope(()=>acknowledgeHumanAnswer(f.agents[1].agentId,f.otherRun.run_id,{...input,request_id:other.id},()=>1500))).rejects.toMatchObject({code:'unauthorized'});
});
