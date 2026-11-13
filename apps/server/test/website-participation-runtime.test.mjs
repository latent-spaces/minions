import { sharedLinkRoutes } from '../src/shared-links.js';
// Real owner/browser APIs + SQLite participation coordinator; synthetic clients only.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { beforeEach, afterEach, expect, test } from 'vitest';
import { ownerRoutes, participationSnapshotParser } from '../src/owner/routes.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { projectManagementRoutes, projectRuntimeRoutes } from '../src/projects/routes.js';
import { runs } from '../src/v2/records.js';
import { assertCurrentRun } from '../src/v2/runs.js';
import { inProject } from '../src/firestore.js';
import { resetEmulator, seed, idTokenFor, TEST_PROJECT, seedApprovedProject, addAgent } from './helpers.js';
import { createOwnerClient } from '../../../packages/agent-cli/src/owner-client.mjs';
import { openRuntimeStore } from '../../../packages/agent-cli/src/service/store.mjs';
import { createCloudRuntime } from '../../../packages/agent-cli/src/service/cloud-runtime.mjs';

let server, base, root, store, runtime, serverOffset = 0;
const serverNow = () => Date.now() + serverOffset;
const site = 'http://127.0.0.1:8787', secondProject = 'b'.repeat(64);
beforeEach(async () => {
  await resetEmulator(); serverOffset = 0; root = await mkdtemp(join(tmpdir(), 'mlswarm-web-participation-'));
  const app = express();
  app.use('/api/owner/participations/sync',participationSnapshotParser('127.0.0.1'));
  app.use(createMcpExpressApp({host:'127.0.0.1'}));
  app.use(sharedLinkRoutes(serverNow));
  app.use('/api/owner', ownerRoutes(serverNow, { selfHosted: () => true }));
  app.use('/api/projects', projectManagementRoutes(serverNow));
  app.use('/p/:projectId', projectRuntimeRoutes(serverNow));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await runtime?.close(); await store?.close(); runtime = store = undefined;
  server?.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});
async function browser(token, path, body, profileId) {
  const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${token}`, 'content-type':'application/json', ...(profileId ? {'X-Mlswarm-Profile-Id':profileId}:{}),
  }, ...(body ? {body:JSON.stringify(body)}:{}) });
  return {status:response.status,body:await response.json()};
}
async function fixture() {
  const f = await seed({ profiles:[{name:'Synthetic owner',email:'owner@example.test'}], agents:[{person:0,name:'Synthetic Claude chat'}] });
  const ownerId=f.personIds[0], firebase=await idTokenFor('owner@example.test');
  await seedApprovedProject(secondProject,{ownerProfileId:ownerId,required:false,
    definition:{title:'Synthetic second project',goal:'Test isolation',beneficiaries:'Tests',output:'Evidence',scope:'No models',acceptanceCriteria:'Assertions',sources:null,resources:null,mergeApproval:'humans'}});
  const second=await inProject(secondProject,()=>addAgent(ownerId,'Synthetic Codex chat',Date.now));
  const fetchImpl=(url,options)=>{const original=new URL(url);if(original.origin!==site)throw new Error('Unexpected transport origin'); return fetch(base+original.pathname+original.search,options);};
  // This test server has no local-owner session route, so the owner's test sign-in stands in for it.
  const ownerClient=createOwnerClient({home:join(root,'owner-private'),workspace:join(root,'workspace'),site,fetchImpl,ownerSession:async()=>firebase});
  expect((await ownerClient.connect('Synthetic shared service')).status).toBe('approved');
  const bindings=[];
  for(const [index,agent] of [f.agents[0],second].entries()){
    const projectId=index?secondProject:TEST_PROJECT,folder=join(root,`checkout-${index}`),stateDir=join(root,`private-${index}`);
    await mkdir(folder);await mkdir(stateDir,{mode:0o700});
    bindings.push({target:{site,ownerId,projectId,agentId:agent.agentId},url:`${site}/p/${projectId}`,token:agent.token,folder,stateDir,fetchImpl});
  }
  let starts=0;
  const startRuntime=async()=>{
  store=await openRuntimeStore({directory:join(root,'ledger')});
  runtime=createCloudRuntime({store,cloudBindings:[],participationBindings:bindings,ownerControlsClient:ownerClient,
    adapterFactory:async()=>{starts++;throw new Error('No model execution permitted');},ownerControlIntervalMs:60000,deliveryIntervalMs:60000});
  };
  await startRuntime();
  return {ownerClient,bindings,firebase,ownerId,get starts(){return starts;}};
}
const query=record=>({target:record.target,participationId:record.participationId});
async function claim(binding){const approvedAt=Date.now();return (await runtime.participation.command({version:1,operationId:randomUUID(),kind:'claim',target:binding.target,participationId:randomUUID(),payload:{approved:true,approvedAt,deadlineAt:approvedAt+300000,scope:'Synthetic owned chat participation; no model runs.'}})).participation;}
async function until(read,predicate){const stop=Date.now()+8000;while(Date.now()<stop){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for real shared boundary');}
// Construction starts an asynchronous poll that may snapshot the store before claim.
// A joined poll is not proof the exact new participation has reached the website.
async function websiteReady(f,records){
  for(const record of records) await until(async()=>{
    await runtime.ownerControls.poll();
    return browser(f.firebase,`/projects/${record.target.projectId}/my-workers`);
  },reply=>reply.status===200&&reply.body.agents?.some(agent=>agent.agentId===record.target.agentId&&agent.participation?.participationId===record.participationId));
}
const input=(record,kind,minutes)=>({id:randomUUID(),kind,participationId:record.participationId,generation:record.generation,expectedDeadlineAt:record.deadlineAt,approved:true,...(minutes?{minutes}:{})});

test('website Extend, End and Wake reach one idle shared runtime across two chat projects without native starts',async()=>{
  const f=await fixture();const [first,other]=await Promise.all(f.bindings.map(claim));
  await websiteReady(f,[first,other]);
  const path=`/projects/${first.target.projectId}/agents/${first.target.agentId}/participation`;
  const extension=input(first,'extend',5);
  const saved=await browser(f.firebase,path,extension,f.ownerId);expect(saved.status).toBe(200);
  expect(saved.body.participation.pending.state).toBe('queued');
  expect((await browser(f.firebase,path,extension,f.ownerId)).body.replayed).toBe(true);
  await runtime.ownerControls.poll();
  const extended=await until(()=>runtime.participation.get(query(first)),v=>v.deadlineAt===first.deadlineAt+300000&&v.cloudRun.deadlineAt===v.deadlineAt);
  await until(()=>f.ownerClient.listParticipationControls({expectedProfileId:f.ownerId}),v=>v.commands.length===0);
  expect((await runtime.participation.get(query(other))).deadlineAt).toBe(other.deadlineAt);
  const ending=input(extended,'release');
  expect((await browser(f.firebase,path,ending,f.ownerId)).status).toBe(200);
  await expect(inProject(first.target.projectId,()=>assertCurrentRun(first.target.agentId,first.participationId))).rejects.toMatchObject({code:'run_superseded'});
  await runtime.ownerControls.poll();
  const ended=await until(()=>runtime.participation.get(query(first)),v=>v.state==='released');
  await until(()=>f.ownerClient.listParticipationControls({expectedProfileId:f.ownerId}),v=>v.commands.length===0);
  const wake=input(ended,'wake',5);
  expect((await browser(f.firebase,path,wake,f.ownerId)).status).toBe(200);
  await runtime.ownerControls.poll();
  const fresh=await until(()=>store.latestParticipationsForTargets({targets:[first.target]}),v=>v[0]?.participationId!==first.participationId&&v[0]?.state==='active');
  expect(fresh[0].participationRef).not.toBe(first.participationRef);
  await expect(store.resolveParticipation({site,ownerId:f.ownerId,participationRef:first.participationRef})).rejects.toMatchObject({code:'participation_inactive'});
  expect((await runtime.participation.get(query(other))).state).toBe('active');
  expect((await inProject(first.target.projectId,()=>runs().doc(first.target.agentId).get())).data().runId).toBe(fresh[0].participationId);
  expect(f.starts).toBe(0);
},20000);


test('a website Wake approved while the device was offline expires at approval time without registration',async()=>{
  const f=await fixture(), binding=f.bindings[0];
  const deadlineAt=Date.now()-20*60_000;
  const ended=(await runtime.participation.command({version:1,operationId:randomUUID(),kind:'claim',target:binding.target,
    participationId:randomUUID(),payload:{approved:true,approvedAt:deadlineAt-300000,deadlineAt,scope:'Expired synthetic offline participation.'}})).participation;
  expect(ended.state).toBe('expired');
  await until(async()=>{await runtime.ownerControls.poll();return browser(f.firebase,`/projects/${ended.target.projectId}/my-workers`);},reply=>reply.body.agents?.some(agent=>agent.participation?.participationId===ended.participationId));
  // Approval happened ten minutes before this device reconnects. Its five-minute
  // allowance must not be rebased onto the device's later processing time.
  serverOffset=-10*60_000;
  const path=`/projects/${ended.target.projectId}/agents/${ended.target.agentId}/participation`;
  const request=input(ended,'wake',5), saved=await browser(f.firebase,path,request,f.ownerId);
  expect(saved.status).toBe(200);
  expect(saved.body.participation.pending.deadlineAt).toBeLessThan(Date.now());
  await runtime.ownerControls.poll();
  const fresh=await until(()=>store.latestParticipationsForTargets({targets:[ended.target]}),rows=>rows[0]?.participationId!==ended.participationId);
  expect(fresh[0].state).toBe('expired');expect(fresh[0].cloudRun).toBeNull();
  expect((await inProject(ended.target.projectId,()=>runs().get())).size).toBe(0);
  const replay=await browser(f.firebase,path,request,f.ownerId);
  expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);
  expect(replay.body.participation.pending.deadlineAt).toBe(saved.body.participation.pending.deadlineAt);
  expect(f.starts).toBe(0);
},20000);

test('snapshot body allowance precedes the SDK parser while loopback Host and ordinary owner limits remain enforced',async()=>{
  const f=await fixture();
  // The duplicate-target validation must run AFTER parsing this >100 KiB batch.
  // It is invalid synthetic input; this proves middleware ordering, not capacity.
  const target=f.bindings[0].target,approvedAt=Date.now();
  const snapshot={target,participationId:randomUUID(),generation:1,state:'expired',approvedAt,deadlineAt:approvedAt,
    scope:'x'.repeat(8000),cloudRun:null};
  const oversized=JSON.stringify({participations:Array.from({length:16},()=>snapshot)});
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(100*1024);
  const clientFetch=async(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body});
  // Fetch controls its own Host header; use HTTP's explicit header port here.
  const rejectedHost=await new Promise((resolve,reject)=>{
    const req=httpRequest(base+'/api/owner/participations/sync',{method:'POST',headers:{host:'attacker.test','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end('{');
  });
  expect(rejectedHost).toBe(403);
  // Use the trusted authenticated client so ordinary owner auth remains real.
  await expect(f.ownerClient.syncParticipations(JSON.parse(oversized),{expectedProfileId:f.ownerId})).rejects.toThrow('Publish each agent once');
  const tooLarge=await clientFetch('/api/owner/local-computer',JSON.stringify({synthetic:'x'.repeat(20*1024)}));
  expect(tooLarge.status).toBe(413);
  const overSnapshotLimit=await clientFetch('/api/owner/participations/sync',JSON.stringify({synthetic:'x'.repeat(301*1024)}));
  expect(overSnapshotLimit.status).toBe(413);
  expect(f.starts).toBe(0);
},20000);
