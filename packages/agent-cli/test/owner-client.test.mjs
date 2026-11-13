import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerClient, ownerOrigin } from '../src/owner-client.mjs';
import { OWNER_TOOLS } from '../src/owner-tools.mjs';
import { digest } from '../src/state.mjs';
const P='a'.repeat(64), site='http://127.0.0.1:8787';

function fixture() {
 const home=mkdtempSync(join(tmpdir(),'karma-owner-')), workspace=realpathSync(mkdtempSync(join(tmpdir(),'karma-layout-'))); const requests=[];let lost=false,reply=null;const at=1000;
 // The engine's connections, by candidate token hash; dropping one is what a re-initialized store does.
 const connections=new Map();
 const fetchImpl=async(url,options)=>{
  requests.push({url:String(url),...options});
  if(lost){lost=false;throw new Error('opaque-secret-transport-error');}
  let body={};
  if(String(url).endsWith('/api/auth/local-owner/session'))return new Response(JSON.stringify({token:'lo1.session.mac'}),{status:200});
  if(String(url).endsWith('/api/owner/local-computer')){const input=JSON.parse(options.body);if(!connections.has(input.candidateTokenHash))connections.set(input.candidateTokenHash,randomUUID());return new Response(JSON.stringify({connectionId:connections.get(input.candidateTokenHash),personId:'owner',personName:'Owner',email:'owner@example.test'}),{status:200});}
  const bearer=options.headers?.Authorization?.slice(7);
  if(bearer&&!String(url).endsWith('/local-computer')&&![...connections.keys()].includes(createHash('sha256').update(bearer).digest('hex')))return new Response(JSON.stringify({error:'unauthorized',message:'This computer is no longer connected to MyLittleSwarm.'}),{status:401});
  if(String(url).endsWith('/agents/connect')){const input=JSON.parse(options.body);const id=String(url).split('/projects/')[1].slice(0,64);body={agentId:`${Buffer.from(input.name).toString('hex').slice(0,6)}-${input.name}`,agentName:input.name,projectId:id,projectName:'Garden',repoUrl:'https://github.com/example/garden',settings:{involvement:'on_own',minutes:60},created:true,replaced:false,replayed:false};}
  else body=reply?.(String(url))??{ok:true};
  return new Response(JSON.stringify(body),{status:200});
 };
 const client=createOwnerClient({home,workspace,site,fetchImpl,now:()=>at});
 return {home,workspace,client,requests,connections,respond(fn){reply=fn;},lose(){lost=true;},close(){rmSync(home,{recursive:true,force:true});rmSync(workspace,{recursive:true,force:true});}};
}
test('GitHub observations use the approved account and fixed read/report routes', async () => {
 const f=fixture();try{
  await f.client.connect();
  const before=f.requests.length, report={version:1,projectId:P,repository:'https://github.com/example/project',membershipEpoch:4,checkedAt:1000};
  assert.throws(()=>f.client.reportRepositoryAccess(report,{expectedProfileId:'another-person'}));
  assert.equal(f.requests.length,before);
  await f.client.listRepositoryAccess({expectedProfileId:'owner'});
  assert.ok(f.requests.at(-1).url.endsWith('/repository-access'));assert.equal(f.requests.at(-1).method,'GET');
  await f.client.reportRepositoryAccess(report,{expectedProfileId:'owner'});
  assert.ok(f.requests.at(-1).url.endsWith('/repository-access/observations'));assert.equal(f.requests.at(-1).method,'POST');
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),report);
 }finally{f.close();}
});
test('this computer connects by itself with the engine session; its credential is durable before contact and never returned',async()=>{
 const f=fixture();try{
  await assert.rejects(f.client.operation('list_my_projects',{}),/not connected to MyLittleSwarm yet/);
  assert.equal(f.requests.length,0);
  f.lose();await assert.rejects(f.client.connect(),/can’t be reached/);
  const path=join(f.home,'owners',digest(new URL(site).origin),'owner.json'), pending=JSON.parse(readFileSync(path));
  assert.equal(pending.status,'connecting');assert.equal(statSync(path).mode&0o777,0o600);
  const account=await f.client.connect();
  assert.deepEqual(account,{website_origin:site,environment:'local-development',status:'approved',account_name:'Owner',account_profile_id:'owner'});
  const [session,connect]=f.requests.slice(-2);
  assert.equal(session.url,`${site}/api/auth/local-owner/session`);assert.equal(session.method,'POST');
  assert.equal(session.headers.origin,site);assert.equal(session.headers['content-type'],'application/json');assert.equal(session.body,'{}');
  assert.equal(connect.url,`${site}/api/owner/local-computer`);assert.equal(connect.headers.Authorization,'Bearer lo1.session.mac');
  const saved=JSON.parse(readFileSync(path));
  // The retry after the lost reply sent the credential saved before contact.
  assert.equal(saved.token,pending.token);assert.deepEqual(JSON.parse(connect.body),{candidateTokenHash:createHash('sha256').update(saved.token).digest('hex'),clientName:'MyLittleSwarm CLI'});
  assert.equal(saved.status,'approved');assert.equal(saved.personId,'owner');assert.equal(saved.requestId,f.connections.get(createHash('sha256').update(saved.token).digest('hex')));
  assert.ok(!JSON.stringify(account).includes(saved.token));assert.ok(f.requests.every(r=>!r.url.includes(saved.token)));
  await f.client.operation('list_my_projects',{});assert.equal(f.requests.at(-1).headers.Authorization,`Bearer ${saved.token}`);
  const n=f.requests.length;assert.equal((await f.client.connect()).status,'approved');assert.equal(f.requests.length,n);
  assert.deepEqual(f.client.currentAccount(),account);
 }finally{f.close();}
});
test('a computer the engine no longer accepts connects again by itself and repeats the request once',async()=>{
 const f=fixture();try{
  await f.client.connect();
  const path=join(f.home,'owners',digest(new URL(site).origin),'owner.json'), first=JSON.parse(readFileSync(path));
  f.connections.clear();
  await f.client.operation('list_my_projects',{});
  const second=JSON.parse(readFileSync(path));
  assert.notEqual(second.token,first.token);assert.equal(second.status,'approved');
  const urls=f.requests.slice(-4).map(r=>new URL(r.url).pathname);
  assert.deepEqual(urls,['/api/owner/projects','/api/auth/local-owner/session','/api/owner/local-computer','/api/owner/projects']);
  assert.equal(f.requests.at(-1).headers.Authorization,`Bearer ${second.token}`);
  // Concurrent refusals share one new connection.
  f.connections.clear();
  await Promise.all([f.client.listAgentStarts({expectedProfileId:'owner'}),f.client.listRepositoryAccess({expectedProfileId:'owner'})]);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/local-computer')).length,3);
  // A file saved by the retired browser approval is connected again too.
  writeFileSync(path,JSON.stringify({schema:'mlswarm-owner-1',origin:site,requestId:randomUUID(),pollingSecret:'p'.repeat(43),token:'t'.repeat(43),status:'pending'}));
  assert.equal((await f.client.connect()).status,'approved');assert.notEqual(JSON.parse(readFileSync(path)).token,'t'.repeat(43));
 }finally{f.close();}
});
test('owner mutations require explicit approval, revision and request identity',async()=>{
 const f=fixture();try{
  await f.client.connect();const n=f.requests.length;
  for(const args of [{project_id:P},{project_id:P,approved:true,expected_revision:-1,client_request_id:'x'},{project_id:'../other',approved:true,expected_revision:1,client_request_id:'x'}])await assert.rejects(f.client.operation('control_project',args));
  assert.equal(f.requests.length,n);
  const args={project_id:P,action:'start',approved:true,expected_revision:1,client_request_id:'retry-start',start_without_minimum:true};
  f.lose();await assert.rejects(f.client.operation('control_project',args),/Try the same request again/);await f.client.operation('control_project',args);
  assert.equal(f.requests.at(-1).body,f.requests.at(-2).body);assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expected_revision:1,client_request_id:'retry-start',action:'start',approved:true,start_without_minimum:true});
  const before=f.requests.length;
  for(const args of [{project_id:P,archived:true,expected_revision:0,client_request_id:'archive'},{project_id:P,archived:'yes',approved:true,expected_revision:0,client_request_id:'archive'},{project_id:P,archived:true,approved:true,client_request_id:'archive'}])await assert.rejects(f.client.operation('archive_my_project',args));assert.equal(f.requests.length,before);
  await f.client.operation('archive_my_project',{project_id:P,archived:true,approved:true,expected_revision:0,client_request_id:'archive'});
  assert.ok(f.requests.at(-1).url.endsWith(`/projects/${P}/personal-archive`));assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expected_revision:0,client_request_id:'archive',archived:true,approved:true});
  await assert.rejects(f.client.operation('end_computer_approval',{}),/unknown/);
 }finally{f.close();}
});
test('owner client rejects credential destinations outside trusted origins and redirects',async()=>{
 for(const site of ['https://example.com','https://karma42.ai','https://karma42-launch.web.app','https://karma42.ai.evil.test','http://karma42.ai','https://karma42.ai/path','https://x:y@karma42.ai'])assert.throws(()=>ownerOrigin(site));
 const f=fixture();try{await f.client.connect();assert.ok(f.requests.every(r=>r.redirect==='error'&&r.credentials==='omit'));}finally{f.close();}
 assert.ok(OWNER_TOOLS.every(t=>!('owner_ref' in t.inputSchema.properties)));
 assert.ok(OWNER_TOOLS.every(t=>!t.inputSchema.required.includes('owner_ref')));
});
test('an approved computer adds an agent with a private credential saved before contact, reused after a lost reply and never sent or returned',async()=>{
 const f=fixture();const folder=mkdtempSync(join(tmpdir(),'karma-agent-'));try{
  await f.client.connect();
  f.lose();await assert.rejects(f.client.addAgent({project_id:P,agent_name:'fox',folder}),/can’t be reached/);
  const added=await f.client.addAgent({project_id:P,agent_name:'fox',folder});
  const sent=f.requests.filter(r=>r.url.endsWith('/agents/connect')).map(r=>JSON.parse(r.body));
  assert.equal(sent.length,2);assert.equal(sent[1].candidateTokenHash,sent[0].candidateTokenHash);
  const dir=join(f.home,digest(`${site}/p/${P}`),'666f78-fox'),token=readFileSync(join(dir,'token'),'utf8');
  assert.match(token,/^[\w-]{43}$/);assert.equal(statSync(join(dir,'token')).mode&0o077,0);
  assert.ok(!JSON.stringify(added).includes(token));assert.ok(!JSON.stringify(f.requests).includes(token));
 }finally{f.close();rmSync(folder,{recursive:true,force:true});}
});

test('project lifecycle controls require approval and send exact action, revision and selected identity',async()=>{
 const f=fixture();try{
  await f.client.connect();
  for (const action of ['start','pause','resume','close','reopen']) { // add_time has its own test: it needs minutes
   const args={project_id:P,action,approved:true,expected_revision:3,client_request_id:'lifecycle-'+action};
   const count=f.requests.length;
   await assert.rejects(f.client.operation('control_project',{...args,approved:false}));
   await assert.rejects(f.client.operation('control_project',{...args,action:'delete'}));
   assert.equal(f.requests.length,count);
   await f.client.operation('control_project',args);
   assert.ok(f.requests.at(-1).url.endsWith('/projects/'+P+'/control'));
   assert.equal(f.requests.at(-1).headers['X-Mlswarm-Profile-Id'],'owner');
   assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expected_revision:3,client_request_id:args.client_request_id,action,approved:true});
  }
 }finally{f.close();}
});
test('unfinished agent additions cannot reuse a credential after switching accounts', async () => {
 const f=fixture(), folder=mkdtempSync(join(tmpdir(),'karma-agent-account-'));
 try {
  await f.client.connect();
  f.lose(); await assert.rejects(f.client.addAgent({project_id:P,agent_name:'fox',folder}));
  const path=join(f.home,'owners',digest(new URL(site).origin),'owner.json'), saved=JSON.parse(readFileSync(path));
  writeFileSync(path,JSON.stringify({...saved,personId:'other'}));
  const before=f.requests.length;
  await assert.rejects(f.client.addAgent({project_id:P,agent_name:'fox',folder}),/original human account/);
  assert.equal(f.requests.length,before);
 } finally {f.close();rmSync(folder,{recursive:true,force:true});}
});

test('time is added to the whole job through the approved project control; agents have no time of their own',async()=>{
 const f=fixture();try{
  await f.client.connect();
  await f.client.operation('list_working_agents',{project_id:P});
  assert.ok(f.requests.at(-1).url.endsWith(`/projects/${P}/my-workers`));
  await assert.rejects(f.client.operation('add_agent_time',{project_id:P,agent_id:'fox',id:randomUUID(),missionId:randomUUID(),expectedDeadlineAt:1000000,minutes:30,approved:true}),/unknown/);
  const args={project_id:P,client_request_id:'add-time-1',expected_revision:1,action:'add_time',minutes:30,approved:true};
  const before=f.requests.length;
  for(const bad of [{...args,approved:false},{...args,minutes:undefined},{...args,minutes:7},{...args,minutes:1445},{...args,action:'pause'},{...args,action:'start',minutes:3}])
   await assert.rejects(f.client.operation('control_project',bad));
  assert.equal(f.requests.length,before);
  await f.client.operation('control_project',args);
  const sent=JSON.parse(f.requests.at(-1).body);
  assert.equal(sent.action,'add_time');assert.equal(sent.minutes,30);
  await f.client.operation('control_project',{project_id:P,client_request_id:'start-1',expected_revision:2,action:'start',approved:true});
  assert.equal('minutes' in JSON.parse(f.requests.at(-1).body),false);
 }finally{f.close();}
});

test('the optional token cap is set and removed through the approved project control',async()=>{
 const f=fixture();try{
  await f.client.connect();
  const args={project_id:P,client_request_id:'tokens-1',expected_revision:1,action:'set_tokens',tokens:50000,approved:true};
  const before=f.requests.length;
  for(const bad of [{...args,tokens:undefined},{...args,tokens:0},{...args,tokens:1.5},{...args,tokens:'50000'},{...args,action:'add_time',minutes:30},{...args,action:'pause',tokens:10}])
   await assert.rejects(f.client.operation('control_project',bad));
  assert.equal(f.requests.length,before);
  await f.client.operation('control_project',args);
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expected_revision:1,client_request_id:'tokens-1',action:'set_tokens',approved:true,tokens:50000});
  assert.ok(f.requests.at(-1).url.endsWith(`/projects/${P}/control`));
  await f.client.operation('control_project',{...args,client_request_id:'tokens-2',expected_revision:2,tokens:null});
  assert.deepEqual(JSON.parse(f.requests.at(-1).body).tokens,null);
 }finally{f.close();}
});

test('Needs you option answers keep the exact approved selection and note across retries',async()=>{
 const f=fixture();try{
  await f.client.connect();
  const args={request_id:P,expected_revision:1,client_request_id:'option-answer',option_index:0,body:'Only public sources.',approved:true};
  const before=f.requests.length;
  for(const invalid of [{...args,approved:false},{...args,option_index:3},{...args,option_index:0.5},{...args,option_index:undefined,body:''}])await assert.rejects(f.client.operation('answer_human_request',invalid));
  assert.equal(f.requests.length,before);
  f.lose();await assert.rejects(f.client.operation('answer_human_request',args));
  await assert.rejects(f.client.operation('answer_human_request',{...args,option_index:1}));
  await f.client.operation('answer_human_request',args);
  assert.equal(f.requests.at(-1).body,f.requests.at(-2).body);
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expected_revision:1,client_request_id:'option-answer',option_index:0,body:'Only public sources.',approved:true});
  await f.client.operation('answer_human_request',{...args,client_request_id:'no-note',body:undefined});
  assert.equal(JSON.parse(f.requests.at(-1).body).body,'');
 }finally{f.close();}
});


test('multiple answers retain canonical selections, custom answer and note across retries',async()=>{
 const f=fixture();try{
  await f.client.connect();
  const args={request_id:P,expected_revision:1,client_request_id:'multiple-answer',option_indices:[2,0],custom_answer:'Also export CSV.',body:'Public sources only.',approved:true};
  const before=f.requests.length;
  for(const invalid of [{option_indices:[0,0]},{option_indices:[3]},{option_indices:[0.5]},{option_indices:'0'},{option_index:0},{custom_answer:''},{body:'x'.repeat(2000)}])await assert.rejects(f.client.operation('answer_human_request',{...args,...invalid}));
  assert.equal(f.requests.length,before);
  f.lose();await assert.rejects(f.client.operation('answer_human_request',args));
  await assert.rejects(f.client.operation('answer_human_request',{...args,custom_answer:'Different'}));
  await f.client.operation('answer_human_request',{...args,option_indices:[0,2]});
  assert.equal(f.requests.at(-1).body,f.requests.at(-2).body);
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expected_revision:1,client_request_id:'multiple-answer',option_indices:[0,2],custom_answer:args.custom_answer,body:args.body,approved:true});
 }finally{f.close();}
});

test('project reads any member can make go to their fixed project paths',async()=>{
 const f=fixture();try{
  await f.client.connect();
  for(const [name,args,path] of [
   ['get_project_overview',{},'/overview'],['list_project_agents',{q:'fox&x'},'/agents?q=fox%26x&limit=20'],
   ['list_project_conversations',{},'/conversations?limit=20'],['read_project_conversation',{thread_id:'t-1'},'/conversations/t-1?limit=20'],['read_project_chat',{},'/chat?limit=20'],
   ['read_project_updates',{source:'result_history'},'/updates?source=result_history&limit=20'],['list_project_tasks',{limit:5},'/tasks?limit=5'],['list_project_tasks',{limit:100,detail:true},'/tasks?limit=100'],['read_project_task',{task_id:'k_2'},'/tasks/k_2'],
  ]){
   await f.client.operation(name,{project_id:P,...args});
   assert.equal(f.requests.at(-1).url,`${site}/api/owner/projects/${P}${path}`);assert.equal(f.requests.at(-1).method,'GET');
  }
  const before=f.requests.length;
  for(const [name,args] of [['read_project_conversation',{thread_id:'../x'}],['read_project_task',{task_id:'a/b'}],['read_project_updates',{source:'all'}],['list_project_agents',{owner:true}],['list_project_tasks',{limit:101}],['list_project_tasks',{limit:0}],['list_project_conversations',{detail:'yes'}],['read_project_chat',{detail:true}]])await assert.rejects(f.client.operation(name,{project_id:P,...args}));
  assert.equal(f.requests.length,before);
 }finally{f.close();}
});
test('list tools return short rows by default and the server rows with detail: true',async()=>{
 const f=fixture();try{
  await f.client.connect();
  const long='x'.repeat(120);
  const sender={id:'a1',name:'Fox',kind:'agent',operatorId:'o',operatorName:'Ann',operatorPhoto:null};
  const pages={
   '/projects?':{projects:[{id:P,name:'Parser',summary:'A long summary',state:{phase:'running'},archiveRevision:3,role:'owner'},{projectId:P,title:'Proposal',kind:'proposal',status:'pending'}],next:'n1'},
   '/conversations?':{conversations:[
    {threadId:'t1',count:4,first:{id:'m1',body:long,summary:'Plan the parser',sender,audience:{kind:'direct',to:[{id:'a2',name:'Owl'}]}},latest:{id:'m4',body:long}},
    {threadId:'t2',count:1,first:{id:'m2',body:long,summary:null,sender,audience:{kind:'project'}},latest:{id:'m2',body:long}}],next:'n2',serverTime:1},
   '/needs-you?':{items:[{id:'h',projectTitle:'Parser',title:'Pick a format',question:long,context:long,status:'open',revision:2,suggestedOptions:['a']}],next:null},
   '/updates?':{items:[{id:'u1',title:null,body:long,author:{agent:{name:'Fox'},profile:{name:'Ann'}},publishedAt:5,screenshot:{alt:'a'}}],next:null},
  };
  f.respond(url=>Object.entries(pages).find(([k])=>url.includes(k))?.[1] ?? null);
  const projects=await f.client.operation('list_my_projects',{});
  assert.ok(f.requests.at(-1).url.endsWith('/api/owner/projects?limit=20'));
  assert.deepEqual(projects,{projects:[{id:P,name:'Parser'},{id:P,name:'Proposal'}],next:'n1'});
  assert.deepEqual(await f.client.operation('list_my_projects',{detail:true,cursor:'n1',limit:100}),pages['/projects?']);
  assert.ok(f.requests.at(-1).url.endsWith('/api/owner/projects?cursor=n1&limit=100'));
  const talk=await f.client.operation('list_project_conversations',{project_id:P});
  assert.deepEqual(talk.conversations,[{threadId:'t1',summary:'Plan the parser',from:'Fox',to:['Owl'],messages:4},{threadId:'t2',summary:'x'.repeat(80),from:'Fox',to:'project',messages:1}]);
  assert.equal(talk.next,'n2');
  assert.deepEqual((await f.client.operation('list_project_conversations',{project_id:P,detail:true})).conversations,pages['/conversations?'].conversations);
  assert.deepEqual((await f.client.operation('list_needs_you',{limit:3})).items,[{id:'h',projectTitle:'Parser',title:'Pick a format',status:'open',revision:2}]);
  assert.ok(f.requests.at(-1).url.endsWith('/api/owner/needs-you?limit=3'));
  assert.equal((await f.client.operation('list_needs_you',{detail:true})).items[0].question,long);
  assert.deepEqual((await f.client.operation('read_project_updates',{project_id:P})).items,[{id:'u1',title:'x'.repeat(80),author:'Fox',publishedAt:5}]);
 }finally{f.close();}
});

test('project update settings send only the fields the person changed', async () => {
 const f=fixture();try{
  await f.client.connect();
  const args={project_id:P,expected_revision:4,client_request_id:'pace-save',every_minutes:15,approved:true};
  await f.client.operation('set_project_update_settings',args);
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expectedRevision:4,clientRequestId:'pace-save',everyMinutes:15});
  await assert.rejects(f.client.operation('set_project_update_settings',{...args,every_minutes:10}),/5, 15 or 30/);
  await assert.rejects(f.client.operation('set_project_update_settings',{...args,topics:[]}),/at least one kind/);
  await assert.rejects(f.client.operation('set_project_update_settings',{...args,every_minutes:undefined}),/at least one update setting/);
  await f.client.operation('set_project_update_settings',{...args,every_minutes:undefined,client_request_id:'topics-save',topics:['blockers'],slides:false});
  assert.deepEqual(JSON.parse(f.requests.at(-1).body),{expectedRevision:4,clientRequestId:'topics-save',topics:['blockers'],slides:false});
  await f.client.operation('set_project_update_settings',{...args,client_request_id:'custom-save',additional_instructions:'Write in Hebrew.'});
  assert.equal(JSON.parse(f.requests.at(-1).body).additionalInstructions,'Write in Hebrew.');
  await f.client.operation('set_project_update_settings',{...args,client_request_id:'clear-save',additional_instructions:''});
  assert.equal(JSON.parse(f.requests.at(-1).body).additionalInstructions,'');
  await assert.rejects(f.client.operation('set_project_update_settings',{...args,additional_instructions:'🌱'.repeat(1001)}),/1000/);
  await assert.rejects(f.client.operation('set_project_update_settings',{...args,approved:false}),/approval/);
  const tool=OWNER_TOOLS.find(tool=>tool.name==='set_project_update_settings');
  assert.equal('interval_minutes' in tool.inputSchema.properties,false);
  assert.ok(!tool.inputSchema.required.includes('interval_minutes'));
 }finally{f.close();}
});

test('absent queued cancellation uses an object envelope and preserves cloud steering/unknown result lookup',async()=>{
 const {createRuntimeTools}=await import('../src/service/runtime-tools.mjs');
 const f=fixture();try{
  await f.client.connect();
  f.respond(url=>url.includes('/agent-start-controls/')?{cancellation:null}:{ok:true});
  let steeringReads=0;
  const expected={kind:'steer',missionId:randomUUID()};
  const tools=createRuntimeTools({principal:{site,ownerId:'owner'},controllers:{getOperation:async()=>null},ownerClient:f.client,steering:{result:async()=>{steeringReads++;return expected;}}});
  const query={target:{projectId:P,agentId:'synthetic-agent'},operationId:randomUUID()};
  assert.equal(await tools.callTool('get_agent_control_result',query),expected);assert.equal(steeringReads,1);
  const unknown=createRuntimeTools({principal:{site,ownerId:'owner'},controllers:{getOperation:async()=>null},ownerClient:f.client,steering:{result:async()=>null}});
  assert.equal(await unknown.callTool('get_agent_control_result',query),null);
  f.respond(()=>({cancellation:{cancelled:true}}));assert.deepEqual(await f.client.agentStartCancellation(query.operationId,query.target,{expectedProfileId:'owner'}),{cancelled:true});
 }finally{f.close();}
});

test('private-to-public conversion needs exact disclosure consent and preserves uncertain decisions',async()=>{
 const f=fixture();try{
  await f.client.connect();
  const args={project_id:P,expected_revision:4,expected_card_version:1,expected_listing_revision:0,expected_community_revision:1,confirm_public_chat:true,confirm_public_joining:true,summary:'A public game',category:'games',tags:['browser'],client_request_id:'publish-private-intent',approved:true};
  const before=f.requests.length;
  for(const patch of [{approved:false},{confirm_public_chat:false},{confirm_public_joining:false},{expected_community_revision:0}]){
   await assert.rejects(f.client.operation('make_project_public',{...args,...patch}));
  }
  assert.equal(f.requests.length,before);
  f.lose();await assert.rejects(f.client.operation('make_project_public',args));
  await assert.rejects(f.client.operation('make_project_public',{...args,expected_revision:5}));
  await f.client.operation('make_project_public',args);
  assert.ok(f.requests.at(-1).url.endsWith(`/projects/${P}/public-conversion`));
  assert.equal(f.requests.at(-1).method,'POST');
  const {project_id,...body}=args;assert.deepEqual(JSON.parse(f.requests.at(-1).body),body);
  assert.equal(OWNER_TOOLS.find(x=>x.name==='make_project_public').annotations.destructiveHint,true);
 }finally{f.close();}
});

test('owner refusals carry only the fields their callers read', async () => {
 const f=fixture();try{
  await f.client.connect();
  const client=createOwnerClient({home:f.home,workspace:f.workspace,site,now:()=>1000,fetchImpl:async()=>new Response(JSON.stringify({error:'not_found',message:'No such project'}),{status:404,headers:{'Retry-After':'5'}})});
  const error=await client.operation('get_project_overview',{project_id:P}).catch(e=>e);
  assert.equal(error.refusal,true);assert.equal(error.code,'not_found');
  assert.equal(Object.hasOwn(error,'httpStatus'),false);assert.equal(Object.hasOwn(error,'retryAfterSeconds'),false);
 }finally{f.close();}
});

test('an engine that is not running is named as such; a reply lost after sending stays unconfirmed', async () => {
 const f=fixture();try{
  await f.client.connect();
  const refused=Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'),{code:'ECONNREFUSED'})});
  const down=createOwnerClient({home:f.home,workspace:f.workspace,site,now:()=>1000,fetchImpl:async()=>{throw refused;}});
  const error=await down.operation('list_my_projects',{}).catch(e=>e);
  assert.equal(error.unreachable,true);assert.equal(error.code,'engine_unreachable');
  assert.equal(error.message,`The MyLittleSwarm engine isn’t running at ${site}. Start it with npm run setup.`);
  assert.notEqual(error.refusal,true);
  const lost=createOwnerClient({home:f.home,workspace:f.workspace,site,now:()=>1000,fetchImpl:async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('socket hang up'),{code:'ECONNRESET'})});}});
  const uncertain=await lost.operation('list_my_projects',{}).catch(e=>e);
  assert.notEqual(uncertain.unreachable,true);assert.match(uncertain.message,/can’t be reached right now/);
 }finally{f.close();}
});
