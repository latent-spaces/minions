import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realtimeParser } from '../src/realtime-events.ts';

test('events survive every split boundary, heartbeats and several events per chunk', () => {
  const wire = ': heartbeat\n\ndata: {"topics":["conversations","agents","agents"]}\n\ndata: {"topics":["needs-you","teams"]}\n\n';
  for (let split = 0; split <= wire.length; split++) {
    const events: string[][] = [], parse = realtimeParser(topics => events.push(topics));
    parse(wire.slice(0, split)); parse(wire.slice(split));
    assert.deepEqual(events, [['conversations', 'agents'], ['needs-you', 'teams']]);
  }
});
test('unexpected payloads and unbounded frames are refused', () => {
  for (const data of ['null', '{}', '{"topics":[]}', '{"topics":["private-record"]}', '{"topics":[1]}']) {
    assert.throws(() => realtimeParser(() => assert.fail('invalid event delivered'))('data: ' + data + '\n\n'));
  }
  assert.throws(() => realtimeParser(() => {})('x'.repeat(16385)));
});
