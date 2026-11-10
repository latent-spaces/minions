import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ConversationMotion} from '../src/ui/communication-map/motion';
import {communicationWeights,initialPositions} from '../src/ui/communication-map/layout';
import {initialPositions3D} from '../src/ui/communication-map/layout3d';

const link=(from:string,to:string,weight=1)=>({from,to,weight,count:1,latestAt:0});
const distance=(points:Float64Array,a:number,b:number,d:number)=>Math.hypot(...Array.from({length:d},(_,axis)=>points[a*d+axis]-points[b*d+axis]));
for(const d of [2,3] as const){
  const pair=()=>new ConversationMotion(['a','b'],Float64Array.from(d===2?[-300,0,300,0]:[-300,0,0,300,0,0]),d);
  test(`${d}D repeated bursts and reply direction do not disturb a resting pair`,()=>{
    const engine=pair();
    for(let i=0;i<700;i++)engine.step([i%2?link('a','b',1):link('b','a',30)]);
    const resting=engine.y.slice();
    for(let i=0;i<300;i++)engine.step([i%2?link('a','b',1):link('b','a',30)]);
    assert.deepEqual(engine.y,resting);
    assert.ok(distance(engine.y,0,1,d)>130 && distance(engine.y,0,1,d)<170);
    for(let axis=0;axis<d;axis++)assert.ok(Math.abs(engine.y[axis]+engine.y[d+axis])<1e-8,'pair center stays anchored by symmetric forces');
  });
  test(`${d}D expiry fades physical strength instead of abruptly changing velocity`,()=>{
    const engine=pair();
    for(let i=0;i<20;i++)engine.step([link('a','b')]);
    const before=engine.velocity.slice(),points=engine.y.slice();engine.step([]);
    assert.ok(engine.y[0]>points[0],'movement continues after edge disappears');
    assert.ok(engine.velocity[0]>before[0]*.75,'no hard velocity reset');
    for(let i=0;i<1200;i++)engine.step([]);
    const rest=engine.y.slice();for(let i=0;i<30;i++)engine.step([]);
    assert.deepEqual(engine.y,rest,'eventually comes fully to rest');
  });
  test(`${d}D new partner accelerates gradually; no teleport or unbounded step`,()=>{
    const seed=new Float64Array(3*d);seed[0]=-300;seed[d]=-150;seed[2*d]=350;
    const engine=new ConversationMotion(['a','b','c'],seed,d);
    for(let i=0;i<300;i++)engine.step([link('a','b')]);
    const start=distance(engine.y,0,2,d),before=engine.y.slice();engine.step([link('a','c')]);
    assert.ok(Math.abs(engine.y[0]-before[0])<.5,'soft start');
    for(let i=0;i<700;i++){
      const previous=engine.y.slice();engine.step([link('a','c',i%2?1:20)]);
      for(let a=0;a<3;a++)assert.ok(Math.hypot(...Array.from({length:d},(_,axis)=>engine.y[a*d+axis]-previous[a*d+axis]))<=3.21);
    }
    assert.ok(distance(engine.y,0,2,d)<start-100);
  });
  test(`${d}D dense rotating conversations remain separated and finish quietly`,()=>{
    const ids=Array.from({length:18},(_,i)=>String(i));
    const engine=new ConversationMotion(ids,d===2?initialPositions(18):initialPositions3D(18),d);
    let minimum=Infinity;
    for(let i=0;i<1200;i++){
      engine.step(i<600?ids.slice(0,12).map((id,j)=>link(id,String((j+1+Math.floor(i/80))%12))):[]);
      if(i>30)for(let a=0;a<18;a++)for(let b=a+1;b<18;b++)minimum=Math.min(minimum,distance(engine.y,a,b,d));
      assert.ok(engine.y.every(Number.isFinite));
    }
    assert.ok(minimum>104,`minimum center distance ${minimum}`);
    const rest=engine.y.slice();for(let i=0;i<30;i++)engine.step([]);
    assert.deepEqual(engine.y,rest);
  });
  test(`${d}D wall time controls motion, zero time freezes, long gaps never catch up`,()=>{
    const fine=pair(),coarse=pair(),links=[link('a','b')];
    for(let i=0;i<600;i++)fine.step(links,1/60);
    for(let i=0;i<100;i++)coarse.step(links,.1);
    for(let k=0;k<fine.y.length;k++)assert.ok(Math.abs(fine.y[k]-coarse.y[k])<1e-7);
    const frozen=coarse.y.slice();coarse.step([link('b','a',50)],0);assert.deepEqual(coarse.y,frozen);
    const a=pair(),b=pair();a.step(links,100);b.step(links,.2);assert.deepEqual(a.y,b.y);
  });
  test(`${d}D quiet distant agents stay exact; coincident nodes escape deterministically`,()=>{
    const seed=new Float64Array(3*d);seed[0]=-200;seed[d]=200;seed[2*d]=700;
    const quiet=new ConversationMotion(['a','b','c'],seed,d);
    for(let i=0;i<300;i++)quiet.step([link('a','b')]);
    assert.deepEqual(quiet.y.slice(2*d),seed.slice(2*d));
    const a=new ConversationMotion(['a','b'],new Float64Array(2*d),d),b=new ConversationMotion(['a','b'],new Float64Array(2*d),d);
    for(let i=0;i<200;i++){a.step([]);b.step([]);}
    assert.deepEqual(a.y,b.y);assert.ok(distance(a.y,0,1,d)>125);
  });
}
test('physical smoothing does not extend actual visible message history',()=>{
  const message={agentId:'a',to:['b'],audience:'direct',createdAt:0};
  assert.equal(communicationWeights([message],44999).length,1);
  assert.equal(communicationWeights([message],45000).length,0);
});
