// Runs this checkout's connector against isolated private directories and a synthetic local cloud. No providers.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const exec=promisify(execFile), packageRoot=fileURLToPath(new URL('../',import.meta.url));
const packageVersion=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8')).version;
const root=await realpath(await mkdtemp(join(tmpdir(),'minions-checkout-service-')));
const home=join(root,'service'), credentials=join(root,'credentials');
let server, cli, env, clients=[], site;
const cloudRuns=new Map(), stopped=new Set(), ownerId='synthetic-owner';
let registrationCalls=0, modelCalls=0;
async function run(args,options={}) {return exec(process.execPath,[cli,...args],{env,cwd:root,timeout:30000,maxBuffer:1024*1024,...options});}
async function until(read,accept){const end=Date.now()+7000;while(Date.now()<end){const v=await read();if(accept(v))return v;await new Promise(r=>setTimeout(r,25));}throw new Error('Checkout service acceptance timed out.');}
const parse=reply=>{assert.ok(!reply.isError,'Checkout MCP operation refused');return JSON.parse(reply.content.find(p=>p.type==='text').text);};
try{
  const installed=packageRoot;cli=join(installed,'src/cli.mjs');
  const require=createRequire(join(installed,'package.json'));
  const {Client,StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')));
  const state=await import(pathToFileURL(join(installed,'src/state.mjs')));
  const session=await import(pathToFileURL(join(installed,'src/session.mjs')));
  const importInstalled=path=>import(pathToFileURL(join(installed,'src',path)));
  const known=new Map();
  server=createServer(async(req,res)=>{
    const reply=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    try{
      let body='';for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):{};
      if(req.url==='/api/owner/participations/sync')return reply({ok:true});
      if(req.url==='/api/owner/participation-controls')return reply({commands:[],serverTime:Date.now()});
      if(req.url==='/api/owner/member-projects')return reply({projects:[...known.values()].map(v=>({projectId:v.projectId,projectName:'Synthetic project'})),next:null});
      const observations=/^\/api\/owner\/projects\/([a-f0-9]{64})\/my-workers$/.exec(req.url??'');
      if(observations&&[...known.values()].some(v=>v.projectId===observations[1]))return reply({agents:[...known.values()].filter(v=>v.projectId===observations[1]).map(v=>({agentId:v.agentId,agentName:'Synthetic checkout agent',worker:{session:null}})),queued:[],serverTime:Date.now()});
      const match=/^\/p\/([a-f0-9]{64})\/v2(.*)$/.exec(req.url??'');
      if(!match)return reply({error:'not_found'},404);
      const [,,path]=match,projectId=match[1];
      const agent=[...known.values()].find(v=>v.projectId===projectId&&req.headers.authorization===`Bearer ${v.token}`);
      if(!agent)return reply({error:'unauthorized'},401);
      if(path==='/chat-participations'){
        registrationCalls++;const issued=cloudRuns.get(input.client_run_id)??{run_id:input.client_run_id,generation:cloudRuns.size+1,poll_seconds:20,protocol:2};cloudRuns.set(input.client_run_id,issued);return reply(issued);
      }
      if(/^\/runs\/[^/]+\/phase$/.test(path)){const id=path.split('/')[2];stopped.add(id);return reply({ok:true,run_id:id,phase:'stopping'});}
      if(path==='/mcp'){
        const run=req.headers['x-pilot-run'];if(stopped.has(run))return reply({error:'run_superseded'},409);
        const tasksEnabled=agent.agentId==='synthetic-0';
        if(input.method==='tools/list')return reply({jsonrpc:'2.0',id:input.id,result:{tools:['get_project','list_tasks','get_task',...(tasksEnabled?['create_task','update_task','claim_task','release_task','comment_task','link_task']:[])].map(name=>({name}))}});
        const name=input.params.name;
        const value=name==='get_project'?{tasks:{enabled:tasksEnabled,tools:tasksEnabled?['list_tasks','get_task','create_task','update_task','claim_task','release_task','comment_task','link_task']:['list_tasks','get_task']},project:{name:'Synthetic project',started:true,paused:false,completedAt:null,mission:'No models',rules:'Synthetic',repoUrl:'https://github.com/synthetic/repo',mergeApproval:'humans'},you:{agentId:agent.agentId,participation:{identity:{projectId,agentId:agent.agentId,profileId:ownerId},persona:{text:'',revision:0},observedAt:Date.now()}}}:{messages:[]};
        return reply({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:JSON.stringify(value)}]}});
      }
      if(path==='/wait'){modelCalls++;return reply({error:'unexpected_native_start'},500);}
      return reply({error:'unexpected_request'},400);
    }catch{return reply({error:'synthetic_fixture_error'},500);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));site=`http://127.0.0.1:${server.address().port}`;
  env={...process.env,MINIONS_SERVICE_HOME:home,MINIONS_CREDENTIAL_HOME:credentials,MINIONS_SITE_URL:site,MINIONS_NO_BROWSER:'1'};
  state.ensureHome(credentials);state.ensureHome(join(credentials,'owners'));state.ensureHome(join(credentials,'owners',state.digest(site)));
  state.writePrivate(join(credentials,'owners',state.digest(site),'owner.json'),{schema:'minions-owner-1',origin:site,requestId:randomUUID(),pollingSecret:randomBytes(32).toString('base64url'),token:randomBytes(32).toString('base64url'),status:'approved',personId:ownerId,personName:'Synthetic owner',connectionExpiresAt:Date.now()+86400000});
  for(let i=0;i<2;i++){
    const projectId=String(i+1).repeat(64),agentId=`synthetic-${i}`,url=`${site}/p/${projectId}`,folder=join(root,`checkout-${i}`);await mkdir(folder);
    const token=randomBytes(32).toString('base64url'),id=session.sessionId(url,agentId),dir=state.connectionDir(credentials,id);
    const record={schema:'mcp-connection-1',id,service:url,ownerProfileId:ownerId,agentId,agentName:`agent-${i}`,folder,repo:'https://github.com/synthetic/repo',approvedAt:Date.now(),createdAt:Date.now(),ownFolder:true};
    state.writePrivate(join(dir,'connection.json'),record);state.writePrivate(join(dir,'token'),token);known.set(agentId,{projectId,agentId,token});
  }
  assert.equal((await run(['--version'])).stdout.trim(),packageVersion);
  const skillBundle=JSON.parse((await run(['skill','--json'])).stdout);
  for(const [file,text] of Object.entries(skillBundle.files)) assert.equal(await readFile(join(installed,'skills/minions',file),'utf8'),text);
  await assert.rejects(run(['mcp-serve']),()=>true);
  const start=JSON.parse((await run(['service-start'])).stdout);assert.equal(start.running,true);
  const endpointModule=await importInstalled('service/endpoint-file.mjs');const endpoint=endpointModule.readRuntimeEndpoint(home);
  for(const clientName of ['synthetic-Claude-checkout','synthetic-Codex-checkout']){
    const client=new Client({name:clientName,version:'0.0.0-test'});await client.connect(new StreamableHTTPClientTransport(new URL(start.url),{requestInit:{headers:{Authorization:`Bearer ${endpoint.token}`}}}));clients.push(client);
  }
  const catalogs=await Promise.all(clients.map(c=>c.listTools()));
  assert.deepEqual(catalogs[0].tools.map(v=>v.name),catalogs[1].tools.map(v=>v.name));
  assert.ok(!catalogs[0].tools.some(t=>t.name==='connect_project_agent'||t.name==='start_project_worker'||t.name==='open_project_waiting_room'));
  assert.equal(new Set(catalogs[0].tools.map(t=>t.name)).size,catalogs[0].tools.length);
  for(const name of ['get_task_tools','call_task_tool'])assert.ok(catalogs[0].tools.some(t=>t.name===name));
  for(const name of ['create_task','update_task','assign_task','claim_task','release_task','comment_task','link_task'])assert.ok(!catalogs[0].tools.some(t=>t.name===name));
  for(const name of ['get_project_join_link','start_owned_project','runtime_archive_failed_launch_report','get_updates','find_work','configure_owned_project','set_agent_work_settings','extend_agent_work','get_owned_project_status','open_vote','cast_vote','get_vote','list_votes','resolve_vote','open_decision','vote','get_decision','list_decisions','decide_direction'])assert.ok(!catalogs[0].tools.some(t=>t.name===name));
  assert.ok(catalogs[0].tools.some(t=>t.name==='work_in_this_chat'));
  for(const name of ['make_project_public'])assert.ok(catalogs[0].tools.some(t=>t.name===name),`Checkout MCP catalog must include ${name}`);
  for(const name of ['get_agent_run_log','get_agent_run_diagnostics','recover_agent_run'])assert.ok(catalogs[0].tools.some(t=>t.name===name));
  const call=async(client,name,args={})=>parse(await client.callTool({name,arguments:args}));
  const guideText=reply=>{assert.ok(!reply.isError);return reply.content[0].text;};
  assert.equal(guideText(await clients[0].callTool({name:'get_minions_guide',arguments:{}})),skillBundle.content);
  for(const file of Object.keys(skillBundle.files).filter(file=>file.startsWith('references/'))){
    const section=file.slice('references/'.length,-3);
    assert.equal(guideText(await clients[1].callTool({name:'get_minions_guide',arguments:{section}})),skillBundle.files[file]);
    assert.equal((await run(['skill','--section',section])).stdout.trimEnd(),skillBundle.files[file].trimEnd());
  }
  const userHome=join(root,'synthetic-clients');await mkdir(join(userHome,'.codex'),{recursive:true});await mkdir(join(userHome,'.claude'),{recursive:true});
  const {connectClients}=await importInstalled('client-setup.mjs');const connected=connectClients({home,userHome,env:{}});assert.ok(connected.every(result=>result.connected),JSON.stringify(connected));
  for(const client of ['.claude','.agents'])for(const [file,text]of Object.entries(skillBundle.files))assert.equal(await readFile(join(userHome,client,'skills/minions',file),'utf8'),text);
  // Read the checkout's mission-pinned workflows through a real scoped worker MCP
  // connection, with a synthetic active turn and no native/provider execution.
  const workerGuide=await importInstalled('worker-guidance.mjs');
  const {createWorkerOperations}=await importInstalled('service/worker-operations.mjs');
  const {createRuntimeApplication}=await importInstalled('service/application.mjs');
  const {startRuntimeService}=await importInstalled('service/mcp-service.mjs');
  const agent=[...known.values()][0],workerState=join(root,'worker-private'),workerFolder=join(root,'checkout-0');state.ensureHome(workerState);
  const workerMission={target:{site,ownerId,projectId:agent.projectId,agentId:agent.agentId},missionId:randomUUID(),generation:1,state:'running',currentTurnId:randomUUID(),deadlineAt:Date.now()+60000};
  state.writePrivate(join(workerState,'instructions.md'),await readFile(join(installed,'runtime/AGENT_PROMPT_V2.md'),'utf8'));
  state.writePrivate(join(workerState,'worker-guides.json'),await readFile(join(installed,'runtime/worker-guides.json'),'utf8'));
  const workerMissionState=join(workerState,`mission-${workerMission.missionId}-1`);state.ensureHome(workerMissionState);workerGuide.snapshotWorkerInstructions(workerState,workerMissionState);
  const getMission=async()=>structuredClone(workerMission),operations=createWorkerOperations({store:{getMission},resolveBinding:async()=>({url:`${site}/p/${agent.projectId}`,token:agent.token,folder:workerFolder,stateDir:workerState})});
  const workerApp=createRuntimeApplication({controllers:{getMission},principal:{site,ownerId},workerOperations:operations});
  const guideService=await startRuntimeService({controllers:{getMission},principal:{site,ownerId},application:workerApp});
  const workerEndpoint=await guideService.issueWorker({target:workerMission.target,missionId:workerMission.missionId,generation:1});
  const guideClient=new Client({name:'synthetic-checkout-worker-guide',version:'test'});
  try{
    await guideClient.connect(new StreamableHTTPClientTransport(new URL(workerEndpoint.url),{requestInit:{headers:{Authorization:`Bearer ${workerEndpoint.token}`}}}));
    const workerNames=(await guideClient.listTools()).tools.map(tool=>tool.name);assert.ok(workerNames.includes('get_minions_guide'));assert.ok(workerNames.includes('upload_project_image'));assert.ok(!workerNames.includes('make_project_public'));assert.ok(!workerNames.includes('control_agent'));
    assert.equal((await guideClient.callTool({name:'get_minions_guide',arguments:{section:'project-work'}})).isError,true);
    await call(guideClient,'get_project');
    for(const section of workerGuide.WORKER_GUIDE_SECTIONS)assert.ok(guideText(await guideClient.callTool({name:'get_minions_guide',arguments:{section}})).endsWith(skillBundle.files[`references/${section}.md`]));
    assert.equal((await guideClient.callTool({name:'get_minions_guide',arguments:{section:'computer'}})).isError,true);
  }finally{await guideClient.close();await workerEndpoint.revoke();await operations.release({kind:'worker',target:workerMission.target,missionId:workerMission.missionId,generation:1});await guideService.close();}
  assert.equal(registrationCalls,0);assert.equal(modelCalls,0);
  const records=[];
  for(const [i,agent]of [...known.values()].entries()){
    const approvedAt=Date.now(),target={projectId:agent.projectId,agentId:agent.agentId};
    const accepted=await call(clients[i],'work_in_this_chat',{operationId:randomUUID(),kind:'claim',target,participationId:randomUUID(),payload:{approved:true,approvedAt,deadlineAt:approvedAt+300000,scope:'Synthetic checkout service; no models.'}});
    records.push(accepted.participation);
    const project=await call(clients[i],'get_project',{participation_ref:accepted.participation.participationRef});assert.equal(project.you.agentId,agent.agentId);
    const taskCatalog=await call(clients[i],'get_task_tools',{participation_ref:accepted.participation.participationRef});
    assert.equal(taskCatalog.enabled,i===0);assert.equal(taskCatalog.tools.length,i===0?8:2);assert.ok(!taskCatalog.tools.some(t=>t.name==='assign_task'));
    if(i===1)assert.deepEqual(taskCatalog.tools.map(t=>t.name),['list_tasks','get_task']);
  }
  for(const record of records)await call(clients[0],'work_in_this_chat',{operationId:randomUUID(),kind:'release',target:{projectId:record.target.projectId,agentId:record.target.agentId},participationId:record.participationId,generation:record.generation,payload:{}});
  await until(async()=>stopped.size,n=>n===2);
  for(const c of clients)await c.close();clients=[];
  for(const client of ['claude','codex']){
    const text=(await run(['mcp-config','--client',client])).stdout;assert.ok(text.includes(start.url));assert.ok(text.includes(client==='claude'?'headersHelper':'http_headers_helper'));assert.ok(!text.includes(endpoint.token));
  }
  assert.equal(JSON.parse((await run(['service-stop'])).stdout).stopped,true);
  // Seed historical evidence only while the disposable service is stopped.
  // These are synthetic records, not native execution or provider acceptance.
  const {openRuntimeStore}=await importInstalled('service/store.mjs');
  const {createRunJournal}=await importInstalled('run-journal.mjs');
  let recoveryMission,recoveryPause;const evidenceMissions=[],ledger=await openRuntimeStore({directory:join(home,'ledger')});
  try{
    for(const [i,agent]of [...known.values()].entries()){
      const target={site,ownerId,projectId:agent.projectId,agentId:agent.agentId},provider=i?'codex':'claude';
      const {mission}=await ledger.accept({version:2,kind:'start',operationId:randomUUID(),missionId:randomUUID(),target,
        payload:{scope:'Synthetic historical inspection; no native execution.',deadlineAt:Date.now()+300000,execution:{provider,model:null}}});
      await ledger.settleMission({missionId:mission.missionId,generation:mission.generation,reason:'synthetic_history',cleanupConfirmed:true});
      const agentState=join(home,'agents',state.digest(JSON.stringify([site,ownerId,target.projectId,target.agentId])));
      const directory=join(agentState,`mission-${mission.missionId}-${mission.generation}`);state.ensureHome(directory);
      const journal=createRunJournal({directory,identity:{target,missionId:mission.missionId,generation:mission.generation,provider,model:null},redact:[agent.token]});
      const attemptId=randomUUID(),turnId=randomUUID();
      journal.append({kind:'attempt_started',attemptId,turnId});
      journal.append({kind:'assistant_text',attemptId,turnId,text:`Synthetic ${provider} output ${agent.token}`});
      journal.append({kind:'attempt_finished',attemptId,turnId,failed:false,interrupted:false,cleanupConfirmed:true});
      assert.equal(journal.status().availability,'available');evidenceMissions.push(mission);
    }
    const agent=[...known.values()][0],target={site,ownerId,projectId:agent.projectId,agentId:agent.agentId};
    ({mission:recoveryMission}=await ledger.accept({version:2,kind:'start',operationId:randomUUID(),missionId:randomUUID(),target,
      payload:{scope:'Synthetic interrupted recovery; do not execute.',deadlineAt:Date.now()+300000,execution:{provider:'claude',model:null}}}));
    recoveryPause={version:2,operationId:randomUUID(),kind:'pause',missionId:recoveryMission.missionId,generation:recoveryMission.generation,target:recoveryMission.target,payload:{}};
    await ledger.accept(recoveryPause);
  }finally{await ledger.close();}
  const restarted=JSON.parse((await run(['service-start'])).stdout);assert.equal(restarted.url,start.url);assert.notEqual(restarted.incarnation,start.incarnation);
  for(const mission of evidenceMissions){
    const flags=['--mission',mission.missionId,'--project',mission.target.projectId,'--agent',mission.target.agentId];
    const first=JSON.parse((await run(['run-log',...flags,'--limit','1'])).stdout);assert.equal(first.availability,'available');assert.equal(first.records.length,1);assert.equal(first.hasMore,true);
    const next=JSON.parse((await run(['run-log',...flags,'--after',String(first.nextAfter),'--limit','1'])).stdout);
    assert.match(next.records[0].text,/Synthetic (claude|codex) output \[REDACTED\]/);
    const diagnosis=JSON.parse((await run(['run-diagnostics',...flags])).stdout);assert.equal(diagnosis.readOnly,true);assert.equal(diagnosis.automaticRecoverySupported,false);
  }
  const pauseFlags=['--mission',recoveryMission.missionId,
    '--project',recoveryMission.target.projectId,'--agent',recoveryMission.target.agentId,'--generation',String(recoveryMission.generation),
    '--request-id',recoveryPause.operationId,'--approve'];
  const savedPause=JSON.parse((await run(['run-pause',...pauseFlags])).stdout);assert.equal(savedPause.created,false);assert.equal(savedPause.mission.state,'recovery_required');
  await assert.rejects(run(['run-resume',...pauseFlags.map(value=>value===recoveryPause.operationId?randomUUID():value),'--pause-request',recoveryPause.operationId]));
  const recoverFlags=['run-recover','--mission',recoveryMission.missionId,
    '--project',recoveryMission.target.projectId,'--agent',recoveryMission.target.agentId,'--generation',String(recoveryMission.generation),
    '--request-id',randomUUID(),'--action','finalize','--reason','Close synthetic interrupted work without execution','--approve'];
  const recovered=JSON.parse((await run(recoverFlags)).stdout);assert.equal(recovered.mission.state,'stopped');
  const repeated=JSON.parse((await run(recoverFlags)).stdout);assert.equal(repeated.created,false);assert.deepEqual(repeated.receipt,recovered.receipt);
  assert.equal(registrationCalls,2,'Restart must not reactivate participation');assert.equal(modelCalls,0);
  assert.equal(JSON.parse((await run(['service-stop'])).stdout).stopped,true);
  const report={version:packageVersion,checkout:packageRoot,toolCount:catalogs[0].tools.length,catalogCharacters:JSON.stringify(catalogs[0].tools).length,guideRevision:JSON.parse((await run(['skill','--json'])).stdout).guide_revision,projects:2,registrations:registrationCalls,modelRuns:0,passed:['checkout-connector','retired-command-refused','detached-shared-service','two-HTTP-clients','separate-project-identities','explicit-current-chat-grants','durable-terminal-delivery','native-auth-helper-config','stable-restart-no-auto-work','private-run-evidence-restart-read','read-only-recovery-CLI','owner-approved-recovery-CLI-exact-retry','paused-restart-refuses-resume','authenticated-stop']};
  const output=process.env.MINIONS_CHECKOUT_EVIDENCE;if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error.stack);process.exitCode=1;}
finally{
  await Promise.allSettled(clients.map(c=>c.close()));
  if(cli&&env)try{await run(['service-stop']);}catch{}
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(!process.env.MINIONS_KEEP_CHECKOUT_TEST)await rm(root,{recursive:true,force:true});
}
