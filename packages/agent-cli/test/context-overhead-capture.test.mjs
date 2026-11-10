import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeMixedNativeFixtures} from './fixtures/mixed-native-fixtures.mjs';
import {captureContextOverhead,contextCaptureOptions} from '../scripts/context-overhead-capture.mjs';
import {directInvocation} from '../scripts/context-overhead-direct.mjs';
test('capture requires explicit pinned model, effort, bounded duration and native platform',async()=>{
 assert.throws(()=>contextCaptureOptions([]),/Select/);
 for(const options of [{},{approved:true,model:'synthetic',effort:'low',platform:process.platform,timeoutSeconds:0}])await assert.rejects(captureContextOverhead(options));
 const parsed=contextCaptureOptions(['--approved','--model','synthetic','--effort','low','--expect-platform',process.platform,'--timeout-seconds','60']);assert.equal(parsed.timeoutSeconds,60);
});
test('direct arm removes only generated project instructions/MCP while preserving native protections',()=>{
 const invocation={args:['app-server','--stdio','-c','mcp_servers.personal.enabled=false','-c','mcp_servers.project_abc.url="http://127.0.0.1"','-c','developer_instructions="MyLittleSwarm"','-c','sandbox_mode="workspace-write"','-c','model_reasoning_effort="low"'],env:{PILOT_BRIDGE_TOKEN:'private'}};
 const result=directInvocation(invocation,{mcpName:'project_abc'});
 assert.ok(result.args.includes('mcp_servers.personal.enabled=false'));assert.ok(result.args.includes('sandbox_mode="workspace-write"'));assert.ok(result.args.includes('model_reasoning_effort="low"'));assert.ok(result.args.includes('developer_instructions=""'));assert.equal(result.args.some(a=>a.includes('project_abc')),false);assert.deepEqual(result.env,{});
});
test('paired fake native sessions use real scoped facade, verify both results, retain steering and record no live inference',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'mlswarm-pair-fixture '));let result;
 try{
  const fixtures=await makeMixedNativeFixtures(root,[['pair','codex']]);
  const executable=fixtures.executables.codex,source=process.platform==='win32'?executable.replace(/\.cmd$/,'.cjs'):executable;
  await writeFile(source,`${process.platform==='win32'?'':`#!${process.execPath}\n`}void import(${JSON.stringify(new URL('./fixtures/context-overhead-native.mjs',import.meta.url).href)});\n`,{mode:0o700});
  result=await captureContextOverhead({approved:true,model:'synthetic-pinned',effort:'low',platform:process.platform,timeoutSeconds:60},{executables:fixtures.executables,envSource:fixtures.envSource,syntheticNative:true});
  assert.deepEqual(result.report.pairs.map(p=>p.inputOverhead),[70,70]);
  const saved=JSON.parse(await readFile(join(result.root,'comparison.json'),'utf8'));assert.equal(saved.realModels,false);
  assert.ok(saved.sourceMeasurements[0].byTool.some(t=>t.name==='read_thread'&&t.responseTextBytes>0));assert.ok(saved.sourceMeasurements[0].catalogBytes>0);assert.equal(saved.sourceMeasurements[1].steeringMessages,1);
  assert.ok(saved.sourceMeasurements[0].byTool.some(t=>t.name==='read_teams'&&t.catalogDeliveries===1));assert.equal(saved.sourceMeasurements[0].byTool.some(t=>t.name==='manage_team'),false);
  for(const mode of ['direct','mlswarm']){const observations=(await readFile(join(result.root,mode,'checkout','.synthetic-observations'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(observations.length,2);assert.ok(observations.every(o=>o.effort==='low'&&o.mcp===(mode==='mlswarm')));}
 }catch(error){throw error.cause??error;}
 finally{if(result)await rm(result.root,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
for(const fault of ['wrong-result','changed-config'])test(`paired capture refuses ${fault} before starting the other arm`,{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'mlswarm-pair-refusal '));let preserved;
 try{
  const fixtures=await makeMixedNativeFixtures(root,[['pair','codex']]);
  const executable=fixtures.executables.codex,source=process.platform==='win32'?executable.replace(/\.cmd$/,'.cjs'):executable;
  const module=new URL('./fixtures/context-overhead-native.mjs',import.meta.url);module.searchParams.set('fault',fault);
  await writeFile(source,`${process.platform==='win32'?'':`#!${process.execPath}\n`}void import(${JSON.stringify(module.href)});\n`,{mode:0o700});
  await assert.rejects(captureContextOverhead({approved:true,model:'synthetic-pinned',effort:'low',platform:process.platform,timeoutSeconds:60},{executables:fixtures.executables,envSource:fixtures.envSource,syntheticNative:true}),error=>{
   assert.match(error.cause.message,fault==='wrong-result'?/task result did not match/:/configuration changed/);preserved=error.root;return true;
  });
  await assert.rejects(readFile(join(preserved,'comparison.json')),error=>error.code==='ENOENT');
  await assert.rejects(readFile(join(preserved,'mlswarm','checkout','.synthetic-observations')),error=>error.code==='ENOENT');
  const rows=(await readFile(join(preserved,'direct','checkout','.synthetic-observations'),'utf8')).trim().split('\n');assert.equal(rows.length,1);
 }finally{if(preserved)await rm(preserved,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
