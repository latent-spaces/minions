import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeInstalledRuntime } from '../src/service/bootstrap.mjs';
import { createOwnerClient } from '../src/owner-client.mjs';

const site = 'http://127.0.0.1:18787', projectId = 'a'.repeat(64), ownerId = 'synthetic-owner';
const parse = reply => {
  const value = JSON.parse(reply.content[0].text);
  assert.equal(reply.isError, undefined, JSON.stringify(value));
  return value;
};
async function fixture(t, { uniqueAgents = false, sessions = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'minions-bootstrap-'));
  const home = join(root,'service'), credentials = join(root,'credentials'), folder = join(root,'checkout');
  await mkdir(home,{mode:0o700}); await mkdir(credentials,{mode:0o700}); await mkdir(folder);
  let composed;
  t.after(async () => { await composed?.close(); await rm(root,{recursive:true,force:true}); });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : {};
    calls.push({path,body});
    let value;
    if (path === '/api/auth/local-owner/session') { if (!sessions) return new Response(JSON.stringify({message:'Local owner sign-in is unavailable.'}),{status:404}); value = {token:'lo1.synthetic.session'}; }
    else if (path === '/api/owner/profile') value = {profileId:ownerId,name:'Synthetic Owner',email:'owner@example.test'};
    else if (path.endsWith('/agents/connect')) value = {agentId:uniqueAgents ? body.name : 'synthetic-agent',agentName:body.name,projectId,repoUrl:'https://github.com/example/fixture',created:true,settings:{involvement:'with_me'}};
    else if (path.endsWith('/agent-starts') && body.id) value = {request:{id:body.id,state:'pending',scope:body.scope ?? 'Work toward the project goal.',execution:body.execution}};
    else if (path === '/api/owner/participation-controls') value = {commands:[],serverTime:Date.now()};
    else if (path.endsWith('/chat-participations')) value = {protocol:2,run_id:body.client_run_id,generation:1,poll_seconds:20};
    else if (path.endsWith('/phase')) value = {ok:true,run_id:path.split('/').at(-2),phase:'stopping'};
    else value = {ok:true};
    return new Response(JSON.stringify(value),{status:200});
  };
  const owner = createOwnerClient({home:credentials,workspace:join(root,'workspace'),site,fetchImpl});
  return {root,credentials,folder,calls,owner,async compose(){
    // Never discover or migrate the person's gh login through the inherited HOME.
    composed = await composeInstalledRuntime({home,site,credentialHome:credentials,fetchImpl,webStartOptions:{capabilities:async()=>[],githubSignIn:async()=> 'missing'},
      getService:()=>{throw new Error('No native worker bridge may be requested in this no-model test.');}});
    return composed;
  }};
}

test('installed bootstrap signs in as the owner itself, and opens no runtime when the engine gives no owner session',async t=>{
  const refused = await fixture(t, { sessions: false });
  await assert.rejects(refused.compose(),/gives no owner session/);
  assert.deepEqual(refused.calls.map(call => call.path),['/api/auth/local-owner/session']);
  const f = await fixture(t);
  await f.compose();
  assert.deepEqual(f.calls.slice(0,2).map(call => call.path),['/api/auth/local-owner/session','/api/owner/profile']);
  assert.equal((await f.owner.signIn()).account_profile_id,ownerId);
});

test('approved empty installation can add a trusted chat binding dynamically without starting a provider or exposing credentials',async t=>{
  const f = await fixture(t);
  await f.owner.signIn();
  const composed = await f.compose(), caller = {kind:'owner',site,ownerId};
  assert.ok(composed.application.listTools(caller).some(tool=>tool.name==='work_in_this_chat'));
  assert.equal(parse(await composed.application.callTool(caller,'get_computer_status',{})).localReady,true);
  assert.equal(f.calls.some(call=>/\/v2\//.test(call.path)),false);
  const added = parse(await composed.application.callTool(caller,'add_project_agent',{project_id:projectId,agent_name:'alpha',folder:f.folder}));
  assert.equal(added.agent_id,'synthetic-agent');
  assert.equal(Object.keys(added).some(key=>/token|credential|secret/.test(key)),false);
  assert.equal(f.calls.some(call=>/\/v2\//.test(call.path)),false);
  const approvedAt = Date.now(), target = {site,ownerId,projectId,agentId:added.agent_id};
  const claim = {operationId:randomUUID(),kind:'claim',target:{projectId,agentId:target.agentId},participationId:randomUUID(),
    payload:{approved:true,approvedAt,deadlineAt:approvedAt+300000,scope:'Synthetic bootstrap routing; no model work.'}};
  const active = parse(await composed.application.callTool(caller,'work_in_this_chat',claim)).participation;
  assert.equal(active.state,'active');
  assert.equal(f.calls.filter(call=>call.path.endsWith('/chat-participations')).length,1);
  const released = parse(await composed.application.callTool(caller,'work_in_this_chat',{
    operationId:randomUUID(),kind:'release',target:{projectId,agentId:target.agentId},participationId:active.participationId,generation:active.generation,payload:{},
  })).participation;
  assert.equal(released.state,'released');
  // No native registration, worker bridge, provider selection or model start.
  assert.equal(f.calls.some(call=>call.path.endsWith('/v2/runs')),false);
  await composed.close(); await composed.close();
});

test('add_project_agent queues the first run with the chosen model, like the website form', async t => {
  const f = await fixture(t, { uniqueAgents: true });
  await f.owner.signIn();
  const composed = await f.compose(), caller = { kind: 'owner', site, ownerId };
  const added = parse(await composed.application.callTool(caller, 'add_project_agent', { project_id: projectId, agent_name: 'cheap', folder: join(f.root, 'cheap'), model: 'sonnet' }));
  assert.equal(added.run.id, f.calls.find(call => call.path.endsWith('/agent-starts') && call.body.execution).body.id);
  assert.equal(added.run.task, 'Work toward the project goal.');
  assert.equal(added.run.model, 'sonnet');
  assert.deepEqual(added.saved_defaults, { involvement: 'with_me' }); assert.equal('minutes' in added.run, false);
  assert.equal('minutes' in f.calls.find(call => call.path.endsWith('/agent-starts') && call.body.execution).body, false);
  parse(await composed.application.callTool(caller, 'add_project_agent', { project_id: projectId, agent_name: 'default', folder: join(f.root, 'default') }));
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/agent-starts') && call.body.execution).map(call => call.body.execution), [{ provider: 'claude', model: 'sonnet' }, { provider: 'claude', model: null }]);
});
