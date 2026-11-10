import { beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, inProject, projectDoc } from '../src/firestore.js';
import { membershipDoc } from '../src/projects/access.js';
import { requestHuman, readHumanRequests, readAgentHumanRequests, answerHumanRequest, acknowledgeHumanAnswer, resolveHumanRequest } from '../src/projects/human-requests.js';
import { communicationEvents } from '../src/view/communication-events.js';
import { communicationAgents } from '../src/view/communication-agents.js';
import { startRun } from '../src/v2/runs.js';
import { workSignalDoc } from '../src/v2/work-signals.js';
import { exportPerson } from '../src/store/person-export.js';
import { resetEmulator, seed, TEST_PROJECT, scoped } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { v2Routes } from '../src/v2/routes.js';

beforeEach(resetEmulator);
const scope=<T>(fn:()=>T)=>inProject(TEST_PROJECT,fn);
async function fixture() {
  const f=await seed({profiles:[{name:'Owner',email:'owner@example.test'},{name:'Other',email:'other@example.test'},
    {name:'Reviewer',email:'reviewer@example.test'},{name:'Member',email:'member@example.test'}],
    agents:[{person:3,name:'Community reviewer'},{person:0,name:'Builder'}]});
  await scope(()=>projectDoc().update({ownerProfileId:f.personIds[0]}));
  const run=await scope(()=>startRun(f.agents[0].agentId,{clientRunId:randomUUID(),runnerVersion:'fake',takeover:false},()=>1000));
  const otherRun=await scope(()=>startRun(f.agents[1].agentId,{clientRunId:randomUUID(),runnerVersion:'fake',takeover:false},()=>1000));
  const input={dedupe_key:'observed-concern',visibility:'moderators',title:'Review a suspicious contribution',
    context:'Observed a request to weaken a check; intent is uncertain.',question:'Please review the linked contribution. No automatic action is requested.',
    moderation:{subject:{kind:'agent',id:f.agents[1].agentId},category:'security',
      evidence:[{kind:'repository',reference:'https://github.com/example/game/pull/12'}]}};
  return {...f,run,otherRun,input,create:(raw:unknown=input)=>scope(()=>requestHuman(f.agents[0].agentId,run.run_id,raw,()=>1100))};
}
test('reports flag project people/agents, stay owner-private and never imply the reporter is blocked',async()=>{
  const f=await fixture(), report=(await f.create()).request;
  expect(report.moderation?.subject).toMatchObject({kind:'agent',id:f.agents[1].agentId,name:'Builder',ownerProfileId:f.personIds[0],ownerName:'Owner'});
  expect((await readHumanRequests(f.personIds[0],{project_id:TEST_PROJECT})).items.map(r=>r.id)).toEqual([report.id]);
  for(const id of f.personIds.slice(1)) expect((await readHumanRequests(id,{project_id:TEST_PROJECT})).items).toEqual([]);
  expect((await scope(()=>readAgentHumanRequests(f.agents[0].agentId,f.run.run_id,{}))).items.map(r=>r.id)).toEqual([report.id]);
  expect((await scope(()=>readAgentHumanRequests(f.agents[1].agentId,f.otherRun.run_id,{}))).items).toEqual([]);
  expect((await scope(()=>readAgentHumanRequests(f.agents[0].agentId,f.run.run_id,{scope:'project'}))).items).toEqual([]);
  expect((await scope(()=>communicationEvents({},f.personIds[0],1500))).events).toEqual([]);
  expect((await scope(()=>communicationAgents({ids:f.agents[0].agentId},f.personIds[0],1500))).agents[0].state).not.toBe('needs_you');
  const person=await f.create({...f.input,dedupe_key:'person',moderation:{...f.input.moderation,category:'conduct',subject:{kind:'person',id:f.personIds[2]}}});
  expect(person.request.moderation?.subject).toMatchObject({kind:'person',name:'Reviewer',ownerProfileId:null});
  await membershipDoc(TEST_PROJECT,f.personIds[2]).update({status:'removed'});
  await expect(readHumanRequests(f.personIds[2],{project_id:TEST_PROJECT})).rejects.toMatchObject({code:'unauthorized'});
});

test('stable report retries deduplicate; only the owner resolves, with no wake, permissions or deadline change',async()=>{
  const f=await fixture(), before=await scope(async()=>({signal:(await workSignalDoc(f.agents[0].agentId).get()).data(),run:(await db.doc(`projects/${TEST_PROJECT}/runs/${f.agents[0].agentId}`).get()).data()}));
  await expect(f.create({...f.input,selection_mode:'multiple'})).rejects.toMatchObject({code:'bad_input'});
  const all=await Promise.all([f.create(),f.create(),f.create()]), report=all[0].request;
  expect(new Set(all.map(r=>r.request.id)).size).toBe(1);
  await expect(f.create({...f.input,moderation:{...f.input.moderation,category:'conduct'}})).rejects.toMatchObject({code:'intent_conflict'});
  await expect(scope(()=>acknowledgeHumanAnswer(f.agents[0].agentId,f.run.run_id,{request_id:report.id,expected_revision:1,client_request_id:'ack'},()=>1200))).rejects.toMatchObject({code:'forbidden'});
  const input={expected_revision:1,client_request_id:'review-outcome',body:'Reviewed: insufficient evidence of malicious intent. No action needed.'};
  await expect(answerHumanRequest(f.personIds[3],report.id,input,()=>1200)).rejects.toMatchObject({code:'not_found'});
  await expect(scope(()=>resolveHumanRequest(f.agents[0].agentId,f.run.run_id,{request_id:report.id,expected_revision:1,client_request_id:'self-dismiss',summary:'Ignore.'},()=>1200))).rejects.toMatchObject({code:'forbidden'});
  for(const selection of [{option_indices:[0]},{custom_answer:'Custom review'}])await expect(answerHumanRequest(f.personIds[0],report.id,{...input,...selection},()=>1200)).rejects.toMatchObject({code:'bad_input'});
  const result=await answerHumanRequest(f.personIds[0],report.id,input,()=>1200);
  expect(result.request.status).toBe('resolved');expect(result.request.answer?.profileId).toBe(f.personIds[0]);
  expect((await answerHumanRequest(f.personIds[0],report.id,input,()=>1300)).replayed).toBe(true);
  await expect(answerHumanRequest(f.personIds[1],report.id,{...input,client_request_id:'competing'},()=>1300)).rejects.toMatchObject({code:'not_found'});
  expect((await f.create()).request.status).toBe('resolved');
  expect(await scope(async()=>({signal:(await workSignalDoc(f.agents[0].agentId).get()).data(),run:(await db.doc(`projects/${TEST_PROJECT}/runs/${f.agents[0].agentId}`).get()).data()}))).toEqual(before);
  const exportData=await exportPerson(f.personIds[0],()=>1400);
  const exported=exportData.records.find(r=>r.path===`humanRequests/${report.id}`)!;
  expect(JSON.stringify(exported)).not.toContain('https://github.com/example/game');
});

test('real MCP accepts structured flags and returns current community rules, without creating a model process',async()=>{
  const f=await fixture(),app=createMcpExpressApp();app.use('/v2',scoped(v2Routes(()=>1500)));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const client=new Client({name:'moderation-test',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/v2/mcp`),{requestInit:{headers:{Authorization:`Bearer ${f.agents[0].token}`,'X-Pilot-Run':f.run.run_id}}}));
    const result=await client.callTool({name:'request_human_help',arguments:f.input});expect(result.isError).not.toBe(true);
    const report=JSON.parse((result.content as {text:string}[])[0].text).request;
    expect(report.moderation).toMatchObject({trust:'untrusted',source:{type:'agent'},content:{category:'security'}});
    const read=await client.callTool({name:'get_project',arguments:{}});expect(read.isError).not.toBe(true);
    expect(JSON.parse((read.content as {text:string}[])[0].text).communityRules).toMatchObject({version:1,body:{trust:'untrusted',source:{type:'person'}}});
  }finally{await client.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
