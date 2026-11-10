import assert from 'node:assert/strict';
import {test} from 'node:test';
import {metadataTraffic,type MapReply,type MapRequest} from '../src/ui/communication-map/protocol';

test('first arriving traffic preserves the seed; paused updates never integrate physics',async()=>{
  const replies:MapReply[]=[];
  const worker={postMessage:(reply:MapReply)=>replies.push(reply),onmessage:null as null|((event:{data:MapRequest})=>void)};
  const original=Object.getOwnPropertyDescriptor(globalThis,'self');
  Object.defineProperty(globalThis,'self',{value:worker,configurable:true});
  try{
    await import('../src/ui/communication-map/map.worker');
    const send=(data:MapRequest)=>worker.onmessage!({data});
    send({kind:'init',dimensions:2,nodes:[{id:'a'},{id:'b'}],traffic:[]});
    const seed=replies[0];assert.equal(seed.kind,'seed');
    const traffic=[{agentId:'a',to:['b'],createdAt:0,audience:'direct',body:'private body',name:'private name'}];
    send({kind:'traffic',traffic:metadataTraffic(traffic)});
    assert.equal(replies.length,1,'traffic must not emit another seed');
    send({kind:'step',sequence:1,at:0,elapsedMs:0});
    const paused=replies.at(-1)!;assert.equal(paused.kind,'frame');
    if(seed.kind==='seed'&&paused.kind==='frame')assert.deepEqual(paused.points,seed.points);
    send({kind:'step',sequence:2,at:0,elapsedMs:100});
    assert.equal(replies.filter(reply=>reply.kind==='seed').length,1);
    assert.ok(replies.every(reply=>reply.kind!=='error'));
    assert.deepEqual(metadataTraffic(traffic),[{agentId:'a',to:['b'],audience:'direct',createdAt:0}]);
  }finally{
    if(original)Object.defineProperty(globalThis,'self',original);else Reflect.deleteProperty(globalThis,'self');
  }
});
