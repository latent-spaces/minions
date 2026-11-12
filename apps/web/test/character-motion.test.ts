import { test } from 'node:test';
import assert from 'node:assert/strict';
const expect = (value: unknown) => ({ toEqual: (other: unknown) => assert.deepEqual(value, other), toBe: (other: unknown) => assert.equal(value, other), toHaveLength: (n: number) => assert.equal((value as unknown[]).length, n) });
import { CharacterMotion, characterTiming } from '../src/ui/character-motion.js';
import { MessageFlights } from '../src/ui/communication-map/message-flights.js';

test('message acknowledgments suppress history and deduplicate multi-recipient and project messages', () => {
  const flights = new MessageFlights();
  const history = { id: 'old', agentId: 'a', to: ['b'], audience: 'direct', createdAt: 100 };
  flights.sample([history], 100, 0, false, true);
  expect(flights.takeStarts()).toEqual([]);
  const direct = { ...history, id: 'new', to: ['b', 'c'], createdAt: 101 };
  const project = { ...history, id: 'broadcast', audience: 'project', to: [], createdAt: 102 };
  expect(flights.sample([history, direct, project], 102, 10, false, true)).toHaveLength(2);
  expect(flights.takeStarts()).toEqual([{ from: 'a', id: 'new' }, { from: 'a', id: 'broadcast' }]);
  flights.sample([history, direct, project], 103, 20, false, true);
  expect(flights.takeStarts()).toEqual([]);
});

test('working enters from neutral, focuses continuously, stops once and settles', () => {
  const motion = new CharacterMotion('working', 0);
  expect(motion.sample(0)).toEqual({ clip: 'neutral', frame: 0 });
  expect(motion.sample(160)).toEqual({ clip: 'work-enter', frame: 0 });
  expect(motion.sample(2080)).toEqual({ clip: 'work-loop', frame: 0 });
  expect(motion.sample(4000)).toEqual({ clip: 'work-loop', frame: 0 });
  motion.setState('pausing', 4100);
  expect(motion.sample(4100)).toEqual({ clip: 'stop', frame: 0 });
  motion.setState('paused', 4500);
  expect(motion.sample(4500)).toEqual({ clip: 'stop', frame: 2 });
  expect(motion.sample(6020).clip).toBe('blink');
});

test('attention gestures hold; stale observations immediately cancel activity', () => {
  const motion = new CharacterMotion('needs_you', 0);
  expect(motion.sample(160).clip).toBe('needs-you');
  expect(motion.sample(8000)).toEqual({ clip: 'needs-you', frame: 11 });
  motion.message('ignored', 8100);
  expect(motion.sample(8200).clip).toBe('needs-you');
  motion.setState('blocked', 8300);
  expect(motion.sample(12000)).toEqual({ clip: 'blocked', frame: 11 });
  motion.setState('offline', 13000);
  expect(motion.sample(20000)).toEqual({ clip: 'neutral', frame: 0 });
});

test('real message is a deduplicated one-shot and resumes working', () => {
  const motion = new CharacterMotion('working', 0);
  motion.sample(3000); motion.message('m1', 3100);
  expect(motion.sample(3260)).toEqual({ clip: 'message', frame: 0 });
  motion.message('m1', 3400);
  expect(motion.sample(3420)).toEqual({ clip: 'message', frame: 1 });
  expect(motion.sample(5180).clip).toBe('work-loop');
});


// Timing varies by immutable agent ID even when two agents share the same artwork.
test('loop timing varies per agent while one-shot entrances remain neutral and ordered', () => {
  const a = new CharacterMotion('working', 0, characterTiming('agent-a'));
  const b = new CharacterMotion('working', 0, characterTiming('agent-b'));
  assert.deepEqual(a.sample(0), {clip:'neutral', frame:0});
  assert.deepEqual(b.sample(0), {clip:'neutral', frame:0});
  assert.equal(a.sample(160).clip, 'work-enter');
  assert.equal(b.sample(160).clip, 'work-enter');
  assert.notDeepEqual(characterTiming('agent-a'), characterTiming('agent-b'));
  assert.ok(Array.from({length:750}, (_, i) => i * 80 + 2080).some(time => a.sample(time).frame !== b.sample(time).frame));
  assert.deepEqual(characterTiming('agent-a'), characterTiming('agent-a'));
  const idleA = new CharacterMotion('idle', 0, characterTiming('agent-a'));
  const idleB = new CharacterMotion('idle', 0, characterTiming('agent-b'));
  assert.ok(Array.from({length:750}, (_, i) => i * 80 + 160).some(time => idleA.sample(time).frame !== idleB.sample(time).frame));
});


test('ordinary and working loops hold eyes open between infrequent normal-speed gestures', () => {
  for (const state of ['idle', 'working'] as const) {
    const motion = new CharacterMotion(state, 0);
    const start = state === 'working' ? 2080 : 160;
    assert.equal(motion.sample(start + 640).frame, 4);
    for (const elapsed of [2000, 4000, 8000, 12000, 20000]) {
      assert.equal(motion.sample(start + elapsed).frame, 0);
    }
    assert.equal(motion.sample(start + 21333 + 640).frame, 4);
  }
  for (const id of ['a', 'b', 'c', 'person-01']) {
    const {interval} = characterTiming(id);
    assert.ok(interval >= 16000 && interval <= 26667);
  }
});
