// Experiment-only direct arm. Uses the production protocol collector and native
// supervisor; removes only Minions's instructions and generated project MCP.
import {prepareSupervisedModel} from '../src/model-guard.mjs';
import {modelTurnOutcome} from '../src/native-worker-adapter.mjs';
import {MISSION_MARK} from '../src/leftover-processes.mjs';

export function directInvocation(invocation,session){
 const args=[];
 for(let i=0;i<invocation.args.length;i++){
  if(invocation.args[i]==='-c'){
   const entry=invocation.args[++i];
   if(entry.startsWith(`mcp_servers.${session.mcpName}.`))continue;
   args.push('-c',entry.startsWith('developer_instructions=')?'developer_instructions=""':entry);
  }else args.push(invocation.args[i]);
 }
 return {...invocation,args,env:{}};
}

// Codex registers new workspace trust metadata when a thread is first opened.
// Open each disposable workspace before freezing configuration. This sends no
// turn/start or user input and therefore performs no model inference.
export async function primeWorkspace({provider,folder,instructionsFile,deadline,signal,clientVersion,mark}){
 const session=provider.newSession('experiment-preflight',folder);
 const invocation=directInvocation(await provider.invocation({prompt:'',instructionsFile,permissionGuidance:'',bridge:{url:'http://127.0.0.1:1/unused',headers:{Authorization:'Bearer unused'}},session,resuming:false,repoDir:folder,clientVersion,signal}),session);
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=prepareSupervisedModel({cwd:folder,env:provider.environment({[MISSION_MARK]:mark}),stdio:['pipe','pipe','pipe'],deadline});
  let pending='',confirmed=false,cleaned=false;
  const stop=()=>child.kill('SIGKILL'),timer=setTimeout(stop,10000);
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  child.stdin.on('error',()=>{});child.stderr.resume();
  child.on('message',value=>{if(value?.cleanupConfirmed===true)cleaned=true;});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
   pending+=chunk;if(Buffer.byteLength(pending)>1024*1024)return stop();
   let index;while((index=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,index);pending=pending.slice(index+1);let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.id===1){if(value.error)return stop();send({method:'initialized',params:{}});send({id:2,method:'thread/start',params:invocation.rpc.startParams});}
    if(value.id===2){confirmed=!value.error&&value.result?.modelProvider==='openai'&&value.result?.reasoningEffort===invocation.rpc.effort;child.stdin.end();}
   }
  });
  child.once('error',stop);signal.addEventListener('abort',stop,{once:true});
  child.once('spawn',()=>{if(signal.aborted)return stop();child.authorize(invocation.command,invocation.args);send({id:1,method:'initialize',params:{clientInfo:invocation.rpc.clientInfo}});});
  child.once('close',()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);if(confirmed&&cleaned&&!signal.aborted)resolve();else reject(new Error('Native workspace preflight did not complete.'));});
 });
}

export async function directTurn({provider,folder,instructionsFile,session,prompt,deadline,signal,clientVersion,mark}){
 signal.throwIfAborted();
 if(!/^[a-f0-9]{32}$/.test(mark??''))throw new Error('A unique experiment process marker is required.');
 const invocation=directInvocation(await provider.invocation({prompt,instructionsFile,permissionGuidance:'',
  bridge:{url:'http://127.0.0.1:1/unused',headers:{Authorization:'Bearer unused-experiment-placeholder'}},
  session,resuming:provider.canResume(session),repoDir:folder,clientVersion,signal}),session);
 return new Promise((resolve,reject)=>{
  const child=prepareSupervisedModel({cwd:folder,env:provider.environment({[MISSION_MARK]:mark}),stdio:['pipe','pipe','pipe'],deadline});
  let cleanupConfirmed=false,fault=false,forceTimer,attached=false;
  const fail=()=>{fault=true;child.kill('SIGTERM');forceTimer??=setTimeout(()=>child.kill('SIGKILL'),5000);};
  const stream=provider.collector({rpc:invocation.rpc,session:id=>{session.id=id;},persistence:fail});
  const stop=()=>{if(attached)stream.interrupt();else child.kill('SIGTERM');forceTimer??=setTimeout(()=>child.kill('SIGKILL'),5000);};
  child.stdin.on('error',()=>{});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{try{stream.feed(chunk);}catch{fail();}});
  child.stderr.resume(); // Raw native output never enters the public numeric report.
  child.on('message',value=>{if(value?.cleanupConfirmed===true)cleanupConfirmed=true;});
  child.once('error',fail);
  child.once('close',async(code,closedSignal)=>{
   clearTimeout(forceTimer);signal.removeEventListener('abort',stop);
   let outcome;
   try{
    stream.end();await stream.drainPersistence();stream.cleanup();
    if(stream.tokenTotals)session.tokenTotals=stream.tokenTotals;
    outcome=modelTurnOutcome({stream,exitCode:code,signal:closedSignal,persistenceFault:fault,interrupted:signal.aborted});
    if(!cleanupConfirmed||outcome.failed||outcome.interrupted)throw new Error('Direct turn did not complete with confirmed native cleanup.');
    resolve({usage:provider.usage(stream.report,stream.init),cleanupConfirmed});
   }catch{stream.cleanup();reject(Object.assign(new Error('Direct turn failed; preserve the private experiment directory.'),{failure:{code:outcome?.failureCode??'direct_completion_failed',cleanupConfirmed,diagnostics:outcome?.diagnostics??null}}));}
  });
  signal.addEventListener('abort',stop,{once:true});
  child.once('spawn',()=>{try{if(signal.aborted)return child.kill('SIGTERM');child.authorize(invocation.command,invocation.args);stream.attach(child);attached=true;}catch{fail();}});
 });
}
