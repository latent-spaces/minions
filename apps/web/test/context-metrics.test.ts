import test from 'node:test';
import assert from 'node:assert/strict';
import type {ContextSummary,ContextTurnPage,NativeContextObservation} from '@mlswarm/contracts';
import {requestPressure,pressureStats,suppliedSources} from '../src/ui/context-metrics.js';
const native=(input:number|null,window:number|null):NativeContextObservation=>({source:'codex-app-server',coverage:'partial-turn-stream',lastInputTokens:input,lastTotalTokens:null,modelContextWindow:window,observations:1,completedCompactions:0});
test('request pressure uses only reported input and a positive reported window, including genuine zero input',()=>{
 assert.equal(requestPressure(native(58864,475000)),58864/475000*100);
 assert.equal(requestPressure(native(0,475000)),0);
 for(const value of [null,undefined,native(null,475000),native(12,null),native(12,0),native(-1,100),native(Infinity,100)])assert.equal(requestPressure(value),null);
 assert.equal(requestPressure(native(120,100)),120,'an over-window report is not silently capped');
});
test('summary statistics normalize each observation by its own model window and omit unknowns',()=>{
 const turns=[native(50,100),native(50,200),null].map(nativeContext=>({nativeContext})) as ContextTurnPage['turns'];
 assert.deepEqual(pressureStats(turns),{count:2,median:37.5,peak:50});
 assert.deepEqual(pressureStats([]),{count:0,median:null,peak:null});
});
test('measured source groups do not count steering or tool responses twice or invent token attribution',()=>{
 const context={instructionBytes:20,turnPromptBytes:100,promptSources:{steering:10},catalogBytes:30,tools:[],byTool:[
 {name:'get_task',argumentBytes:1,responseTextBytes:100},{name:'read_thread',argumentBytes:2,responseTextBytes:200},{name:'get_mlswarm_guide',argumentBytes:3,responseTextBytes:400},
 ]} as unknown as ContextSummary;
 const sources=suppliedSources(context);
 assert.equal(sources.reduce((sum,s)=>sum+s.bytes,0),856);
 assert.equal(sources.find(s=>s.key==='prompt')?.bytes,90);
 assert.equal(sources.find(s=>s.key==='tasks')?.bytes,100);
 assert.equal(sources.find(s=>s.key==='conversations')?.bytes,200);
 assert.equal(sources.find(s=>s.key==='other')?.bytes,400);
 assert.ok(sources.every(s=>!('tokens' in s)&&!('percent' in s)));
 assert.deepEqual(sources.map(s=>s.key),['instructions','prompt','steering','definitions','tasks','conversations','other','arguments'],'fixed order, so colors and stacks stay put');
});
test('older reports retain an unsplit result rather than making up category zeroes',()=>{
 const sources=suppliedSources({instructionBytes:1,turnPromptBytes:2,catalogBytes:3,tools:[{responseTextBytes:99}]} as ContextSummary);
 assert.equal(sources.find(s=>s.key==='unsplit')?.bytes,99);
 assert.equal(sources.some(s=>s.key==='tasks'),false);
 assert.deepEqual(suppliedSources(null),[]);
});
