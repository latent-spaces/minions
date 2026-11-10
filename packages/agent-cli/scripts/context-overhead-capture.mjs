// Opt-in experiment, never imported by product startup. Real runtime/facade;
// synthetic project coordination only, no production backend or analytics writes.
import {mkdtemp,mkdir,realpath,writeFile,readFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createProvider} from '../runtime/providers.mjs';
import {createLocalWorkerAdapter} from '../src/native-worker-adapter.mjs';
import {createNativeAdapterFactory,checkoutGitEnvironment} from '../src/service/native-bindings.mjs';
import {createWorkerOperations} from '../src/service/worker-operations.mjs';
import {createWorkerBridgeFactory} from '../src/service/worker-bridge.mjs';
import {startRuntimeService} from '../src/service/mcp-service.mjs';
import {createRuntimeApplication} from '../src/service/application.mjs';
import {verifyBundle} from '../src/system.mjs';
import {VERSION} from '../src/version.mjs';
import {controllerPrompt} from '../src/turn-context.mjs';
import {directTurn,primeWorkspace} from './context-overhead-direct.mjs';
import {stopMarkedProcesses} from '../src/leftover-processes.mjs';
import {stopWindowsMission} from '../src/windows-supervision.mjs';
import {compareContextOverhead} from '../../../tools/benchmarks/context-overhead.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const neutral='Work only in this disposable checkout. Read data.json and use the task and conversation facts to compute the result. You may read files, make the requested JSON files and use supplied project tools. Do not install software, access other folders or external services, change configuration, commit, push, publish or spawn agents. Keep the final response brief and end with WORK_NEXT: waiting.';
const task='Sum the values in data.json and add the adjustment from conversation adjustment-thread. Write INITIAL.json as an object with the single numeric field sum.';
const conversation='The initial adjustment is 5.';
const steering='The adjustment is now -2. Recompute the same sum and write STEERING.json as an object with the single numeric field sum. Keep INITIAL.json unchanged. End with WORK_NEXT: waiting.';
const fixture='{"values":[2,3,7]}\n';
export const contextCapturePlan={provider:'codex',turnsPerArm:2,task:'Read values [2,3,7] from data.json; get the task and conversation adjustment 5; write INITIAL.json {"sum":17}.',steering:'Change adjustment to -2; write STEERING.json {"sum":10}, preserving INITIAL.json.',direct:'Same facts inline, no MyLittleSwarm instructions or MCP.',mlswarm:'Production instructions, prompt builder, full scoped catalog and task/conversation reads; synthetic coordination only.',limits:'Explicit available model and effort, actual platform, 30–300 seconds for all four controller turns. Each turn may contain several model requests.',interpretation:'One matched scenario, not general project overhead or per-source token shares.'};
export function contextCaptureOptions(args){
 const options={approved:false};
 for(let i=0;i<args.length;i++){
  const flag=args[i];if(flag==='--approved'&&!options.approved){options.approved=true;continue;}
  const key=({'--model':'model','--effort':'effort','--expect-platform':'platform','--timeout-seconds':'timeoutSeconds','--codex':'codex'})[flag];
  if(!key||options[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Invalid or duplicate context-capture option.');options[key]=args[++i];
 }
 if(!options.approved||!options.model||!options.effort||!options.platform||!options.timeoutSeconds)throw new Error('Select --approved --model MODEL --effort EFFORT --expect-platform PLATFORM --timeout-seconds SECONDS.');
 options.timeoutSeconds=Number(options.timeoutSeconds);return options;
}
export async function captureContextOverhead(options,{executables={codex:options.codex??'codex'},envSource=process.env,signal=new AbortController().signal,syntheticNative=false,onProgress=()=>{}}={}){
 if(options.approved!==true||![options.model,options.effort].every(v=>typeof v==='string'&&/^[A-Za-z0-9_:.-]{1,150}$/.test(v)))throw new Error('Explicitly select an available Codex model and effort for this live comparison.');
 if(options.platform!==process.platform||!['win32','darwin','linux'].includes(options.platform)||Number(process.versions.node.split('.')[0])<24)throw new Error('Select the actual supported host platform and use Node 24 or newer.');
 if(!Number.isSafeInteger(options.timeoutSeconds)||options.timeoutSeconds<30||options.timeoutSeconds>300)throw new Error('Use a whole experiment deadline from 30 to 300 seconds.');
 if(envSource.OPENAI_BASE_URL&&envSource.OPENAI_BASE_URL!=='https://api.openai.com')throw new Error('This comparison cannot preserve a custom model endpoint.');
 signal=AbortSignal.any([signal,AbortSignal.timeout(options.timeoutSeconds*1000)]);
 signal.throwIfAborted();
 const root=await realpath(await mkdtemp(join(tmpdir(),'mlswarm-context-pair-'))),deadline=Date.now()+options.timeoutSeconds*1000;
 const directMark=hash(root+'direct').slice(0,32);
 let service,adapter,cleanupConfirmed=true,directCleaned=false;
 const bundle=verifyBundle(),folders={};
 const principal={site:'https://synthetic.example',ownerId:'context-owner'},target={...principal,projectId:'context-project',agentId:'context-agent'};
 const mission={target,missionId:randomUUID(),generation:1,state:'running',currentTurnId:randomUUID(),deadlineAt:deadline,execution:{provider:'codex',model:options.model},scope:`${neutral} Read task sum-task with get_task and conversation adjustment-thread with read_thread, then do that task.`};
 const configFile=join(envSource.CODEX_HOME??join(envSource.HOME??envSource.USERPROFILE??'','.codex'),'config.toml');
 const configDigest=async()=>{try{return hash(await readFile(configFile));}catch(error){if(error.code==='ENOENT')return hash('absent');throw error;}};
 let initialConfig,provider;
 const cleanDirect=async()=>{if(provider&&!directCleaned){if(process.platform==='win32')await stopWindowsMission(directMark,{env:provider.environment()});else await stopMarkedProcesses(directMark);directCleaned=true;}};
 try{
  for(const mode of ['direct','mlswarm']){
   const folder=join(root,mode,'checkout'),stateDir=join(root,mode,'state');folders[mode]={folder,stateDir};
   await mkdir(folder,{recursive:true,mode:0o700});await mkdir(stateDir,{recursive:true,mode:0o700});
   execFileSync('git',['init','-q',folder],{env:checkoutGitEnvironment(envSource),windowsHide:true});
   execFileSync('git',['-C',folder,'remote','add','origin','https://github.com/synthetic/context-pair.git'],{env:checkoutGitEnvironment(envSource),windowsHide:true});
   await writeFile(join(folder,'data.json'),fixture,{mode:0o600});
   await writeFile(join(stateDir,'instructions.md'),mode==='mlswarm'?bundle.files['AGENT_PROMPT_V2.md']:'',{mode:0o600});
   if(mode==='mlswarm')await writeFile(join(stateDir,'worker-guides.json'),bundle.files['worker-guides.json'],{mode:0o600});
  }
  provider=createProvider('codex',{codex:executables.codex,model:options.model,effort:options.effort,repoDir:folders.direct.folder,permissionMode:'acceptEdits',passEnv:'',turnBudgetUsd:0},{envSource});
  const clientVersion=(await provider.preflight({signal})).label;
  for(const mode of ['direct','mlswarm'])await primeWorkspace({provider,...folders[mode],instructionsFile:join(folders.direct.stateDir,'instructions.md'),deadline,signal,clientVersion:VERSION,mark:directMark});
  // The desktop client may observe/register the new threads asynchronously.
  let lastConfig=await configDigest(),stableSince=Date.now();
  while(Date.now()-stableSince<1500){signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,100));const next=await configDigest();if(next!==lastConfig){lastConfig=next;stableSince=Date.now();}}
  initialConfig=lastConfig;
  const controllers={getMission:async input=>input.missionId===mission.missionId&&JSON.stringify(input.target)===JSON.stringify(target)?structuredClone(mission):null,health:async()=>({ready:true})};
  const operations=createWorkerOperations({store:controllers,resolveBinding:async()=>({...folders.mlswarm,url:`${principal.site}/p/${target.projectId}`,token:'synthetic-context-only'}),fetchImpl:async(url,request)=>{
   signal.throwIfAborted();if(url!==`${principal.site}/p/${target.projectId}/v2/mcp`)throw new Error('Experiment refused an external destination.');
   const rpc=JSON.parse(request.body);let result;
   if(rpc.method==='tools/list')result={tools:JSON.parse(bundle.files['project-tools.json']).tools.filter(t=>t.name!=='manage_team')};
   else{
    const name=rpc.params?.name;
    const value=name==='get_project'?{project:{name:'Synthetic context comparison',mission:neutral,rules:neutral,repoUrl:'https://github.com/synthetic/context-pair',nativeTasksEnabled:true,mergeApproval:'anyone',started:true,paused:false,completedAt:null},tasks:{enabled:true},teams:{enabled:false,tools:['read_teams']},you:{agentId:target.agentId,participation:{identity:{projectId:target.projectId,agentId:target.agentId,profileId:principal.ownerId},persona:{text:'',revision:0},observedAt:Date.now()}}}
     :name==='read_agent_inbox'?{items:[],position:0,acknowledged:0,has_more:false}
     :name==='get_task'&&rpc.params.arguments.task_id==='sum-task'?{task:{id:'sum-task',title:'Compute a sum',description:task}}
     :name==='read_thread'&&rpc.params.arguments.thread_id==='adjustment-thread'?{messages:[{id:'adjustment-message',body:conversation}]}:null;
    result=value?{content:[{type:'text',text:JSON.stringify(value)}]}:{isError:true,content:[{type:'text',text:'This experiment permits only the specified project, task and conversation reads.'}]};
   }
   return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}),{status:200});
  }});
  service=await startRuntimeService({controllers,principal,application:createRuntimeApplication({controllers,principal,workerOperations:operations})});
  const bridge=createWorkerBridgeFactory({getService:()=>service,workerOperations:operations});
  const binding={target,...folders.mlswarm,repository:'synthetic/context-pair',createBridge:m=>bridge.createBridge(m),prepareParticipation:args=>bridge.prepareParticipation(args),readProjectState:async()=>({project:{started:true,paused:false,closed:false},pending:0,acknowledged:0})};
  const factory=createNativeAdapterFactory({bindings:[binding],registryRoot:join(root,'claims'),executables,envSource,adapterFactory:args=>createLocalWorkerAdapter({...args,effort:options.effort})});
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:checkoutGitEnvironment(envSource),encoding:'utf8',windowsHide:true}).trim();
  const settings={provider:'codex',effort:options.effort,clientVersion,scenarioDigest:hash(JSON.stringify([neutral,task,conversation,steering])),fixtureDigest:hash(fixture),sharedConfigDigest:hash(JSON.stringify({nativeConfig:initialConfig,platform:process.platform,node:process.version,kit:VERSION,model:options.model,effort:options.effort,sandbox:'workspace-write',approval:'on-request',reviewer:'auto_review',hooks:false,apps:false,plugins:false,multiAgent:false})),sessionPhase:'new'};
  const records={},sourceMeasurements=[];
  for(const mode of ['direct','mlswarm']){
   const turns=[],session=provider.newSession('direct-experiment',folders.direct.folder);let initialResultDigest;
   if(mode==='mlswarm')adapter=await factory(mission,{signal});
   for(let i=0;i<2;i++){
    onProgress({arm:mode,turn:i+1,phase:'starting'});
    signal.throwIfAborted();if(Date.now()>=deadline)throw new Error('Experiment deadline expired.');
    if(await configDigest()!==initialConfig)throw new Error('Native configuration changed during the experiment.');
    let outcome;
    if(mode==='direct')outcome=await directTurn({provider,...folders.direct,instructionsFile:join(folders.direct.stateDir,'instructions.md'),session,prompt:i?steering:`${neutral}\nTask: ${task}\nConversation: ${conversation}`,deadline,signal,clientVersion:VERSION,mark:directMark});
    else{
     mission.currentTurnId=randomUUID();const prompt=controllerPrompt({scope:mission.scope,steering:i?[{message:steering}]:[],notices:[]});
     cleanupConfirmed=false;outcome=await adapter.run({...prompt,turnId:mission.currentTurnId,signal,deadline});cleanupConfirmed=outcome.cleanupConfirmed===true;
     if(!cleanupConfirmed||outcome.failed||outcome.interrupted)throw new Error('MyLittleSwarm turn did not finish with confirmed native cleanup.');
     sourceMeasurements.push(outcome.usage?.context??null);
     if(i===0&&!['get_task','read_thread'].every(name=>outcome.usage?.context?.byTool?.some(t=>t.name===name&&t.calls>0)))throw new Error('MyLittleSwarm did not retrieve the required task and conversation.');
    }
    if(await readFile(join(folders[mode].folder,'data.json'),'utf8')!==fixture)throw new Error('The input fixture changed.');
    const file=await open(join(folders[mode].folder,i?'STEERING.json':'INITIAL.json'),'r');let value,raw;
    try{if((await file.stat()).size>4096)throw new Error('Result too large.');raw=await file.readFile('utf8');value=JSON.parse(raw);}finally{await file.close();}
    const expected=i?10:17;if(Object.keys(value).length!==1||value.sum!==expected)throw new Error('The task result did not match the scenario.');
    if(i===0)initialResultDigest=hash(raw);
    else if(hash(await readFile(join(folders[mode].folder,'INITIAL.json')))!==initialResultDigest)throw new Error('Steering changed the original result.');
    const usage=outcome.usage;if(!usage?.model||turns.length&&usage.model!==turns[0].model)throw new Error('Native model identity was unavailable or changed.');
    turns.push({model:usage.model,resultDigest:hash(JSON.stringify({sum:expected})),input:usage.tokens?.input??null,output:usage.tokens?.output??null,cacheRead:usage.tokens?.cacheRead??null,cacheWrite:usage.tokens?.cacheWrite??null,inputSemantics:usage.inputSemantics});
    onProgress({arm:mode,turn:i+1,phase:'verified'});
   }
   records[mode]={...settings,mode,model:turns[0].model,turns:turns.map(({model,...turn})=>turn)};
   if(mode==='direct')await cleanDirect();
   if(adapter){await adapter.release({cleanupConfirmed});adapter=null;}
  }
  if(await configDigest()!==initialConfig)throw new Error('Native configuration changed during the experiment.');
  const report=compareContextOverhead(records.direct,records.mlswarm);
  for(const [mode,record]of Object.entries(records))await writeFile(join(root,`${mode}.json`),JSON.stringify(record,null,2)+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(root,'comparison.json'),JSON.stringify({sourceCommit,selectedModel:options.model,syntheticCoordination:true,realModels:!syntheticNative,sourceMeasurements,report},null,2)+'\n',{mode:0o600,flag:'wx'});
  return {root,report};
 }catch(error){await writeFile(join(root,'failure.json'),JSON.stringify(error.failure??{code:'comparison_rejected',message:error.message},null,2)+'\n',{mode:0o600});throw Object.assign(new Error('Context comparison failed; preserve the experiment directory for private inspection.'),{root,cause:error});}
 finally{
  try{if(adapter&&cleanupConfirmed)await adapter.release({cleanupConfirmed:true});}
  finally{try{await cleanDirect();}catch(error){throw Object.assign(new Error('Experiment cleanup was not confirmed.'),{root,cause:error});}finally{await service?.close();}}
 }
}
