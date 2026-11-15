import test from 'node:test';
import { createRuntimeApplication } from '../src/service/application.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRuntimeStore } from '../src/service/store.mjs';
import { createParticipationRuntime } from '../src/service/participation-runtime.mjs';
import { commandFingerprint } from '../src/service/contracts.mjs';

const value=result=>JSON.parse(result.content[0].text);
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'minions-participation-')),folder=join(root,'repo'),stateDir=join(root,'private');
 await mkdir(folder);await mkdir(stateDir,{mode:0o700});
 const target={site:'http://127.0.0.1:8787',ownerId:'owner',projectId:'project',agentId:'agent'};
 const principal={site:target.site,ownerId:target.ownerId},calls=[];
 let store=await openRuntimeStore({directory:join(root,'ledger')}),runtime,offline=false,mismatch=false,notifications=0,refusal=null;
 const taskCapabilities=new Map(), teamCapabilities=new Map();
 // Registered before the runtime exists: a setup failure must not leave the store worker alive and hang the runner.
 t.after(async()=>{await runtime?.close();await store.close();await rm(root,{recursive:true,force:true})});
 const fetchImpl=async(url,options)=>{
  assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer synthetic-token');
  const body=JSON.parse(options.body);calls.push({url,body});
  let data;
  const projectId=url.split('/p/')[1]?.split('/')[0] ?? target.projectId;
  const enabled=taskCapabilities.get(projectId) !== false;
  if(url.endsWith('/chat-participations'))data={run_id:body.client_run_id,generation:1,poll_seconds:20,protocol:2};
  else if(url.endsWith('/deadline'))data={run_id:url.split('/').at(-2),deadline_at:body.deadline_at};
  else{
   if(refusal&&body.params.name!=='get_project') return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,...refusal}),{status:200});
   if(offline&&body.params.name==='send_message')throw new Error('synthetic lost connection');
   data={jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(body.params.name==='get_project'?{teams:{enabled:teamCapabilities.get(projectId)===true,tools:teamCapabilities.get(projectId)===true?['read_teams','manage_team']:['read_teams']},tasks:{enabled,tools: enabled ? ['list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task'] : ['list_tasks','get_task']},project:{started:true,paused:false,completedAt:null},you:{agentId:mismatch?'other':target.agentId,participation:{identity:{projectId,agentId:target.agentId,profileId:target.ownerId},authorization:{mode:'wrong',deadlineAt:123,scope:'Untrusted upstream scope'}}}}:body.params.name==='send_message'?{message:{id:'accepted'}}:{items:[],position:0})}]}};
  }
  return new Response(JSON.stringify(data),{status:200});
 };
 const binding={url:'http://127.0.0.1:8787/p/project',token:'synthetic-token',folder,stateDir};
 runtime=createParticipationRuntime({store,principal,resolveBinding:async selected=>({...binding,url:`http://127.0.0.1:8787/p/${selected.projectId}`}),fetchImpl,onReportsReady:()=>{notifications++;},sweepIntervalMs:20});
 return {target,calls,taskCapabilities,teamCapabilities,get store(){return store},get runtime(){return runtime},set offline(v){offline=v},set mismatch(v){mismatch=v},set refusal(v){refusal=v},get notifications(){return notifications}};
}
const claim=(target,remaining=300000)=>{const deadlineAt=Date.now()+remaining;return {version:1,operationId:randomUUID(),kind:'claim',target,participationId:randomUUID(),payload:{approved:true,scope:'Synthetic project work only',approvedAt:deadlineAt-300000,deadlineAt}}};
const release=p=>({version:1,operationId:randomUUID(),kind:'release',target:p.target,participationId:p.participationId,generation:p.generation,payload:{}});
const args=p=>({participation_ref:p.participationRef});

test('current-chat facade retains protocol refusal diagnostics and valid text errors',async t=>{
 const f=await fixture(t),p=(await f.runtime.command(claim(f.target))).participation;
 await f.runtime.callTool('get_project',args(p));
 f.refusal={error:{code:-32602,message:'Tool list_tasks not found',data:{token:'synthetic-token'}}};
 const response=await f.runtime.callTool('list_tasks',args(p));
 assert.equal(response.isError,true);
 assert.deepEqual(value(response),{error:{code:-32602,message:'Tool list_tasks not found'}});
 f.refusal={result:{isError:true,content:[{type:'text',text:'intent_conflict: reread task'}]}};
 assert.equal((await f.runtime.callTool('list_tasks',args(p))).content[0].text,'intent_conflict: reread task');
});

test('chat claim binds exact cloud intent, verifies identity, extends without resetting approval and freezes pending sends on release',async t=>{
 const f=await fixture(t),command=claim(f.target),accepted=await f.runtime.command(command),p=accepted.participation;
 assert.equal(p.state,'active');assert.equal(p.deadlineAt,command.payload.deadlineAt);
 assert.equal(f.calls[0].body.client_run_id,p.participationId);assert.equal(f.calls[0].body.approved_at,command.payload.approvedAt);
 await assert.rejects(f.runtime.callTool('read_agent_inbox',args(p)),e=>e.code==='identity_unverified');
 const initial=value(await f.runtime.callTool('get_project',args(p)));assert.equal(initial.you.agentId,'agent');
 assert.deepEqual({...initial.you.participation.authorization,instruction:undefined},{mode:'current_chat',participationId:p.participationId,generation:p.generation,approvedAt:p.approvedAt,deadlineAt:p.deadlineAt,scope:p.scope,instruction:undefined});
 assert.match(initial.you.participation.authorization.instruction,/no automatic renewal/);assert.match(initial.you.participation.authorization.instruction,/does not stop or control the external chat host/);
 await assert.rejects(f.runtime.callTool('read_agent_inbox',{...args(p),target:{agentId:'other'}}),e=>e.code==='bad_input');
 f.offline=true;const send=await f.runtime.callTool('send_message',{...args(p),to:['recipient'],body:'Original synthetic send',client_message_id:'stable-send'});
 assert.equal(value(send).status,'pending');
 const extension={version:1,operationId:randomUUID(),kind:'extend',target:p.target,participationId:p.participationId,generation:p.generation,payload:{approved:true,approvedAt:Date.now(),expectedDeadlineAt:p.deadlineAt,deadlineAt:p.deadlineAt+300000}};
 const extended=(await f.runtime.command(extension)).participation;assert.equal(extended.deadlineAt,p.deadlineAt+300000);assert.equal(extended.participationRef,p.participationRef);
 assert.equal(f.calls.find(c=>c.url.endsWith('/deadline')).body.client_request_id,extension.operationId);
 const changed=value(await f.runtime.callTool('get_project',args(p))).you.participation.authorization;assert.equal(changed.deadlineAt,extended.deadlineAt);assert.equal(changed.scope,p.scope);assert.equal(changed.participationId,p.participationId);
 const afterExtension=f.calls.length;
 assert.equal((await f.runtime.command(command)).participation.deadlineAt,extended.deadlineAt);assert.equal(f.calls.length,afterExtension);
 const second={...extension,operationId:randomUUID(),payload:{...extension.payload,approvedAt:Date.now(),expectedDeadlineAt:extended.deadlineAt,deadlineAt:extended.deadlineAt+300000}};
 const twice=(await f.runtime.command(second)).participation;const afterSecond=f.calls.length;
 assert.equal((await f.runtime.command(extension)).participation.deadlineAt,twice.deadlineAt);assert.equal(f.calls.length,afterSecond);
 const reserved=release(p),background={version:2,operationId:reserved.operationId,kind:'start',target:{...p.target,agentId:'another'},missionId:randomUUID(),payload:{scope:'Synthetic background acceptance held before SQL',deadlineAt:Date.now()+300000,execution:{provider:'claude',model:null}}};
 f.store.reserveOperation({operationId:background.operationId,fingerprint:commandFingerprint(background)});
 await assert.rejects(f.runtime.command(reserved),e=>e.code==='conflict');
 assert.equal(value(await f.runtime.callTool('get_project',args(p))).you.agentId,'agent');
 const conflicting={...release(p),operationId:command.operationId};
 await assert.rejects(f.runtime.command(conflicting),e=>e.code==='conflict');
 assert.equal(value(await f.runtime.callTool('get_project',args(p))).you.agentId,'agent');
 const ended=(await f.runtime.command(release(p))).participation;assert.equal(ended.state,'released');
 await assert.rejects(f.runtime.callTool('read_agent_inbox',args(p)),e=>e.code==='participation_inactive');
 assert.equal(f.calls.filter(c=>c.body.params?.name==='send_message').length,1);
 assert.ok(f.notifications>0);
});

test('authorization context is never attached to an unverified upstream identity',async t=>{
 const f=await fixture(t),p=(await f.runtime.command(claim(f.target))).participation;
 await f.runtime.callTool('get_project',args(p));f.mismatch=true;
 await assert.rejects(f.runtime.callTool('get_project',args(p)),e=>e.code==='identity_mismatch');
 await assert.rejects(f.runtime.callTool('read_agent_inbox',args(p)),e=>e.code==='identity_unverified');
 f.mismatch=false;const project=value(await f.runtime.callTool('get_project',args(p)));
 assert.equal(project.you.agentId,p.target.agentId);assert.equal(project.you.participation.authorization.participationId,p.participationId);
 assert.equal(project.you.participation.authorization.deadlineAt,p.deadlineAt);
});


test('in-chat task discovery stays scoped across projects and refreshes after a toggle without executing work', async t => {
 const f=await fixture(t), a=(await f.runtime.command(claim(f.target))).participation;
 const b=(await f.runtime.command(claim({...f.target,projectId:'project-off'}))).participation;
 f.taskCapabilities.set('project-off',false);
 const global=f.runtime.listTools().map(tool=>tool.name);
 assert.ok(global.includes('get_task')); assert.ok(!global.includes('create_task'));
 const catalog=p=>f.runtime.listTaskTools(args(p)).then(value);
 const on=await catalog(a),off=await catalog(b);
 assert.equal(on.tools.length,8);assert.deepEqual(off.tools.map(x=>x.name),['list_tasks','get_task']);
 assert.ok(on.tools.every(x=>!Object.hasOwn(x.inputSchema.properties,'participation_ref')));
 assert.ok(f.calls.filter(x=>x.body.params).every(x=>x.body.params.name==='get_project'),'Discovery must never invoke a mutation.');
 const input={client_request_id:randomUUID(),title:'Native task'};
 await f.runtime.callTaskTool({...args(a),name:'create_task',arguments:input});
 assert.equal(f.calls.at(-1).body.params.name,'create_task');assert.deepEqual(f.calls.at(-1).body.params.arguments,input);
 f.taskCapabilities.set('project',false);
 const before=f.calls.filter(x=>x.body.params?.name==='create_task').length;
 await assert.rejects(f.runtime.callTaskTool({...args(a),name:'create_task',arguments:input}),e=>e.code==='tasks_disabled');
 assert.equal(f.calls.filter(x=>x.body.params?.name==='create_task').length,before);
 const page={limit:2,search:'parser',status:'backlog',assigned_agent_id:null,cursor:'task_previous'};
 await f.runtime.callTaskTool({...args(b),name:'list_tasks',arguments:page});
 assert.equal(f.calls.at(-1).body.params.name,'list_tasks');
 assert.deepEqual(f.calls.at(-1).body.params.arguments,page);
 f.taskCapabilities.set('project',true); assert.equal((await catalog(a)).tools.length,8);
 for(const bad of [{name:'assign_task',arguments:{task_id:'t',assigned_agent_id:'other'}},{name:'send_message',arguments:{}},{name:'create_task',arguments:{participation_ref:a.participationRef}}, {name:'create_task',arguments:[]}])
   await assert.rejects(f.runtime.callTaskTool({...args(a),...bad}),e=>e.code==='bad_input');
 await assert.rejects(f.runtime.callTaskTool({...args(a),name:'create_task',arguments:{title:'missing receipt'}}),e=>e.code==='bad_input');
 await f.runtime.command(release(a));
 await assert.rejects(catalog(a),e=>['participation_inactive','participation_detached'].includes(e.code));
});


test('owner application exposes only the scoped task facade and validates its outer schema', async t => {
 const f=await fixture(t),p=(await f.runtime.command(claim(f.target))).participation;
 const principal={site:f.target.site,ownerId:f.target.ownerId},caller={kind:'owner',...principal};
 const app=createRuntimeApplication({controllers:{},principal,participation:f.runtime});
 const names=app.listTools(caller).map(x=>x.name);
 assert.ok(names.includes('get_task_tools'));assert.ok(names.includes('call_task_tool'));assert.ok(!names.includes('update_task'));
 assert.equal(value(await app.callTool(caller,'get_task_tools',args(p))).tools.length,8);
 const valid={...args(p),name:'list_tasks',arguments:{}};
 assert.equal((await app.callTool(caller,'call_task_tool',valid)).isError,undefined);
 assert.equal((await app.callTool(caller,'call_task_tool',{...valid,project_id:'another'})).isError,true);
 assert.equal((await app.callTool(caller,'update_task',{...args(p),task_id:'task'})).isError,true);
});

test('native team tools stay scoped across projects and recheck OFF before forwarding any mutation', async t => {
 const f=await fixture(t),a=(await f.runtime.command(claim(f.target))).participation;
 const b=(await f.runtime.command(claim({...f.target,projectId:'other-project'}))).participation;
 const names=f.runtime.listTools().map(tool=>tool.name);
 assert.ok(names.includes('read_teams'));assert.ok(!names.includes('manage_team'));
 const catalog=p=>f.runtime.listTeamTools(args(p)).then(value);
 assert.deepEqual((await catalog(a)).tools.map(tool=>tool.name),['read_teams']);
 f.teamCapabilities.set('project',true);
 assert.deepEqual((await catalog(a)).tools.map(tool=>tool.name),['read_teams','manage_team']);
 assert.deepEqual((await catalog(b)).tools.map(tool=>tool.name),['read_teams']);
 const input={operation:'create',name:'Launch',client_request_id:'create'};
 await f.runtime.callTeamTool({...args(a),name:'manage_team',arguments:input});
 assert.deepEqual(f.calls.at(-1).body.params,{name:'manage_team',arguments:input});
 f.teamCapabilities.set('project',false);
 const before=f.calls.filter(call=>call.body.params?.name==='manage_team').length;
 await assert.rejects(f.runtime.callTeamTool({...args(a),name:'manage_team',arguments:input}),{code:'teams_disabled'});
 assert.equal(f.calls.filter(call=>call.body.params?.name==='manage_team').length,before);
 for(const bad of [{name:'send_message',arguments:{}},{name:'manage_team',arguments:{participation_ref:a.participationRef}}])
   await assert.rejects(f.runtime.callTeamTool({...args(a),...bad}),{code:'bad_input'});
 const principal={site:f.target.site,ownerId:f.target.ownerId},caller={kind:'owner',...principal};
 const app=createRuntimeApplication({controllers:{},principal,participation:f.runtime});
 assert.ok(app.listTools(caller).some(tool=>tool.name==='get_team_tools'));
 assert.ok(!app.listTools(caller).some(tool=>tool.name==='manage_team'));
 assert.deepEqual(value(await app.callTool(caller,'get_team_tools',args(a))).tools.map(tool=>tool.name),['read_teams']);
});
