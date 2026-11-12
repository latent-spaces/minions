import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectionWeights,repeatingConnectionFlights,connectionExcerpt,CONNECTION_LIFETIME} from '../src/ui/communication-map/connection-presentation';
import {communicationWeights} from '../src/ui/communication-map/layout';
import {connectionMessageId} from '../src/ui/communication-map/read-traffic';
import {MessageFlights} from '../src/ui/communication-map/message-flights';

test('visual pipes survive three minutes without extending physical attraction',()=>{
 const rows=[{id:'old',agentId:'a',to:['b'],audience:'direct',createdAt:0}];
 assert.equal(communicationWeights(rows,45_000).length,0);
 assert.equal(connectionWeights(rows,120_000).length,1);
 assert.equal(connectionWeights(rows,CONNECTION_LIFETIME-1).length,1);
 assert.equal(connectionWeights(rows,CONNECTION_LIFETIME).length,0);
 assert.equal(connectionWeights(rows,-1).length,0);
});

test('existing traffic repeats visually without generating new message acknowledgments',()=>{
 const rows=[{id:'already-sent',agentId:'a',to:['b'],audience:'direct',createdAt:0}];
 const links=connectionWeights(rows,60_000),flights=new MessageFlights();
 flights.sample(rows,60_000,0,false,true);
 let visible=0;
 for(let clock=0;clock<10_800;clock+=100){
  const pulses=repeatingConnectionFlights(links,clock);visible+=pulses.length;
  assert.deepEqual(pulses,repeatingConnectionFlights(links,clock+3600));
 }
 assert.ok(visible>0);assert.deepEqual(flights.takeStarts(),[]);
 assert.deepEqual(repeatingConnectionFlights([],100),[]);
});

test('preview selects the latest eligible directional message and limits its excerpt',()=>{
 const rows=[{id:'old',agentId:'a',to:['b'],audience:'direct',createdAt:100},
  {id:'latest',agentId:'a',to:['b'],audience:'direct',createdAt:200},
  {id:'future',agentId:'a',to:['b'],audience:'direct',createdAt:300},
  {id:'reverse',agentId:'b',to:['a'],audience:'direct',createdAt:250}];
 assert.equal(connectionMessageId(rows,'a','b',250),'latest');
 assert.equal(connectionMessageId(rows,'b','a',250),'reverse');
 assert.equal(connectionExcerpt('  Hello\n\tworld  '),'Hello world');
 assert.equal(Array.from(connectionExcerpt('🙂'.repeat(200))).length,161);
 assert.equal(connectionExcerpt('x'.repeat(200)), 'x'.repeat(160)+'…');
});
