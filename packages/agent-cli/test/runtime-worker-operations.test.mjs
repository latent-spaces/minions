import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';
import { createWorkerOperations } from '../src/service/worker-operations.mjs';
import { createWorkerGuidance } from '../src/worker-guidance.mjs';
import { readBundledGuide } from '../src/skill-bundle.mjs';
import { readPrivate, writePrivate } from '../src/state.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'mlswarm-worker-operations-'));
  const folder=join(root,'repo'),stateDir=join(root,'private');
  await mkdir(folder);await mkdir(stateDir,{mode:0o700});
  t.after(()=>rm(root,{recursive:true,force:true}));
  const target={site:'http://127.0.0.1:8787',ownerId:'owner',projectId:'project',agentId:'agent'};
  const caller={kind:'worker',target,missionId:randomUUID(),generation:1};
  const mission={target,missionId:caller.missionId,generation:1,state:'running',currentTurnId:randomUUID(),deadlineAt:Date.now()+60000};
  const missionDir=join(stateDir,`mission-${caller.missionId}-${caller.generation}`);
  await mkdir(missionDir,{mode:0o700});
  const core='Synthetic worker core';
  writePrivate(join(missionDir,'instructions.md'),core);
  writePrivate(join(missionDir,'worker-guides.json'),createWorkerGuidance({core,guideRevision:1,
    sections:Object.fromEntries(['project-work','updates-and-help'].map(section=>[section,readBundledGuide(section)]))}));
  const calls=[];let mismatch=false,refusal=null,enabled=true,catalogFailure=false,beforeReply,tasks;
  const context=()=>({project:{started:true,paused:false,completedAt:null,name:'Test',mission:'Smoke',rules:'No cloud changes',repoUrl:'https://github.com/test/repo',mergeApproval:'humans'},you:{agentId:mismatch?'other':'agent',participation:{identity:{projectId:'project',agentId:'agent',profileId:mismatch?'other':'owner'},persona:{text:'',revision:0},observedAt:Date.now()}},...(tasks?{tasks}:{})});
  const fetchImpl=async(url,options)=>{
    const rpc=JSON.parse(options.body);calls.push({url,options,rpc});
    await beforeReply?.(rpc);
    if (refusal && rpc.params?.name !== 'get_project') return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,...refusal}),{status:200});
    if (rpc.method==='tools/list') return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,...(catalogFailure ? {error:{code:-1,message:'Unavailable'}} : {result:{tools:[...['get_project','list_tasks','get_task','read_teams',...(enabled?['comment_task','manage_team']:[])].map(name=>({name})),{name:'list_my_projects'},{name:'unbundled_tool'}]}})}));
    const value=rpc.params.name==='get_project'?context():{ok:true};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(value)}]}}),{status:200});
  };
  const store={getMission:async()=>structuredClone(mission)};
  const binding={url:'http://127.0.0.1:8787/p/project',token:'test-secret',folder,stateDir};
  const ops=createWorkerOperations({store,resolveBinding:async()=>binding,fetchImpl});
  t.after(()=>ops.release(caller));
  return {caller,mission,calls,ops,missionDir,binding,store,fetchImpl,set mismatch(v){mismatch=v},set refusal(v){refusal=v},set enabled(v){enabled=v},set catalogFailure(v){catalogFailure=v},set beforeReply(v){beforeReply=v},set tasks(v){tasks=v}};
}

test('queued worker operations recheck that the worker is still live before remote I/O; a passed end time alone does not refuse them', async t => {
  const f=await fixture(t);
  await f.ops.callTool(f.caller,'get_project',{});
  let release, entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  t.after(()=>release());
  f.beforeReply=async()=>{entered();await gate;};
  const admitted=f.ops.callTool(f.caller,'read_agent_inbox',{});
  await started;
  const remoteCalls=f.calls.length;
  const queued=Promise.allSettled([
    f.ops.callTool(f.caller,'read_agent_inbox',{}),
    f.ops.listTools(f.caller),
  ]);
  const liveState=f.mission.state;
  f.mission.state='stopped';
  release();
  await admitted;
  for(const result of await queued) {
    assert.equal(result.status,'rejected');
    assert.equal(result.reason.code,'worker_inactive');
  }
  assert.equal(f.calls.length,remoteCalls,'queued operations of a stopped worker must not reach the remote project');
  await assert.rejects(f.ops.callTool(f.caller,'get_project',{}),{code:'worker_inactive'});
  f.beforeReply=undefined;
  // A turn finishing past the job's end time keeps its tools.
  f.mission.state=liveState;f.mission.deadlineAt=Date.now()-1;
  assert.deepEqual(await f.ops.deliveryState(f.caller),{pending:0,notices:[]});
  await f.ops.callTool(f.caller,'read_agent_inbox',{});
  assert.equal(f.calls.length,remoteCalls+1,'a passed end time does not refuse a live turn');
});

test('worker facade retains protocol refusal diagnostics and valid text errors', async t => {
  const f=await fixture(t);
  await f.ops.callTool(f.caller,'get_project',{});
  const page={limit:2,search:'parser',status:'backlog',assigned_agent_id:null,cursor:'task_previous'};
  await f.ops.callTool(f.caller,'list_tasks',page);
  assert.deepEqual(f.calls.at(-1).rpc.params.arguments,page);
  f.refusal={error:{code:-32602,message:'Tool list_tasks not found',data:{token:'test-secret'}}};
  const response=await f.ops.callTool(f.caller,'list_tasks',{});
  assert.equal(response.isError,true);
  assert.deepEqual(JSON.parse(response.content[0].text),{error:{code:-32602,message:'Tool list_tasks not found'}});
  f.refusal={result:{isError:true,content:[{type:'text',text:'intent_conflict: reread task'}]}};
  assert.equal((await f.ops.callTool(f.caller,'list_tasks',{})).content[0].text,'intent_conflict: reread task');
});

test('worker operations verify exact participant every turn and reject selectors or owner tools',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.ops.callTool(f.caller,'read_agent_inbox',{}),e=>e.code==='identity_unverified');
  await assert.rejects(f.ops.callTool(f.caller,'get_project',{connection_ref:'other'}),e=>e.code==='bad_input');
  assert.equal(f.calls.length,0);f.mismatch=true;
  await assert.rejects(f.ops.callTool(f.caller,'get_project',{}),e=>e.code==='identity_mismatch');
  await assert.rejects(f.ops.callTool(f.caller,'read_agent_inbox',{}),e=>e.code==='identity_unverified');
  f.mismatch=false;await f.ops.callTool(f.caller,'get_project',{});await f.ops.callTool(f.caller,'read_agent_inbox',{});
  assert.equal(f.calls.at(-1).options.redirect,'error');assert.equal(f.calls.at(-1).options.headers['x-pilot-run'],f.caller.missionId);
  f.mission.currentTurnId=randomUUID();await assert.rejects(f.ops.callTool(f.caller,'read_agent_inbox',{}),e=>e.code==='identity_unverified');
  assert.equal((await f.ops.prepareParticipation(f.caller)).identity.agentId,'agent');
  // Task counts from get_project reach the turn; a malformed or absent value is dropped, never guessed.
  assert.equal((await f.ops.prepareParticipation(f.caller)).taskCounts,null);
  f.tasks={enabled:true,counts:{assignedToYouOpen:1,unassignedBacklog:4}};
  assert.deepEqual((await f.ops.prepareParticipation(f.caller)).taskCounts,{assignedToYouOpen:1,unassignedBacklog:4});
  f.tasks={enabled:true,counts:{assignedToYouOpen:-1,unassignedBacklog:4}};
  assert.equal((await f.ops.prepareParticipation(f.caller)).taskCounts,null);
  f.tasks=undefined;
  await f.ops.callTool(f.caller,'read_agent_inbox',{});
  f.mission.state='waiting';f.mission.currentTurnId=null;
  await assert.rejects(f.ops.callTool(f.caller,'get_project',{}),e=>e.code==='worker_inactive');
  await assert.rejects(f.ops.callTool({...f.caller,generation:2},'get_project',{}),e=>e.code==='worker_inactive');
  await assert.rejects(f.ops.callTool(f.caller,'list_my_projects',{}),e=>e.code==='unknown_tool');
});

test('scoped worker discovery follows ON/OFF/ON and never exposes an unbundled or owner tool', async t => {
  const f=await fixture(t);
  const names=async()=> (await f.ops.listTools(f.caller)).map(t=>t.name);
  assert.deepEqual((await names()).sort(),['comment_task','get_mlswarm_guide','get_project','get_task','list_tasks','manage_team','read_teams','upload_project_image']);
  f.enabled=false;
  assert.deepEqual((await names()).sort(),['get_mlswarm_guide','get_project','get_task','list_tasks','read_teams','upload_project_image']);
  f.enabled=true;
  assert.ok((await names()).includes('comment_task'));
  f.catalogFailure=true;
  await assert.rejects(names(),e=>e.code==='project_unavailable');
  f.catalogFailure=false;f.mission.state='stopped';
  await assert.rejects(names(),e=>e.code==='worker_inactive');
});

test('real HTTP worker discovery refreshes on the same MCP client; cached OFF writes are refused', async t => {
  const f=await fixture(t);
  const controllers={getMission:async()=>structuredClone(f.mission)};
  const principal={site:f.caller.target.site,ownerId:f.caller.target.ownerId};
  const application=createRuntimeApplication({controllers,principal,workerOperations:f.ops});
  const service=await startRuntimeService({controllers,principal,application});
  t.after(()=>service.close());
  const endpoint=await service.issueWorker(f.caller);
  const client=new Client({name:'synthetic-worker-discovery',version:'test'});
  t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:{Authorization:`Bearer ${endpoint.token}`}}}));
  const names=async()=> (await client.listTools()).tools.map(t=>t.name);
  assert.ok((await names()).includes('comment_task'));
  await client.callTool({name:'get_project',arguments:{}});
  const guide=await client.callTool({name:'get_mlswarm_guide',arguments:{section:'project-work'}});
  assert.equal(guide.isError,undefined);
  assert.ok(guide.content[0].text.endsWith(readBundledGuide('project-work')));
  f.enabled=false;
  assert.deepEqual((await names()).sort(),['get_mlswarm_guide','get_project','get_task','list_tasks','read_teams','upload_project_image']);
  await assert.rejects(client.callTool({name:'comment_task',arguments:{task_id:'task',expected_revision:1,body:'stale',client_request_id:'same'}}),e=>e.code===-32602 && /Tool comment_task not found/.test(e.message));
  assert.ok(!f.calls.some(c=>c.rpc.params?.name==='comment_task'));
  f.enabled=true;
  assert.ok((await names()).includes('comment_task'));
  f.mismatch=true;
  assert.equal((await client.callTool({name:'get_project',arguments:{}})).isError,true);
});

test('worker guide reads are local, identity/lifetime bound and limited to the two shared workflows', async t => {
  const f=await fixture(t);
  const guide=args=>f.ops.callTool(f.caller,'get_mlswarm_guide',args);
  await assert.rejects(guide({section:'project-work'}),{code:'identity_unverified'});
  await f.ops.callTool(f.caller,'get_project',{});
  const calls=f.calls.length;
  for(const section of ['project-work','updates-and-help']) {
    const result=await guide({section});
    assert.ok(result.content[0].text.endsWith(readBundledGuide(section)));
  }
  for(const args of [{},{section:'computer'},{section:'agents'},{section:'projects'},{section:'work-in-chat'},
    {section:'../instructions.md'},{section:'project-work',projectId:'other'}]) await assert.rejects(guide(args),{code:'bad_input'});
  assert.equal(f.calls.length,calls,'workflow text never goes to the cloud');
  await assert.rejects(f.ops.callTool({...f.caller,target:{...f.caller.target,projectId:'other'}},'get_mlswarm_guide',{section:'project-work'}),{code:'worker_inactive'});
  f.mission.currentTurnId=randomUUID();
  await assert.rejects(guide({section:'project-work'}),{code:'identity_unverified'});
  await f.ops.callTool(f.caller,'get_project',{});
  f.mission.deadlineAt=Date.now()-1;
  await guide({section:'project-work'});
  f.mission.state='stopped';
  await assert.rejects(guide({section:'project-work'}),{code:'worker_inactive'});
});

test('worker guide readers reopen the mission snapshot, refuse corruption and never substitute a current guide', async t => {
  const f=await fixture(t);
  await f.ops.callTool(f.caller,'get_project',{});
  const restarted=createWorkerOperations({store:f.store,resolveBinding:async()=>f.binding,fetchImpl:f.fetchImpl});
  t.after(()=>restarted.release(f.caller));
  await assert.rejects(restarted.callTool(f.caller,'get_mlswarm_guide',{section:'project-work'}),{code:'identity_unverified'});
  await restarted.callTool(f.caller,'get_project',{});
  const before=await f.ops.callTool(f.caller,'get_mlswarm_guide',{section:'project-work'});
  assert.deepEqual(await restarted.callTool(f.caller,'get_mlswarm_guide',{section:'project-work'}),before);
  const file=join(f.missionDir,'worker-guides.json'),snapshot=readPrivate(file,true);
  snapshot.sections['project-work']='Unexpected different guidance';writePrivate(file,snapshot);
  await assert.rejects(restarted.callTool(f.caller,'get_mlswarm_guide',{section:'project-work'}),{code:'guide_unavailable'});
  await rm(file);
  await assert.rejects(restarted.callTool(f.caller,'get_mlswarm_guide',{section:'project-work'}),{code:'guide_unavailable'});
  assert.equal(readPrivate(join(f.missionDir,'instructions.md')),'Synthetic worker core');
});

test('context measures returned facade catalog, guide and sanitized replies, excluding preparation and late replies', async t => {
  const f = await fixture(t);
  await f.ops.beginContext(f.caller);
  await f.ops.prepareParticipation(f.caller);
  const tools = await f.ops.listTools(f.caller);
  const guide = await f.ops.callTool(f.caller, 'get_mlswarm_guide', {section:'project-work'});
  const reply = await f.ops.callTool(f.caller, 'list_tasks', {});
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.beforeReply = async () => { entered(); await gate; };
  const late = f.ops.callTool(f.caller, 'list_tasks', {});
  await started;
  const first = await f.ops.endContext(f.caller);
  assert.equal(first.catalogRequests, 1);
  assert.equal(first.catalogBytes, Buffer.byteLength(JSON.stringify(tools)));
  assert.equal(first.byTool.find(t=>t.name==='list_tasks').definitionBytes,Buffer.byteLength(JSON.stringify(tools.find(t=>t.name==='list_tasks'))));
  assert.equal(first.byTool.find(t=>t.name==='list_tasks').calls,1);
  assert.equal(first.byTool.find(t=>t.name==='get_mlswarm_guide').responseTextBytes,Buffer.byteLength(guide.content[0].text));
  assert.equal(first.byTool.some(t=>t.name==='secret-project-name'),false);
  assert.equal(first.tools.find(x => x.category === 'other').responseTextBytes, Buffer.byteLength(guide.content[0].text));
  assert.deepEqual(first.tools.find(x => x.category === 'coordination'), {
    category:'coordination', calls:1, argumentBytes:2, responseTextBytes:Buffer.byteLength(reply.content[0].text), refusals:0,
  });
  assert.equal(first.tools.some(x => x.category === 'project'), false, 'preparation is not model-facing MCP context');
  release(); await late; f.beforeReply = undefined;
  f.mission.currentTurnId = randomUUID();
  await f.ops.beginContext(f.caller);
  await f.ops.prepareParticipation(f.caller);
  f.refusal = {result:{isError:true,content:[{type:'text',text:'refused: שלום 🧪'}]}};
  await f.ops.callTool(f.caller, 'list_tasks', {});
  const second = await f.ops.endContext(f.caller);
  assert.equal(second.catalogRequests, 0);
  assert.equal(second.tools.length, 1);
  assert.equal(second.tools[0].calls, 1);
  assert.equal(second.tools[0].refusals, 1);
  assert.equal(second.tools[0].responseTextBytes, Buffer.byteLength('refused: שלום 🧪', 'utf8'));
  assert.ok(second.tools[0].responseTextBytes > 'refused: שלום 🧪'.length);
  assert.equal(await f.ops.endContext(f.caller), null, 'an absent measurement is unknown');
});

test('worker steering replies reach the scoped server and retain server refusals for other empty-recipient threads', async t => {
  const f = await fixture(t);
  await f.ops.callTool(f.caller, 'get_project', {});
  const args = {to:[],thread_id:`steer_${'a'.repeat(64)}_${randomUUID()}`,body:'Steering applied.',client_message_id:'steering-reply'};
  f.refusal = {result:{content:[{type:'text',text:JSON.stringify({message:{id:'agent_steering-reply'}})}]}};
  const result = await f.ops.callTool(f.caller, 'send_message', args);
  assert.notEqual(result.isError,true);
  assert.deepEqual(f.calls.at(-1).rpc.params.arguments,args);
  assert.deepEqual(await f.ops.deliveryState(f.caller),{pending:0,notices:[]});
  f.refusal = {result:{isError:true,content:[{type:'text',text:'bad_input: An empty recipient list is only for a reply to human steering.'}]}};
  const refused = await f.ops.callTool(f.caller,'send_message',{...args,thread_id:'ordinary-thread',client_message_id:'wrong-thread'});
  assert.equal(refused.isError,true);
  assert.match(refused.content[0].text,/only for a reply to human steering/);
  assert.deepEqual(await f.ops.deliveryState(f.caller),{pending:0,notices:[]});
});
