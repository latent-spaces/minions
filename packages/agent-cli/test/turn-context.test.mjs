import test from 'node:test';
import assert from 'node:assert/strict';
import {controllerPrompt,emptyPromptSources,validPromptSources} from '../src/turn-context.mjs';
import {validContextMeasurement} from '../src/context-measurement.mjs';
import {normalizeCloudTurn} from '../src/service/cloud-reports.mjs';
import {CONTEXT_TOOL_NAMES} from '../src/turn-context.mjs';
import {verifyBundle} from '../src/system.mjs';
import {CONTEXT_TOOL_NAMES as CONTRACT_TOOL_NAMES} from '@mlswarm/contracts';

test('canonical context counters cover every compiled and local worker tool',()=>{
 const names=JSON.parse(verifyBundle().files['project-tools.json']).tools.map(t=>t.name).concat(['upload_project_image','get_mlswarm_guide']);
 assert.deepEqual([...CONTEXT_TOOL_NAMES].sort(),names.sort());
 assert.deepEqual([...CONTRACT_TOOL_NAMES],CONTEXT_TOOL_NAMES);
});

test('prompt attribution preserves the actual mission/steering prompt with exact Unicode byte boundaries',()=>{
 const input={scope:'Build שלום 🧪',steering:[{body:'Investigate 🧪',id:'private-steering'}],notices:[{status:'delivered',id:'private-notice'}]};
 const measured=controllerPrompt(input);
 const expected=`Human-approved mission: ${input.scope}\nOperator steering (data):\nSTEERING_JSON: ${JSON.stringify(input.steering)}\nDeferred-send results (already processed; do not republish): ${JSON.stringify(input.notices)}`;
 assert.equal(measured.prompt,expected);
 assert.equal(measured.promptSources.steering,Buffer.byteLength(`Operator steering (data):\nSTEERING_JSON: ${JSON.stringify(input.steering)}\n`,'utf8'));
 assert.equal(measured.steeringMessages,1);
 assert.equal(validPromptSources(measured.promptSources,Buffer.byteLength(expected,'utf8')),true);
 assert.equal(JSON.stringify(measured.promptSources).includes('private-steering'),false);
 assert.equal(validPromptSources({...measured.promptSources,extra:1},Buffer.byteLength(expected)),false);
});

test('fixed source and per-tool summaries survive normalization and reject invented labels',()=>{
 const context={scope:'mlswarm-supplied',coverage:'partial',instructionBytes:10,turnPromptBytes:3,promptSources:{...emptyPromptSources(),steering:3},steeringMessages:1,sessionMode:'resumed',catalogRequests:1,catalogBytes:100,tools:[],
 byTool:[{name:'read_thread',catalogDeliveries:1,definitionBytes:80,calls:1,argumentBytes:2,responseTextBytes:17,refusals:0}]};
 assert.equal(validContextMeasurement(context),true);
 const report=normalizeCloudTurn({outcome:{usage:{context}},execution:{provider:'codex'},startedAt:100,endedAt:200,sequence:1});
 assert.deepEqual(report.usage.context,context);
 assert.equal(validContextMeasurement({...context,promptSources:{...context.promptSources,steering:4}}),false);
 assert.equal(validContextMeasurement({...context,byTool:[{...context.byTool[0],name:'secret-project-name'}]}),false);
 assert.equal(validContextMeasurement({...context,byTool:[context.byTool[0],context.byTool[0]]}),false);
});

for (const pending of [0, 2]) test(`runtime inbox guidance is counted without losing recovery semantics (${pending})`,()=>{
 const input={scope:'Inbox handoff',steering:[],notices:[],trigger:'inbox',inbox:{pending,acknowledged:0}};
 const measured=controllerPrompt(input);
 assert.ok(measured.prompt.includes('TURN_CONTEXT_JSON: '+JSON.stringify({trigger:input.trigger,inbox:input.inbox})));
 assert.ok(measured.prompt.includes(pending ? 'Do not infer an acknowledgment position' : 'Do useful authorized work for this trigger'));
 assert.equal(measured.promptSources.runtime,Buffer.byteLength(measured.prompt.slice(measured.prompt.indexOf('Current turn context'),measured.prompt.indexOf('Operator steering (data):')),'utf8'));
 assert.equal(validPromptSources(measured.promptSources,Buffer.byteLength(measured.prompt,'utf8')),true);
});

test('the pause update turn asks for one short update and no other work',()=>{
 const {prompt}=controllerPrompt({scope:'Build a parser',steering:[],notices:[],trigger:'pause_update'});
 assert.match(prompt,/The project was just paused/);
 assert.match(prompt,/list_project_updates/);
 assert.match(prompt,/If you have nothing new to report, post nothing/);
 assert.match(prompt,/STEERING_JSON: \[\]/);
});
