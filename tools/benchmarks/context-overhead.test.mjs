import test from 'node:test';
import assert from 'node:assert/strict';
import {compareContextOverhead} from './context-overhead.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const run=(mode,input)=>({mode,provider:'codex',model:'synthetic-pinned-model',effort:'low',clientVersion:'synthetic-v1',scenarioDigest:'same-task',fixtureDigest:'same-state',sharedConfigDigest:'same-native-config',sessionPhase:'new',turns:[{resultDigest:'a'.repeat(64),input,output:4,cacheRead:2,cacheWrite:0,inputSemantics:'includes-cache'}]});
test('comparison returns measured paired token differences without attributing sources',()=>{
 const result=compareContextOverhead(run('direct',10),run('mlswarm',17));
 assert.equal(result.pairs[0].inputOverhead,7);assert.equal('percentage' in result,false);
 assert.equal(JSON.stringify(result).includes('costUsd'),false);
});
test('failed or different work cannot establish token overhead',()=>{
 for(const resultDigest of [undefined,'unverified','b'.repeat(64)]){
  const candidate=run('mlswarm',17);candidate.turns[0].resultDigest=resultDigest;
  assert.throws(()=>compareContextOverhead(run('direct',10),candidate),/Unmatched verified result/);
 }
});
test('different task/model/effort/configuration cannot establish an overhead comparison',()=>{
 for(const key of ['provider','model','effort','clientVersion','scenarioDigest','fixtureDigest','sharedConfigDigest','sessionPhase']){
  assert.throws(()=>compareContextOverhead(run('direct',10),{...run('mlswarm',17),[key]:'different'}),/Unmatched/);
 }
});
test('missing counters remain unknown and observed decreases remain signed',()=>{
 assert.equal(compareContextOverhead(run('direct',10),run('mlswarm',null)).pairs[0].inputOverhead,null);
 assert.equal(compareContextOverhead(run('direct',10),run('mlswarm',7)).pairs[0].inputOverhead,-3);
 const a=run('direct',10),b=run('mlswarm',17);a.turns[0].inputSemantics='uncached';b.turns[0].inputSemantics='uncached';a.turns[0].cacheWrite=null;
 assert.equal(compareContextOverhead(a,b).pairs[0].inputOverhead,null);
});
test('offline CLI writes numeric comparison once, refuses oversized/private malformed captures and never overwrites',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'mlswarm comparison '));
 try{
  const direct=join(folder,'direct.json'),candidate=join(folder,'mlswarm.json'),out=join(folder,'report.json');
  await writeFile(direct,JSON.stringify(run('direct',10)));await writeFile(candidate,JSON.stringify(run('mlswarm',17)));
  const call=()=>spawnSync(process.execPath,[fileURLToPath(new URL('./context-overhead-cli.mjs',import.meta.url)),'--direct',direct,'--mlswarm',candidate,'--out',out],{encoding:'utf8',windowsHide:true});
  assert.equal(call().status,0);const saved=await readFile(out,'utf8');assert.equal(JSON.parse(saved).pairs[0].inputOverhead,7);
  assert.equal(call().status,1);assert.equal(await readFile(out,'utf8'),saved);
  await writeFile(direct,'PRIVATE_SENTINEL');let failed=call();assert.equal(failed.status,1);assert.equal(failed.stderr.includes('PRIVATE_SENTINEL'),false);
  await writeFile(direct,' '.repeat(1_048_577));failed=call();assert.equal(failed.status,1);assert.equal(await readFile(out,'utf8'),saved);
 }finally{await rm(folder,{recursive:true,force:true});}
});
