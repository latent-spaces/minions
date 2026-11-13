import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newerUpdate,parseUpdateSeen,unseenUpdates,updateSeenKey} from '../src/update-seen.js';

test('seen markers validate persisted data and isolate accounts and projects',()=>{
  for(const value of [null,'{','null','{}','{"id":"","publishedAt":1}','{"id":"a","publishedAt":-1}','{"id":"a","publishedAt":"1"}'])
    assert.equal(parseUpdateSeen(value),null);
  assert.deepEqual(parseUpdateSeen('{"id":"a","publishedAt":100}'),{id:'a',publishedAt:100});
  assert.notEqual(updateSeenKey('a:b','c'),updateSeenKey('a','b:c'));
  assert.notEqual(updateSeenKey('alice','project'),updateSeenKey('bob','project'));
  assert.notEqual(updateSeenKey('alice','one'),updateSeenKey('alice','two'));
});
test('unseen counts follow feed ordering and distinguish a paginated lower bound',()=>{
  const rows=[{id:'c',publishedAt:200},{id:'b',publishedAt:100},{id:'a',publishedAt:100}];
  assert.deepEqual(unseenUpdates(rows,null,null),{count:3,hasMore:false});
  assert.deepEqual(unseenUpdates(rows,null,'older'),{count:3,hasMore:true});
  assert.deepEqual(unseenUpdates(rows,{id:'a',publishedAt:100},'older'),{count:2,hasMore:false});
  assert.deepEqual(unseenUpdates(rows,rows[0],'older'),{count:0,hasMore:false});
  assert.deepEqual(unseenUpdates([],null,'older'),{count:0,hasMore:false});
  assert.equal(newerUpdate(rows[2],rows[1]),false);
  assert.equal(newerUpdate(rows[0],{id:'z',publishedAt:300}),false);
});
