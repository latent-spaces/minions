import {fitContextTelemetry} from '../src/context-measurement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutcome } from '../src/service/contracts.mjs';
import { normalizeCloudTurn } from '../src/service/cloud-reports.mjs';

const context = () => ({scope:'minions-supplied',coverage:'partial',instructionBytes:13,turnPromptBytes:21,catalogRequests:1,catalogBytes:34,
  tools:[{category:'coordination',calls:1,argumentBytes:2,responseTextBytes:55,refusals:0}]});
const outcome = c => ({delivery:'acknowledged',failed:false,interrupted:false,retryable:false,cleanupConfirmed:true,
  usage:{provider:'codex',...(c ? {context:c} : {})}});
const report = value => normalizeCloudTurn({outcome:value,execution:{provider:'codex'},startedAt:100,endedAt:200,sequence:1});

test('numeric partial context survives strict outcome validation and cloud normalization without aliasing', () => {
  const value = validateOutcome(outcome(context()));
  const normalized = report(value);
  assert.deepEqual(normalized.usage.context, value.usage.context);
  value.usage.context.tools[0].calls = 8;
  assert.equal(normalized.usage.context.tools[0].calls, 1);
  assert.equal('context' in report(outcome()).usage, false, 'missing observations remain unknown');
});

test('context rejects arbitrary metadata, duplicate categories and invalid counters', () => {
  for (const change of [c => {c.secret='private';}, c => {c.tools.push({...c.tools[0]});},
    c => {c.instructionBytes=-1;}, c => {c.catalogRequests=0.5;}, c => {c.tools[0].refusals=2;},
    c => {c.tools[0].category='private-tool-name';}]) {
    const c=context();change(c);
    assert.throws(() => validateOutcome(outcome(c)));
    assert.equal('context' in report(outcome(c)).usage, false);
  }
});

test('native observations survive normalization separately from supplied context without unknown-field leakage',()=>{
 const nativeContext={source:'codex-app-server',coverage:'partial-turn-stream',lastInputTokens:80,lastTotalTokens:90,modelContextWindow:200,observations:1,completedCompactions:1};
 const value=outcome();value.usage.nativeContext=nativeContext;
 validateOutcome(value);assert.deepEqual(report(value).usage.nativeContext,nativeContext);
 nativeContext.privateText='secret';assert.throws(()=>validateOutcome(value));assert.equal('nativeContext' in report(value).usage,false);
});


test('oversized optional telemetry is omitted without mutating or invalidating the base outcome',()=>{
 const base=outcome();const limit=Buffer.byteLength(JSON.stringify(base));
 const withMeasurements={...base,usage:{...base.usage,context:context(),nativeContext:{source:'codex-app-server',coverage:'partial-turn-stream',lastInputTokens:1,lastTotalTokens:2,modelContextWindow:100,observations:1,completedCompactions:0}}};
 assert.deepEqual(fitContextTelemetry(withMeasurements,limit),base);
 assert.ok(withMeasurements.usage.context);assert.ok(withMeasurements.usage.nativeContext);
 assert.equal(fitContextTelemetry(base,limit),base);
});
