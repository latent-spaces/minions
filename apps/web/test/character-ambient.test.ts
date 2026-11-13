import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CharacterAmbient,ambientTiming,gazeCell,subscribeCharacterPointer,characterPointer} from '../src/ui/character-ambient.js';

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

test('gaze remains occasional and independently timed, with no autonomous rare scheduler',()=>{
  for(const id of ['a','b','person-01']){const t=ambientTiming(id);assert.ok(Math.abs((t.gazeDuration+2000)/t.gazeInterval-.85)<.0001);assert.ok(t.gazeDelay>=2000&&t.gazeDelay<=5000);assert.ok(t.gazeDuration>=10000&&t.gazeDuration<=15000);assert.equal('rareDelay' in t,false);}
  assert.notDeepEqual(ambientTiming('a'),ambientTiming('b'));
  const m=new CharacterAmbient(0,{gazeDelay:5000,gazeInterval:30000,gazeDuration:3200});
  assert.equal(m.sample(0,true,true).kind,'none');assert.equal(m.sample(5000,true,true).kind,'gaze');
  assert.equal(m.sample(8200,true,true).kind,'none');assert.equal(m.sample(35000,true,true).kind,'gaze');
  assert.equal(m.sample(35100,false,true).kind,'none');assert.equal(m.sample(35200,true,true).kind,'none');
});
test('continuous pointer activity starts about fifteen percent fewer gaze episodes without shortening them',()=>{
  const t=ambientTiming('person-01');
  const count=(interval:number)=>{
    const m=new CharacterAmbient(0,{...t,gazeDelay:0,gazeInterval:interval});let episodes=0,wasLooking=false;
    for(let at=0;at<3_600_000;at+=100){const looking=m.sample(at,true,true).kind==='gaze';if(looking&&!wasLooking)episodes++;wasLooking=looking;}
    return episodes;
  };
  assert.ok(Math.abs(count(t.gazeInterval)/count(t.gazeDuration+2000)-.85)<.01);
  const m=new CharacterAmbient(0,{...t,gazeDelay:0});
  assert.equal(m.sample(0,true,true).kind,'gaze');
  assert.equal(m.sample(t.gazeDuration-1,true,true).kind,'gaze');
  assert.equal(m.sample(t.gazeDuration,true,true).kind,'none');
  assert.equal(m.sample(t.gazeInterval,true,true).kind,'gaze');
});
test('long glances finish and retain a neutral gap rather than renewing while active',()=>{
  const m=new CharacterAmbient(0,{gazeDelay:0,gazeInterval:14000,gazeDuration:15000});
  assert.equal(m.sample(0,true,true).kind,'gaze');assert.equal(m.sample(14000,true,true).kind,'gaze');
  assert.equal(m.sample(15000,true,true).kind,'none');assert.equal(m.sample(16999,true,true).kind,'none');assert.equal(m.sample(17000,true,true).kind,'gaze');
});
test('direction cells follow the cursor and hysteresis prevents sector chatter',()=>{
  assert.deepEqual(gazeCell(10,10),{cell:4,sector:-1});
  assert.equal(gazeCell(100,0).cell,5);assert.equal(gazeCell(-100,0).cell,3);assert.equal(gazeCell(0,-100).cell,1);assert.equal(gazeCell(0,100).cell,7);
  const angle=Math.PI/8+.05;
  assert.equal(gazeCell(100*Math.cos(angle),100*Math.sin(angle),0).sector,0);
  assert.equal(gazeCell(100*Math.cos(angle+.15),100*Math.sin(angle+.15),0).sector,1);
});
