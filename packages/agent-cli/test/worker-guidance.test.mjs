import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerGuidance, readWorkerGuidance, snapshotWorkerInstructions } from '../src/worker-guidance.mjs';
import { readPrivate, writePrivate } from '../src/state.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'mlswarm mission guides '));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),mission=join(root,'mission');
  for(const path of [source,mission])mkdirSync(path,{mode:0o700});
  const install=(core,revision=1)=>{
    const guides=createWorkerGuidance({core,guideRevision:revision,sections:{'project-work':`Work rules ${revision}`,'updates-and-help':`Reporting rules ${revision}`}});
    writePrivate(join(source,'worker-guides.json'),guides);writePrivate(join(source,'instructions.md'),core);
    return guides;
  };
  return {source,mission,install};
}

test('fresh missions freeze one core/reference pair and resumed missions retain it after source updates', t => {
  const f=fixture(t),first=f.install('Original core');
  snapshotWorkerInstructions(f.source,f.mission);
  assert.equal(readPrivate(join(f.mission,'instructions.md')),'Original core');
  assert.deepEqual(readWorkerGuidance(f.mission),first);
  f.install('New release core',2);
  snapshotWorkerInstructions(f.source,f.mission);
  assert.equal(readPrivate(join(f.mission,'instructions.md')),'Original core');
  assert.deepEqual(readWorkerGuidance(f.mission),first);
});

test('interrupted preparation can retry before the core commit; mismatched source/core pairs fail intact', t => {
  const f=fixture(t);f.install('Original core');
  writePrivate(join(f.mission,'worker-guides.json'),{unfinished:true});
  snapshotWorkerInstructions(f.source,f.mission);
  assert.equal(readWorkerGuidance(f.mission).guide_revision,1);
  writePrivate(join(f.mission,'worker-guides.json'),{broken:true});
  assert.throws(()=>readWorkerGuidance(f.mission));
  // A committed mission is preserved even when repair would be convenient.
  snapshotWorkerInstructions(f.source,f.mission);
  assert.deepEqual(readPrivate(join(f.mission,'worker-guides.json'),true),{broken:true});
  rmSync(join(f.mission,'instructions.md'));rmSync(join(f.mission,'worker-guides.json'));
  writePrivate(join(f.source,'instructions.md'),'Unexpected source core');
  assert.throws(()=>snapshotWorkerInstructions(f.source,f.mission),/do not match/);
  assert.equal(readWorkerGuidance(f.source,'Original core').guide_revision,1);
});

test('pre-router active mission instructions stay untouched and receive no replacement guide', t => {
  const f=fixture(t);f.install('New core');
  writePrivate(join(f.mission,'instructions.md'),'Earlier self-contained mission instructions');
  snapshotWorkerInstructions(f.source,f.mission);
  assert.equal(readPrivate(join(f.mission,'instructions.md')),'Earlier self-contained mission instructions');
  assert.equal(readWorkerGuidance(f.mission),null);
});

test('workflow integrity covers both references and refuses extra management sections', t => {
  const f=fixture(t);f.install('Core');snapshotWorkerInstructions(f.source,f.mission);
  const file=join(f.mission,'worker-guides.json'),value=readPrivate(file,true);
  value.sections.computer='Owner setup';writePrivate(file,value);
  assert.throws(()=>readWorkerGuidance(f.mission));
  delete value.sections.computer;value.sections['updates-and-help']='Different reporting';writePrivate(file,value);
  assert.throws(()=>readWorkerGuidance(f.mission),/do not match/);
});
