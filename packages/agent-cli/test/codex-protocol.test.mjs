import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../runtime/providers.mjs';
import { modelTurnOutcome } from '../src/native-worker-adapter.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
test('trusted pinned effort is confirmed before submission and sent on the native turn',()=>{
 for(const actual of ['low','high',null]){
  const writes=[],stream=createProvider('codex',{}).collector({rpc:{effort:'low',prompt:'Synthetic',startParams:{cwd:'/synthetic'},clientInfo:{name:'test',version:'1'}}});
  stream.attach({stdin:{destroyed:false,write:line=>writes.push(JSON.parse(line)),end(){}},kill(){}});
  stream.feed(JSON.stringify({id:1,result:{}})+'\n');
  stream.feed(JSON.stringify({id:2,result:{thread:{id:threadId},modelProvider:'openai',model:'synthetic',reasoningEffort:actual}})+'\n');
  const submitted=writes.find(w=>w.method==='turn/start');
  if(actual==='low')assert.equal(submitted.params.effort,'low');
  else{assert.equal(submitted,undefined);assert.equal(stream.failure.code,'native_protocol_error');}
  stream.cleanup();
 }
 for(const settings of [{effort:''},{effort:'low\nsecret'},{effort:2}])assert.throws(()=>createProvider('codex',settings),/pinned effort/);
 assert.throws(()=>createProvider('claude',{effort:'low'}),/pinned effort/);
});
test('native project trust metadata is checked before both new and resumed model turns', () => {
  for (const resuming of [false, true]) for (const disabledReason of [null, 'Project is untrusted']) {
    const writes = [], stream = createProvider('codex', {}).collector({rpc:{resuming,nativeRuleLayer:'/repo/.codex',startParams:{cwd:'/repo'},clientInfo:{name:'test',version:'1'}}});
    stream.attach({stdin:{destroyed:false,write:value=>writes.push(JSON.parse(value)),end(){}},kill(){}});
    stream.feed(JSON.stringify({id:1,result:{}})+'\n');
    assert.equal(writes.at(-1).method,'config/read');
    stream.feed(JSON.stringify({id:4,result:{layers:[{name:{type:'project',dotCodexFolder:'/repo/.codex'},disabledReason,config:{},version:'1'}]}})+'\n');
    if(disabledReason) { assert.equal(stream.failure.code,'merge_policy_unavailable');assert.equal(writes.some(value=>value.method==='thread/start'||value.method==='thread/resume'),false); }
    else assert.equal(writes.at(-1).method,resuming?'thread/resume':'thread/start');
    stream.cleanup();
  }
});
test('native config payloads remain local and malformed or untrusted layers never submit a prompt',()=>{
  for(const layers of [null,{},[null],[{name:{type:'project',dotCodexFolder:'/repo/.codex'},disabledReason:'secret-config-value',config:{env:{TOKEN:'secret-config-value'}}}]]){
    const writes=[],observations=[],stream=createProvider('codex',{}).collector({rpc:{nativeRuleLayer:'/repo/.codex',startParams:{cwd:'/repo'},clientInfo:{name:'test',version:'1'}},metadata:value=>observations.push(value),assistantText:value=>observations.push(value),log:value=>observations.push(value),submitted:()=>observations.push('submitted')});
    stream.attach({stdin:{destroyed:false,write:value=>writes.push(JSON.parse(value)),end(){}},kill(){}});
    stream.feed(JSON.stringify({id:1,result:{}})+'\n');stream.feed(JSON.stringify({id:4,result:{layers,config:{env:{TOKEN:'secret-config-value'}}}})+'\n');
    assert.equal(stream.failure.code,'merge_policy_unavailable');assert.equal(writes.some(value=>value.method==='turn/start'),false);
    const outcome=modelTurnOutcome({stream,exitCode:1});assert.equal(outcome.retryable,false);
    assert.doesNotMatch(JSON.stringify({observations,outcome,report:stream.report}),/secret-config-value/);stream.cleanup();
  }
});
function connection(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const writes = [];
  const stream = createProvider('codex', {}).collector({ rpc: { resuming: true,
    clientInfo: { name: 'offline-test', version: 'test' }, startParams: { threadId, excludeTurns: true }, prompt: 'Synthetic mission' } });
  stream.attach({ stdin: { destroyed: false, write: text => writes.push(JSON.parse(text)), end() {} }, kill() {} });
  const feed = value => stream.feed(JSON.stringify(value) + '\n');
  t.after(() => stream.cleanup());
  const initialize = () => feed({ id: 1, result: {} });
  return { stream, feed, initialize };
}

test('resume requests metadata only, retaining the approved identity and guarded permissions (no model)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlswarm-protocol-'));
  try {
    const executable = join(root, 'fake-codex'), instructionsFile = join(root, 'instructions.md');
    writeFileSync(executable, `#!${process.execPath}\nconsole.log('[]');\n`, { mode: 0o700 });
    writeFileSync(instructionsFile, 'Synthetic instructions');
    const provider = createProvider('codex', { codex: executable, passEnv: '', permissionMode: 'acceptEdits' });
    const invocation = await provider.invocation({ prompt: 'Synthetic mission', instructionsFile, bridge: {
      url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'Bearer synthetic-test-only' } },
      session: { id: threadId, mcpName: `project_${'a'.repeat(32)}` }, resuming: true, repoDir: root, clientVersion: 'test' });
    assert.deepEqual(invocation.rpc.startParams, { cwd: root, modelProvider: 'openai', sandbox: 'workspace-write',
      approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', threadId, excludeTurns: true });
    assert.ok(invocation.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(invocation.args.includes('approval_policy="on-request"'));
    assert.ok(invocation.args.includes('approvals_reviewer="auto_review"'));
    assert.equal(invocation.args.some(value => value.startsWith('sandbox_workspace_write.writable_roots=')), false);
    const guidance = JSON.parse(invocation.args.find(value => value.startsWith('developer_instructions=')).slice('developer_instructions='.length));
    assert.match(guidance, /exact necessary command using require_escalated/);
    assert.match(guidance, /report that no commit was created/);
    assert.equal(invocation.args.some(value => value.includes('synthetic-test-only')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native RPC errors retain the stage and code without exposing error text or stderr', t => {
  const { stream, initialize, feed } = connection(t); initialize();
  feed({ id: 2, error: { code: -32001, message: 'Private text Bearer super-secret /private/user/history' } });
  const result = modelTurnOutcome({ stream, stderr: 'Cookie: private-cookie', exitCode: 1,
    nativeExit: { exitCode: null, signal: 'SIGKILL' } });
  assert.equal(result.failureCode, 'native_rpc_error'); assert.equal(result.diagnostics.rpc_code, -32001);
  assert.equal(result.diagnostics.phase, 'thread_resume'); assert.equal(result.diagnostics.signal, 'SIGKILL');
  assert.equal(result.diagnostics.exit_code, null); assert.equal(result.diagnostics.guard_exit_code, 1);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|private-cookie|private\/user/);
});
test('existing project native config is never newly trusted and all discovered personal/project MCPs stay disabled',async()=>{
  const root=mkdtempSync(join(tmpdir(),'mlswarm-existing-native-'));
  try{
    mkdirSync(join(root,'.codex'));writeFileSync(join(root,'.codex','config.toml'),'# Existing native configuration\n');
    const executable=join(root,'fake-codex'),instructionsFile=join(root,'instructions.md');
    writeFileSync(executable,`#!${process.execPath}\nconsole.log(JSON.stringify([{name:'personal_tools'},{name:'project_tools'}]));\n`,{mode:0o700});writeFileSync(instructionsFile,'Synthetic only');
    const provider=createProvider('codex',{codex:executable,passEnv:'',permissionMode:'acceptEdits'});
    const value=await provider.invocation({prompt:'Synthetic',instructionsFile,bridge:{url:'http://127.0.0.1:12345/mcp',headers:{Authorization:'Bearer synthetic'}},session:{id:threadId,mcpName:`project_${'b'.repeat(32)}`},resuming:true,repoDir:root,clientVersion:'test',requireMergePolicy:true});
    assert.equal(value.args.some(arg=>arg.startsWith('projects=')),false);
    for(const name of ['personal_tools','project_tools'])assert.ok(value.args.includes(`mcp_servers.${name}.enabled=false`));
    for(const feature of ['hooks','apps','plugins','multi_agent'])assert.ok(value.args.includes(`features.${feature}=false`));
    assert.equal(readFileSync(join(root,'.codex','config.toml'),'utf8'),'# Existing native configuration\n');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('native observations preserve last usage and compaction scalars only for the exact active turn',t=>{
 const {stream,feed}=connection(t);
 stream.threadId=threadId;stream.turnId='active-turn';
 const update=(thread,turn,input,window)=>feed({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:turn,tokenUsage:{total:{inputTokens:999999},last:{inputTokens:input,totalTokens:input+10},modelContextWindow:window}}});
 update('foreign','active-turn',1,100);update(threadId,'older-turn',2,100);
 assert.equal(stream.nativeContext,null);
 update(threadId,'active-turn',80,200);
 assert.deepEqual(stream.nativeContext,{source:'codex-app-server',coverage:'partial-turn-stream',lastInputTokens:80,lastTotalTokens:90,modelContextWindow:200,observations:1,completedCompactions:0});
 const compact=(turn,id)=>feed({method:'item/completed',params:{threadId,turnId:turn,item:{id,type:'contextCompaction',privateText:'NEVER_STORE'}}});
 compact('older-turn','wrong');compact('active-turn','once');compact('active-turn','once');
 assert.equal(stream.nativeContext.completedCompactions,1);
 update(threadId,'active-turn',30,null);
 assert.equal(stream.nativeContext.lastInputTokens,30);assert.equal(stream.nativeContext.modelContextWindow,null);
 assert.equal(stream.nativeContext.completedCompactions,1);
 assert.doesNotMatch(JSON.stringify(stream.nativeContext),/NEVER_STORE|active-turn|999999/);
});
