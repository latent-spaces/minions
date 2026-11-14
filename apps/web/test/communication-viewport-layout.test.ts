import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeToViewport} from '../src/ui/communication-map/viewport-layout';

test('fits each axis into actual map bounds without mutating physics or depth',()=>{
 const source=new Float64Array([-100,-20,5,0,0,8,100,20,11]),before=source.slice();
 for(const [width,height] of [[285,560],[1002,420],[1500,700]]){
  const points=normalizeToViewport(source,width,height);
  assert.deepEqual(source,before);
  const x=Array.from({length:3},(_,i)=>points[i*3]+width/2),y=Array.from({length:3},(_,i)=>points[i*3+1]+height/2);
  assert.ok(x[0]>=60&&x[2]<=width-60);
  assert.ok(y[0]>=54&&y[2]<=height-76);
  assert.ok(Math.abs(x[1]-(x[0]+x[2])/2)<1e-8);
  assert.ok(Math.abs(y[1]-(y[0]+y[2])/2)<1e-8);
  assert.deepEqual([points[2],points[5],points[8]],[5,8,11]);
 }
});
test('centres coincident axes and handles empty or not-yet-sized containers',()=>{
 const points=new Float64Array([10,20,0,10,20,1]);
 assert.ok([...normalizeToViewport(points,285,560)].every(Number.isFinite));
 const output=normalizeToViewport(points,285,560);
 assert.equal(output[0],0);assert.equal(output[3],0);
 assert.deepEqual(normalizeToViewport(points,0,0),points);
 assert.equal(normalizeToViewport(new Float64Array(),285,560).length,0);
});
test('reserves embedded controls above the drawable rectangle',()=>{
 const result=normalizeToViewport(new Float64Array([0,0,0,100,100,0]),400,600,70);
 assert.equal(result[1]+300,124);
 assert.equal(result[4]+300,524);
});
