import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharacterAmbient, RareEffectGate, ambientTiming, pupilOffset, subscribeCharacterPointer, characterPointer } from '../src/ui/character-ambient.js';

test('rare effects are independently delayed and globally spaced, and interruption cancels a one-shot', () => {
  const gate = new RareEffectGate();
  const timing = { rareDelay: 60_000, rareInterval: 180_000, gazeDelay: 5000, gazeInterval: 30_000, gazeDuration: 3000 };
  const a = new CharacterAmbient(0, timing), b = new CharacterAmbient(0, timing);
  assert.equal(a.sample(59_999, true, false, () => gate.claim(59_999)).kind, 'none');
  assert.equal(a.sample(60_000, true, false, () => gate.claim(60_000)).kind, 'rare');
  assert.equal(b.sample(60_000, true, false, () => gate.claim(60_000)).kind, 'none');
  assert.deepEqual(a.sample(60_640, true, false, () => false), {kind:'rare', frame:4, opacity:1});
  assert.equal(a.sample(60_800, false, false, () => false).kind, 'none');
  assert.equal(a.sample(60_900, true, false, () => true).kind, 'none');
  assert.notDeepEqual(ambientTiming('agent-a'), ambientTiming('agent-b'));
  assert.ok(ambientTiming('a').rareInterval >= 180_000);
});

test('pointer input publishes reactively, supports mouse fallback and cleans up shared subscribers', () => {
  const previous = {window:globalThis.window,document:globalThis.document,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
  const target = new EventTarget(), root = new EventTarget();
  const frames = new Map<number,FrameRequestCallback>(); let id=0,a=0,b=0;
  Object.assign(globalThis,{window:target,document:{documentElement:root},
    requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;},
    cancelAnimationFrame:(frame:number)=>frames.delete(frame)});
  const flush=()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));};
  const move=(type:string,x:number,y:number,pointerType?:string)=>target.dispatchEvent(Object.assign(new Event(type),{clientX:x,clientY:y,pointerType}));
  const stopA=subscribeCharacterPointer(()=>a++),stopB=subscribeCharacterPointer(()=>b++);
  try {
    move('pointermove',100,20,'mouse');move('mousemove',110,30);
    assert.deepEqual(characterPointer(),{x:110,y:30});assert.equal(frames.size,1);
    flush();assert.equal(a,1);assert.equal(b,1);
    move('pointermove',900,900,'touch');assert.deepEqual(characterPointer(),{x:110,y:30});
    stopA();move('pointerdown',25,35,'mouse');flush();assert.equal(a,1);assert.equal(b,2);
    root.dispatchEvent(new Event('pointerleave'));flush();assert.equal(characterPointer(),null);
    move('mousemove',40,50);stopB();assert.equal(characterPointer(),null);assert.equal(frames.size,0);
  } finally {stopA();stopB();Object.assign(globalThis,previous);}
});

test('gaze follows for a few seconds, settles at neutral and yields to unavailable states', () => {
  const motion = new CharacterAmbient(0, {rareDelay:100_000,rareInterval:180_000,gazeDelay:5000,gazeInterval:30_000,gazeDuration:3200});
  assert.equal(motion.sample(0,true,true,()=>false).kind, 'none');
  assert.deepEqual(motion.sample(5000,true,true,()=>false), {kind:'gaze',amount:0});
  assert.deepEqual(motion.sample(5400,true,true,()=>false), {kind:'gaze',amount:1});
  assert.equal(motion.sample(8200,true,true,()=>false).kind, 'none');
  assert.equal(motion.sample(35_000,true,true,()=>false).kind, 'gaze');
  assert.equal(motion.sample(35_100,false,true,()=>false).kind, 'none');
  assert.deepEqual(pupilOffset(0,0,1),{x:0,y:0});
  assert.deepEqual(pupilOffset(10,0,1),{x:0,y:0});
  assert.deepEqual(pupilOffset(1000,0,1),{x:8,y:0});
  assert.ok(Math.abs(pupilOffset(-1000,-1000,.5).x) < 4);
});

test('rare, gaze and state acting are mutually exclusive', () => {
  const motion=new CharacterAmbient(0,{rareDelay:5000,rareInterval:180000,gazeDelay:5000,gazeInterval:30000,gazeDuration:3200});
  motion.sample(0,true,true,()=>false);
  assert.equal(motion.sample(5000,true,true,()=>true).kind,'rare');
  assert.equal(motion.sample(5600,true,true,()=>false).kind,'rare');
  assert.equal(motion.sample(5800,false,true,()=>false).kind,'none');
  assert.equal(motion.sample(5900,true,true,()=>false).kind,'none');
  assert.equal(motion.sample(10900,true,true,()=>false).kind,'gaze');
  assert.equal(motion.sample(11000,false,true,()=>false).kind,'none');
});
