// Fake protocol client used only by tests. No inference or external network.
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const args=process.argv.slice(2),emit=value=>console.log(JSON.stringify(value));
const fault=new URL(import.meta.url).searchParams.get('fault');
if(args.includes('--version')){console.log('codex-cli 0.160.0');process.exit(0);}
if(args.includes('login'))process.exit(0);
if(args.includes('mcp')&&args.includes('list')){console.log('[]');process.exit(0);}
const config=Object.fromEntries(args.flatMap((arg,i)=>arg==='-c'?[args[i+1].split(/=(.*)/s).slice(0,2)]:[]));
const effort=JSON.parse(config.model_reasoning_effort),mcp=Object.keys(config).find(k=>/^mcp_servers\.project_.*\.url$/.test(k));
const threadFile=join(process.cwd(),'.synthetic-thread'),countFile=join(process.cwd(),'.synthetic-count');
const count=existsSync(countFile)?Number(readFileSync(countFile,'utf8'))+1:1;
let threadId=existsSync(threadFile)?readFileSync(threadFile,'utf8'):randomUUID();
const lines=createInterface({input:process.stdin});let model;
lines.on('line',line=>{void(async()=>{
 const request=JSON.parse(line);
 if(request.method==='initialize')emit({id:request.id,result:{}});
 if(['thread/start','thread/resume'].includes(request.method)){
  if((count===1)!==(request.method==='thread/start')||count>1&&request.params.threadId!==threadId)throw new Error('Wrong session phase.');
  if(request.method==='thread/start'){threadId=randomUUID();writeFileSync(threadFile,threadId);}
  const configPath=join(process.env.CODEX_HOME,'config.toml'),existing=existsSync(configPath)?readFileSync(configPath,'utf8'):'';
  if(!existing.includes(JSON.stringify(process.cwd())))appendFileSync(configPath,`\n[projects.${JSON.stringify(process.cwd())}]\ntrust_level="trusted"\n`);
  model=request.params.model;emit({id:request.id,result:{thread:{id:threadId},modelProvider:'openai',model,reasoningEffort:effort}});
 }
 if(request.method==='turn/start'){
  writeFileSync(countFile,String(count));
  if(request.params.effort!==effort)throw new Error('Unpinned effort.');
  appendFileSync(join(process.cwd(),'.synthetic-observations'),JSON.stringify({count,effort,mcp:Boolean(mcp)})+'\n');
  const turnId=randomUUID();emit({id:request.id,result:{turn:{id:turnId}}});
  emit({method:'turn/started',params:{threadId,turn:{id:turnId}}});
  if(mcp){
   const client=new Client({name:'synthetic-context-native',version:'test'});
   await client.connect(new StreamableHTTPClientTransport(new URL(JSON.parse(config[mcp])),{requestInit:{headers:{Authorization:`Bearer ${process.env.PILOT_BRIDGE_TOKEN}`}}}));
   await client.listTools();
   for(const [name,input]of [['get_project',{}],['get_task',{task_id:'sum-task'}],['read_thread',{thread_id:'adjustment-thread'}]]){
    const reply=await client.callTool({name,arguments:input});if(reply.isError)throw new Error('Scoped fixture read refused.');
   }
   await client.close();
  }
  const data=JSON.parse(readFileSync(join(process.cwd(),'data.json'),'utf8'));
  writeFileSync(join(process.cwd(),count===1?'INITIAL.json':'STEERING.json'),JSON.stringify({sum:fault==='wrong-result'?999:data.values.reduce((n,v)=>n+v,0)+(count===1?5:-2)}));
  if(fault==='changed-config')writeFileSync(join(process.env.CODEX_HOME,'config.toml'),'# synthetic change');
  const input=mcp?170:100;
  emit({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:{inputTokens:count*input,outputTokens:count*3,cachedInputTokens:0,cacheWriteInputTokens:0}}}});
  emit({method:'item/completed',params:{threadId,turnId,item:{id:'answer',type:'agentMessage',text:'Complete. WORK_NEXT: waiting'}}});
  emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
 }
 })().catch(()=>process.exit(1));});
lines.on('close',()=>process.exit(0));
