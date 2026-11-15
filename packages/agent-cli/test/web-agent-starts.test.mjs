import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebAgentStarts, prepareWebCheckout, syncRepositoryAccess } from '../src/service/web-agent-starts.mjs';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createRuntimeControllers } from '../src/service/controllers.mjs';
import { createFakeAdapterFactory } from './fixtures/runtime-fake-adapter.mjs';
const principal={site:'https://example.test',ownerId:'synthetic-owner'},projectId='a'.repeat(64);
const fixture=fileURLToPath(new URL('./fixtures/runtime-fake-native.mjs',import.meta.url));
async function until(read,predicate){const deadline=Date.now()+8000;while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,15));}assert.fail('Expected synthetic start observation');}
async function setup(t,{beforeAccept,prepare,grantMs=300000,available=true,repositoryWait=async()=>({waitingFor:null,code:"ready",checkedAt:Date.now()}),folder}={}){
  const home=await mkdtemp(join(tmpdir(),'minions-web-start-')),store=await openRuntimeStore({directory:join(home,'ledger')});
  const events=join(home,'events.jsonl'),gate=join(home,'gate'),incarnation=randomUUID(),at=Date.now();
  let request={id:randomUUID(),connectionId:randomUUID(),projectId,name:'synthetic-fox',scope:'Synthetic mission, no model',minutes:5,
    execution:{provider:'claude',model:null},incarnation,state:'pending',createdAt:at,pickupByAt:at+60000,launchByAt:null,deadlineAt:null,agentId:null};
  const receipts=[],readiness=[],accepted=[];let adds=0,clones=0,accepts=0,clock=Date.now();
  const controllers=createRuntimeControllers({store,adapterFactory:createFakeAdapterFactory({command:process.execPath,args:[fixture],cwd:home,env:{PATH:process.env.PATH},initialInput:(_mission,steering)=>({events,gate,steering})})});
  const ownerClient={
    async publishRuntimeReadiness(value){readiness.push(value);return {ok:true};},
    async listAgentStarts(){return {requests:[request],serverTime:clock};},
    async listRepositoryAccess(){return {owned:[],joined:[]};},
    async acceptAgentStart(_id,input){accepted.push(input);if(input.waitingFor)return {request:{...request,waitingFor:input.waitingFor}};if(request.state==='pending')request={...request,state:'accepted',acceptedAt:clock,launchByAt:clock+180000,deadlineAt:clock+grantMs};return {request};},
    async acknowledgeAgentStart(_id,value){receipts.push(value);request={...request,state:value.state,...(value.agentId?{agentId:value.agentId}:{})};return {ok:true};},
  };
  const startOptions={home,principal,ownerClient,controllers:{...controllers,async accept(command){accepts++;if(beforeAccept)await beforeAccept(command);return controllers.accept(command);}},incarnation,intervalMs:600000,now:()=>clock,
    capabilities:async()=>[{id:'claude',available,reason:available?'ready':'unavailable'}],
    githubSignIn:async()=>'ready',
    async addAgent(args,_client,options){adds++;if(options.webStartId)request={...request,agentId:'synthetic-agent'};return {record:{webStartId:options.webStartId,ownerProfileId:principal.ownerId,agentName:args.agent_name,agentId:'synthetic-agent',service:`${principal.site}/p/${projectId}`,folder:folder??home,repo:'https://github.com/example/synthetic'}};},
    async prepareCheckout(record,options){clones++;await prepare?.(record,options);},
    repositoryWait,
  };
  let pump=createWebAgentStarts(startOptions);
  t.after(async()=>{await pump.close();await controllers.close();await store.close();await rm(home,{recursive:true,force:true});});
  return {home,store,controllers,receipts,readiness,accepted,gate,events,get request(){return request;},get counts(){return {adds,clones,accepts};},
    async poll(){clock=Date.now();await pump.poll();},setClock(value){clock=value;},async tick(){await pump.poll();},
    async reboot(){await pump.close();pump=createWebAgentStarts({...startOptions,incarnation:randomUUID()});},
    async closePump(){await pump.close();},setRequest(value){request=value;}};
}

test('empty installation publishes readiness; actual fake execution acknowledgement gates Working and exact retry never duplicates',async t=>{
  const f=await setup(t);
  await until(()=>f.receipts,r=>r.some(v=>v.state==='starting'));
  const ref={missionId:f.request.id,target:{...principal,projectId,agentId:'synthetic-agent'}};
  await until(()=>f.controllers.getMission(ref),m=>m?.currentTurnStage==='submitted');
  assert.equal(f.receipts.some(v=>v.state==='working'),false);
  await writeFile(f.gate,'go');
  await until(()=>f.controllers.getMission(ref),m=>m?.currentTurnStage==='applied'||m?.outcomes.some(o=>o.outcome.delivery==='acknowledged'));
  await f.poll();await until(()=>f.receipts,r=>r.some(v=>v.state==='working'));
  // Cloned while waiting, then checked again at launch.
  assert.equal(f.readiness[0].protocol,1);assert.deepEqual(f.counts,{adds:1,clones:2,accepts:1});
  await f.poll();assert.deepEqual(f.counts,{adds:1,clones:2,accepts:1});
  assert.equal((await readFile(f.events,'utf8')).trim().split('\n').length,1);
  await writeFile(f.gate,'go');
});

test('a run whose first turn misses its launch window is reported expired, not starting forever',async t=>{
  const f=await setup(t);
  await until(()=>f.receipts,r=>r.some(v=>v.state==='starting'));
  f.setClock(f.request.launchByAt+1);await f.tick();
  await until(()=>f.receipts,r=>r.some(v=>v.state==='expired'&&v.code==='request_expired'));
  await writeFile(f.gate,'go');
});

test('a start whose preparation crosses the job\'s end time comes up waiting for more time instead of expiring',async t=>{
  // The job had a moment left when the start was accepted; the clone takes longer.
  let f;f=await setup(t,{grantMs:200,prepare:async()=>{await new Promise(r=>setTimeout(r,400));f.setClock(Date.now());}});
  await until(()=>f.receipts,r=>r.some(v=>v.state==='working'));
  assert.equal(f.counts.accepts,1,'the controller received the start');
  assert.equal(f.receipts.some(v=>['expired','failed','recovery_required'].includes(v.state)),false);
  const mission=await f.controllers.getMission({missionId:f.request.id,target:{...principal,projectId,agentId:'synthetic-agent'}});
  assert.ok(mission.deadlineAt<=Date.now());
  assert.ok(!['failed','stopped','blocked','recovery_required'].includes(mission.state));
  assert.equal(mission.currentTurnId,null,'no turn starts while the time is up');
});

for(const [reason,label] of [['github','without GitHub access'],['empty_repository','for an empty repository']])test(`a start ${label} waits and starts when the repository is ready`,async t=>{
  const folder=await mkdtemp(join(tmpdir(),'minions-web-start-folder-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  let access=false;const f=await setup(t,{folder,repositoryWait:async()=>({waitingFor:access?null:reason,code:access?'ready':reason==='github'?'git_authentication_failed':'empty_repository',checkedAt:Date.now()})});
  await until(()=>f.accepted,a=>a.some(v=>v.waitingFor===reason));
  assert.equal(f.request.state,'pending');assert.deepEqual(f.receipts,[]);assert.equal(f.counts.clones,0);
  await f.tick();assert.equal(f.accepted.filter(v=>v.waitingFor).length,1,'rechecks at most once a minute');
  access=true;f.setRequest({...f.request,pickupByAt:Date.now()+600000});f.setClock(Date.now()+61000);
  await until(async()=>{await f.tick();return f.receipts;},r=>r.some(v=>v.state==='starting'));
  assert.equal(f.counts.clones,2,'cloned while waiting, then checked again at launch');
  await writeFile(f.gate,'go');
});

test('an empty agent folder is cloned before the start is accepted, outside the launch window',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'minions-web-start-folder-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const before=[];const f=await setup(t,{folder,prepare:()=>{before.push(f.accepted.length);}});
  await until(()=>f.receipts,r=>r.some(v=>v.state==='starting'));
  assert.equal(before[0],0,'the first clone runs before any acceptance');
  await writeFile(f.gate,'go');
});

test('a failed clone while waiting keeps the start pending and tries again about a minute later',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'minions-web-start-folder-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  let fail=true;const f=await setup(t,{folder,prepare:()=>{if(fail)throw Object.assign(new Error('synthetic clone timeout'),{code:'preparation_failed'});}});
  await until(()=>f.counts,c=>c.clones===1);await f.tick();
  assert.equal(f.counts.clones,1);assert.equal(f.request.state,'pending');assert.deepEqual(f.receipts,[]);
  fail=false;f.setRequest({...f.request,pickupByAt:Date.now()+600000});f.setClock(Date.now()+61000);
  await until(async()=>{await f.tick();return f.receipts;},r=>r.some(v=>v.state==='starting'));
  await writeFile(f.gate,'go');
});

// The fake gh is a shell script; Windows runs the same code against real gh.exe.
test('repository access adds only missing members and accepts only invitations to joined project repositories',{skip:process.platform==='win32'},async t=>{
  const bin=await mkdtemp(join(tmpdir(),'minions-fake-gh-'));t.after(()=>rm(bin,{recursive:true,force:true}));
  await writeFile(join(bin,'gh'),`#!/bin/sh\n[ "$2" = --method ] && echo "$3 $4" >> "${bin}/calls" && exit 0\ncase "$3" in */collaborators) echo Alice;; */invitations) echo bob;; user/*) printf '7\\thttps://github.com/example/other\\n9\\thttps://github.com/Example/Synthetic\\n';; esac\n`,{mode:0o755});
  const path=process.env.PATH;process.env.PATH=`${bin}:${path}`;t.after(()=>{process.env.PATH=path;});
  await syncRepositoryAccess({owned:[{repo:'https://github.com/example/mine',usernames:['alice','bob','carol']}],joined:['https://github.com/example/synthetic']});
  assert.deepEqual((await readFile(join(bin,'calls'),'utf8')).trim().split('\n'),['PUT repos/example/mine/collaborators/carol','PATCH user/repository_invitations/9']);
});

test('expiry after slow preparation prevents controller submission',async t=>{
  // The first call clones while waiting; the second is the launch-time check.
  let release,calls=0;const block=new Promise(r=>{release=r;});const f=await setup(t,{prepare:()=>++calls===2?block:undefined});
  await until(()=>f.counts,c=>c.clones===2);f.setClock(f.request.launchByAt+1);release();
  await until(()=>f.receipts,r=>r.some(v=>v.state==='expired'));
  assert.equal(f.counts.accepts,0);assert.deepEqual(await f.store.listMissionSummaries({...principal,limit:10}),{version:2,missions:[],next:null});
});

test('a previous service incarnation cannot provision or start an accepted request',async t=>{
  const f=await setup(t,{available:false});await until(()=>f.receipts,r=>r.length>0);await f.closePump();
  f.setRequest({...f.request,id:randomUUID(),name:'other-fox',state:'accepted',incarnation:randomUUID(),launchByAt:Date.now()+180000,deadlineAt:Date.now()+300000});
  const previous=f.counts;await f.reboot();await until(()=>f.receipts,r=>r.some(v=>v.state==='recovery_required'));
  assert.deepEqual(f.counts,previous);
});

test('unknown controller acceptance preserves recovery evidence and cannot submit again after restart',async t=>{
  const f=await setup(t,{beforeAccept:()=>{throw Object.assign(new Error('Synthetic lost acceptance'),{code:'storage_failure'});}});
  await until(()=>f.receipts,r=>r.some(v=>v.state==='recovery_required'));
  const saved=JSON.parse(await readFile(join(f.home,'web-starts',`${f.request.id}.json`),'utf8'));
  assert.equal(saved.command.operationId,f.request.id);assert.equal(saved.command.payload.deadlineAt,f.request.deadlineAt);
  const previous=f.counts;f.setRequest({...f.request,state:'accepted'});await f.reboot();
  await until(()=>f.receipts,r=>r.filter(v=>v.state==='recovery_required').length>=2);assert.deepEqual(f.counts,previous);
});

test('checkout preparation rejects noncanonical repositories without launching Git or deleting files',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'minions-unsafe-web-checkout-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  await writeFile(join(folder,'keep.txt'),'preserve');
  await assert.rejects(prepareWebCheckout({folder,repo:'https://evil.example/owner/repo'}),{code:'preparation_failed'});
  assert.equal(await readFile(join(folder,'keep.txt'),'utf8'),'preserve');
});

test('cloud connection health records successful contact, staleness, outage and recovery independently of local execution',async t=>{
  const home=await mkdtemp(join(tmpdir(),'minions-cloud-health-'));let clock=Date.now(),offline=false;
  const pump=createWebAgentStarts({home,principal,controllers:{},addAgent:async()=>assert.fail('No agents may be added'),intervalMs:600000,now:()=>clock,
    capabilities:async()=>[],githubSignIn:async()=>'ready',syncAccess:async()=>{},
    ownerClient:{publishRuntimeReadiness:async()=>{if(offline)throw new Error('synthetic network outage');return {ok:true};},listAgentStarts:async()=>({requests:[],serverTime:clock}),listRepositoryAccess:async()=>({owned:[],joined:[]})},
  });
  t.after(async()=>{await pump.close();await rm(home,{recursive:true,force:true});});
  await pump.poll();const first=pump.status();assert.equal(first.state,'connected');assert.equal(first.lastSuccessAt,clock);
  clock+=46000;assert.equal(pump.status().state,'stale');
  offline=true;await assert.rejects(pump.poll(),/outage/);assert.equal(pump.status().state,'unavailable');assert.equal(pump.status().lastSuccessAt,first.lastSuccessAt);
  offline=false;clock+=1000;await pump.poll();assert.deepEqual(pump.status(),{state:'connected',lastSuccessAt:clock,lastAttemptAt:clock});
});
