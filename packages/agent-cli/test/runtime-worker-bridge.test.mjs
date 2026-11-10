import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createWorkerBridgeFactory } from '../src/service/worker-bridge.mjs';
import { createWorkerOperations } from '../src/service/worker-operations.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { startRuntimeService } from '../src/service/mcp-service.mjs';

async function connect(endpoint) {
  const client=new Client({name:'synthetic-worker-bridge',version:'0.0.0-test'});
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:{Authorization:`Bearer ${endpoint.token}`}}}));
  return client;
}
const parse=result=>JSON.parse(result.content.find(item=>item.type==='text').text);
const request=endpoint=>fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/list'})});

test('actual worker bridge composes scoped HTTP, participant preparation and durable send/ACK ports with cleanup', {timeout:15000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'mlswarm-worker-bridge-'));
  const principal={site:'http://127.0.0.1:8787',ownerId:'owner'};
  const missions=[],bindings=[],resolved=[],upstream=[];
  let offline=true;
  for(const projectId of ['project-a','project-b']){
    const folder=join(root,projectId),stateDir=join(root,`${projectId}-private`);
    await mkdir(folder);await mkdir(stateDir,{mode:0o700});
    const target={...principal,projectId,agentId:`agent-${projectId}`};
    missions.push({target,missionId:randomUUID(),generation:3,state:'running',currentTurnId:randomUUID(),deadlineAt:Date.now()+3600000});
    bindings.push({url:`${principal.site}/p/${projectId}`,token:`synthetic-${projectId}`,folder,stateDir});
  }
  const getMission=async({missionId,target})=>{
    const value=missions.find(item=>item.missionId===missionId&&JSON.stringify(item.target)===JSON.stringify(target));
    return value?structuredClone(value):null;
  };
  const operations=createWorkerOperations({store:{getMission},resolveBinding:async caller=>{
    resolved.push(structuredClone(caller));
    return bindings[missions.findIndex(m=>m.missionId===caller.missionId)];
  },fetchImpl:async(url,options)=>{
    const rpc=JSON.parse(options.body),index=bindings.findIndex(b=>url===`${b.url}/v2/mcp`),mission=missions[index];
    assert.notEqual(index,-1);assert.equal(options.headers.authorization,`Bearer ${bindings[index].token}`);
    assert.equal(options.headers['x-pilot-run'],mission.missionId);assert.equal(options.redirect,'error');
    upstream.push({index,rpc});
    if(rpc.method==='tools/list') return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools:['get_project','list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task','acknowledge_human_answer','send_message'].map(name=>({name}))}}));
    if(rpc.params.name==='send_message'&&offline)throw new Error('Synthetic connection loss');
    const data=rpc.params.name==='get_project'?{
      project:{name:mission.target.projectId,mission:'Synthetic',rules:'No model work',repoUrl:'https://github.com/test/repo',mergeApproval:'humans',started:true,paused:false,completedAt:null},
      you:{agentId:mission.target.agentId,participation:{identity:{projectId:mission.target.projectId,agentId:mission.target.agentId,profileId:principal.ownerId},persona:{text:'',revision:0},observedAt:Date.now()}}
    }:rpc.params.name==='send_message'?{message:{id:'accepted'}}:{ok:true};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(data)}]}}),{status:200});
  }});
  const controllers={getMission,health:async()=>({ready:true})};
  const app=createRuntimeApplication({controllers,principal,workerOperations:operations});
  const service=await startRuntimeService({controllers,principal,application:app});
  const factory=createWorkerBridgeFactory({getService:()=>service,workerOperations:operations});
  const endpoints=[],clients=[];
  t.after(async()=>{
    await Promise.all(clients.map(c=>c.close().catch(()=>{})));
    await Promise.all(endpoints.map(e=>e.revoke()));
    await service.close();await rm(root,{recursive:true,force:true});
  });
  for(const mission of missions){
    const endpoint=await factory.createBridge(mission);endpoints.push(endpoint);
    await endpoint.beginContext();
    assert.notEqual(endpoint.token,service.token);
    const client=await connect(endpoint);clients.push(client);
    assert.equal(client.getServerVersion().name,'mlswarm-project-worker');
    const names=(await client.listTools()).tools.map(t=>t.name);
    assert.equal(new Set(names).size,names.length);assert.ok(names.includes('get_project'));for(const tool of ['list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task'])assert.ok(names.includes(tool),tool);for(const retired of ['find_github_work','get_issue_coordination','coordinate_issue'])assert.ok(!names.includes(retired),retired);assert.ok(!names.includes('control_agent'));assert.ok(!names.includes('list_my_projects'));
    assert.ok(names.includes('acknowledge_human_answer'));
    for(const name of ['open_vote','cast_vote','get_vote','list_votes','resolve_vote'])assert.ok(!names.includes(name));
    const snapshot=await factory.prepareParticipation({mission,signal:new AbortController().signal});
    assert.deepEqual(snapshot.identity,{projectId:mission.target.projectId,agentId:mission.target.agentId,profileId:principal.ownerId});
    const projectResult=await client.callTool({name:'get_project',arguments:{}});
    const project=parse(projectResult);assert.equal(project.you.agentId,mission.target.agentId);
    const measured=await endpoint.endContext();
    assert.equal(measured.catalogRequests,1);
    assert.equal(measured.tools.find(item=>item.category==='project').responseTextBytes,Buffer.byteLength(projectResult.content[0].text));
  }
  assert.equal(resolved.length,2);assert.deepEqual(resolved.map(c=>c.generation),[3,3]);
  const ackInput={request_id:'a'.repeat(64),expected_revision:2,client_request_id:'ack-receipt'};
  assert.equal(parse(await clients[0].callTool({name:'acknowledge_human_answer',arguments:ackInput})).ok,true);
  assert.deepEqual(upstream.find(item=>item.rpc.params?.name==='acknowledge_human_answer').rpc.params.arguments,ackInput);
  const pending=parse(await clients[0].callTool({name:'send_message',arguments:{to:['recipient'],body:'Original synthetic intent',client_message_id:'stable-bridge-send'}}));
  assert.equal(pending.status,'pending');assert.equal((await endpoints[0].deliveryState()).pending,1);
  assert.deepEqual(await endpoints[1].deliveryState(),{pending:0,notices:[]});
  missions[0].state='waiting';missions[0].currentTurnId=null;offline=false;
  const originalNow=Date.now;Date.now=()=>originalNow()+40000;
  try{await endpoints[0].retryPending({signal:new AbortController().signal});}finally{Date.now=originalNow;}
  const delivered=await endpoints[0].deliveryState();assert.equal(delivered.pending,0);assert.equal(delivered.notices.length,1);
  const sends=upstream.filter(c=>c.rpc.params?.name==='send_message');assert.equal(sends.length,2);assert.deepEqual(sends[0].rpc.params.arguments,sends[1].rpc.params.arguments);
  await endpoints[0].acknowledgeNotices(delivered.notices);assert.equal((await endpoints[0].deliveryState()).notices.length,0);
  await assert.rejects(factory.createBridge({...missions[0],generation:4}),e=>e.code==='conflict');
  missions[0].state='stopped';await Promise.all([endpoints[0].revoke(),endpoints[0].revoke()]);
  assert.equal((await request(endpoints[0])).status,401);
  assert.equal(parse(await clients[1].callTool({name:'get_project',arguments:{}})).you.agentId,missions[1].target.agentId);
  missions[1].generation++;
  assert.equal((await request(endpoints[1])).status,403);
  await endpoints[1].revoke();assert.equal((await request(endpoints[1])).status,401);
});
