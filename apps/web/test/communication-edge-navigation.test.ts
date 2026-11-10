import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connectionMessageId} from '../src/ui/communication-map/read-traffic';
import {communicationWeights} from '../src/ui/communication-map/layout';
import {MessageFlights} from '../src/ui/communication-map/message-flights';
test('people and agents reuse recent-message navigation, fading and one-pass animation',()=>{
 const rows=[
  {id:'older',agentId:'person:alice',to:['fox'],audience:'direct',createdAt:1000},
  {id:'broadcast',agentId:'person:alice',to:['fox'],audience:'project',createdAt:5000},
  {id:'newer',agentId:'person:alice',to:['fox','owl'],audience:'direct',createdAt:2000},
  {id:'agent',agentId:'fox',to:['owl'],audience:'direct',createdAt:3000},
 ];
 assert.equal(connectionMessageId(rows,'person:alice','fox'),'newer');
 assert.equal(connectionMessageId(rows,'person:alice','owl'),'newer');
 assert.equal(connectionMessageId(rows,'fox','owl'),'agent');
 assert.equal(connectionMessageId(rows,'person:bob','fox'),null);
 assert.ok(communicationWeights(rows,3000).some(e=>e.from==='person:alice'&&e.to==='fox'));
 assert.equal(communicationWeights(rows,50000).length,0);
 const flights=new MessageFlights();flights.sample([],0,0,false,true);
 assert.equal(flights.sample(rows,3000,0,false,true).filter(f=>f.from==='person:alice').length,3);
 assert.equal(flights.sample(rows,3001,1401,false,true).length,0);
});
