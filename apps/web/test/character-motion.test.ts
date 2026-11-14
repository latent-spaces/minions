import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CharacterMotion,characterTiming,staticCharacterPose} from '../src/ui/character-motion.js';
import {CharacterPoke,choosePoke,POKE_WEIGHTS,pokeDuration,RarePokeGate} from '../src/ui/character-poke.js';
import {MessageFlights} from '../src/ui/communication-map/message-flights.js';

test('message acknowledgments suppress history and deduplicate multi-recipient and project messages',()=>{
  const flights=new MessageFlights(),history={id:'old',agentId:'a',to:['b'],audience:'direct',createdAt:100};
  flights.sample([history],100,0,false,true);assert.deepEqual(flights.takeStarts(),[]);
  const direct={...history,id:'new',to:['b','c'],createdAt:101},project={...history,id:'broadcast',audience:'project',to:[],createdAt:102};
  assert.equal(flights.sample([history,direct,project],102,10,false,true).length,2);
  assert.deepEqual(flights.takeStarts(),[{from:'a',id:'new'},{from:'a',id:'broadcast'}]);
  flights.sample([history,direct,project],103,20,false,true);assert.deepEqual(flights.takeStarts(),[]);
});
test('working takes a pen, alternates writing poses, puts it away once and returns to neutral',()=>{
  const m=new CharacterMotion('working',0);
  assert.equal(m.sample(0).clip,'neutral');assert.equal(m.sample(0).interruptible,false);
  assert.equal(m.sample(160).cell,0);assert.equal(m.sample(260).cell,1);
  assert.equal(m.sample(560).clip,'work-loop');assert.equal(m.sample(560).cell,2);
  assert.equal(m.sample(980).cell,3);
  m.setState('pausing',1000);assert.equal(m.sample(1000).clip,'stop');assert.equal(m.sample(1000).cell,4);
  m.setState('paused',1100);assert.equal(m.sample(1239).cell,4);assert.equal(m.sample(1240).cell,0);
  assert.notEqual(m.sample(1400).clip,'stop');
});
test('attention and transition owners reject decoration; stale observations immediately settle',()=>{
  const m=new CharacterMotion('needs_you',0);
  assert.equal(m.sample(160).cell,5);assert.equal(m.sample(8000).interruptible,false);
  m.message('ignored',8100);assert.equal(m.sample(8200).clip,'needs-you');
  m.setState('blocked',8300);assert.equal(m.sample(8460).cell,6);
  m.setState('offline',9000);assert.equal(m.sample(9500).clip,'neutral');assert.equal(m.sample(9500).interruptible,false);
  assert.equal(staticCharacterPose('working').cell,2);assert.equal(staticCharacterPose('blocked').cell,6);
});
test('message acknowledgment is deduplicated, has a neutral entry and resumes current work',()=>{
  const m=new CharacterMotion('working',0);m.sample(3000);m.message('m1',3100);
  assert.equal(m.sample(3100).clip,'neutral');assert.equal(m.sample(3260).cell,7);
  m.message('m1',3400);assert.equal(m.sample(3500).cell,8);assert.equal(m.sample(3740).clip,'work-loop');
  m.message('m2',4000);m.settle(4100);assert.equal(m.sample(4100).clip,'work-loop');
});
test('blink and writing phases vary by identity while blink timing stays occasional',()=>{
  const a=new CharacterMotion('idle',0,characterTiming('a')),b=new CharacterMotion('idle',0,characterTiming('b'));
  assert.notDeepEqual(characterTiming('a'),characterTiming('b'));
  assert.ok(Array.from({length:750},(_,i)=>i*80+160).some(t=>a.sample(t).cell!==b.sample(t).cell));
  for(const id of ['a','b','person-01']){const timing=characterTiming(id);assert.ok(timing.interval>=16000&&timing.interval<=26667);}
  const m=new CharacterMotion('idle',0);assert.equal(m.sample(160).clip,'blink');assert.equal(m.sample(300).clip,'neutral');
});
test('weighted poke selection covers its exact boundaries and rejects invalid randomness',()=>{
  assert.equal(POKE_WEIGHTS.reduce((n,[,weight])=>n+weight,0),100);
  for(const [n,result] of [[0,'poke'],[.549999,'poke'],[.55,'smile'],[.75,'wink'],[.90,'surprise'],[.97,'rare'],[.999999,'rare']] as const)assert.equal(choosePoke(n),result);
  for(const invalid of [-.1,1,NaN,Infinity])assert.throws(()=>choosePoke(invalid),RangeError);
});
test('one poke owns its whole reward; rapid clicks never reroll, stack or queue',()=>{
  const p=new CharacterPoke();assert.equal(p.start(100,'rare'),true);assert.equal(p.sample(100)?.cell,1);
  assert.equal(p.start(101,'wink'),false);assert.equal(p.sample(220)?.cell,6);assert.equal(p.sample(400)?.cell,7);
  assert.equal(p.sample(1000)?.cell,8);assert.equal(p.sample(1300),null);assert.equal(p.start(1300,'wink'),true);
  p.cancel();assert.equal(p.sample(1400),null);
  for(const [reaction] of POKE_WEIGHTS){const q=new CharacterPoke();q.start(0,reaction);assert.ok(q.sample(pokeDuration(reaction)-1));assert.equal(q.sample(pokeDuration(reaction)),null);}
  const gate=new RarePokeGate();assert.equal(gate.claim(0),true);assert.equal(gate.claim(1199),false);assert.equal(gate.claim(1200),true);
});

test('ordinary blinks wait for gaze ownership to finish, and pokes reset their cadence',()=>{
  const m=new CharacterMotion('idle',0);
  assert.equal(m.sample(160,false).clip,'neutral');
  assert.equal(m.sample(10000,false).clip,'neutral');
  assert.equal(m.sample(10000,true).clip,'blink');
  assert.equal(m.sample(10139,false).clip,'blink');
  assert.equal(m.sample(10140,true).clip,'neutral');
  m.afterPoke(11000);
  assert.equal(m.sample(12000,true).clip,'neutral');
  assert.equal(m.sample(11000+21333,false).clip,'neutral');
  assert.equal(m.sample(11000+21333,true).clip,'blink');
});

test('talking speaks in short beats between resting faces, and its still pose is the speaking one',()=>{
  const motion=new CharacterMotion('talking',0,{interval:1e9,offset:0,rate:1});
  const clips=[100,300,1200,2900].map(t=>motion.sample(t,false).clip);
  assert.deepEqual(clips,['neutral','message','neutral','message']);
  assert.equal(staticCharacterPose('talking').clip,'message');
});
