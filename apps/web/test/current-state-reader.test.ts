import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCurrentState, createReader, currentStateRows, restartReader, type CurrentStateAnswer, type CurrentStateReader }
  from '../src/ui/communication-map/current-state-reader';

// Cursors as current-state-core.ts (contract v2.2) writes them: first read `s.P.id`, delta `B.P.id`, complete `P.~`.
type Data = { state: string };
const R = (s: number) => `${String(s).padStart(12, '0')}.000000000`;
const first = (pin: number, id: string) => `s.${R(pin)}.${id}`;
const delta = (base: number, pin: number, id: string) => `${R(base)}.${R(pin)}.${id}`;
const done = (pin: number) => `${R(pin)}.~`;
const row = (id: string, at: number, state = 'idle') => ({ id, rev: R(at), state });
const gone = (id: string, at: number) => ({ id, rev: R(at), removed: true as const });
const answer = (rows: CurrentStateAnswer<Data>['rows'], cursor: string, extra: Partial<CurrentStateAnswer<Data>> = {}): CurrentStateAnswer<Data> =>
  ({ rows, cursor, more: false, notReady: false, needsYou: [], needsYouComplete: true, serverTime: 100, ...extra });
const held = (reader: CurrentStateReader<Data>) => currentStateRows(reader).map(r => [r.id, r.state]);
const step = (reader: CurrentStateReader<Data>, a: CurrentStateAnswer<Data>) => applyCurrentState(reader, reader.cursor, a);

test('a paged first read completes only on its last page, then deltas apply the newest revision per id', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1), row('b', 2)], first(5, 'b'), { more: true }));
  assert.equal(reader.complete, false);
  reader = step(reader, answer([row('c', 3)], done(5)));
  assert.equal(reader.complete, true);
  assert.equal(reader.phase, 'delta');
  reader = step(reader, answer([row('b', 6, 'working'), gone('c', 7)], done(8)));
  assert.deepEqual(held(reader), [['a', 'idle'], ['b', 'working']]);
  assert.equal(reader.cursor, done(8));
});

test('an answer to an older cursor (late, duplicated or replayed) is ignored whole', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1)], done(5)));
  const replay = answer([row('a', 1), row('z', 1)], done(5));
  reader = step(reader, answer([row('a', 6, 'working')], done(6)));
  // The first-read response delivered again (sent with no cursor) neither adds z nor moves the cursor back.
  const after = applyCurrentState(reader, null, replay);
  assert.equal(after, reader);
  assert.deepEqual(held(after), [['a', 'working']]);
  assert.equal(after.cursor, done(6));
});

test('an older revision never replaces a newer row, and a removal blocks an older row', () => {
  let reader = step(createReader<Data>(), answer([row('a', 9, 'working')], done(9)));
  // A row sent at a head newer than its cut (v2.2) arrives again in the next delta; neither copy goes backwards.
  reader = step(reader, answer([row('a', 4, 'offline'), gone('b', 10), row('b', 8)], done(10)));
  assert.deepEqual(held(reader), [['a', 'working']]);
  reader = step(reader, answer([row('b', 11, 'working')], done(11)));
  assert.deepEqual(held(reader), [['a', 'working'], ['b', 'working']]);
});

test('a re-derived row under the same rev lands only if evaluated later (v2.3); an equal row is ignored', () => {
  let reader = step(createReader<Data>(), answer([{ ...row('a', 5, 'working'), evaluatedAt: 100 }], done(5)));
  // A clock-only transition: the server re-sends the same source rev, evaluated later: Offline.
  reader = step(reader, answer([{ ...row('a', 5, 'offline'), evaluatedAt: 200 }], done(6)));
  assert.deepEqual(held(reader), [['a', 'offline']]);
  // A slower process re-sending the same rev evaluated earlier, or an equal row, never undoes it.
  reader = step(restartReader(reader), answer([{ ...row('a', 5, 'working'), evaluatedAt: 150 }], done(6)));
  assert.deepEqual(held(reader), [['a', 'offline']]);
  reader = step(reader, answer([{ ...row('a', 5, 'working'), evaluatedAt: 200 }], done(7)));
  assert.deepEqual(held(reader), [['a', 'offline']]);
  // Without evaluatedAt an equal rev is an equal row: ignored (v2.2).
  reader = step(createReader<Data>(), answer([row('b', 5, 'working')], done(5)));
  reader = step(reader, answer([row('b', 5, 'offline')], done(6)));
  assert.deepEqual(held(reader), [['b', 'working']]);
});

test('a restarted first read prunes absent ids only after its last page; a delta never prunes', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1), row('b', 2), row('c', 3)], done(3)));
  reader = step(reader, answer([row('a', 4)], delta(3, 6, 'a'), { more: true }));
  reader = step(reader, answer([], done(6)));
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'b', 'c']);
  reader = step(restartReader(reader), answer([row('a', 4)], first(9, 'a'), { more: true }));
  // Mid-read b and c are still held: the next page may list them.
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'b', 'c']);
  reader = step(reader, answer([row('c', 3)], done(9)));
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'c']);
  assert.equal(reader.complete, true);
});

test('notReady (a process behind the cut) changes nothing; the same cursor is asked again', () => {
  let reader = step(restartReader(step(createReader<Data>(), answer([row('a', 1), row('b', 2)], done(2)))),
    answer([row('a', 1)], first(4, 'a'), { more: true }));
  const behind = step(reader, answer([], first(4, 'a'), { more: true, notReady: true }));
  assert.equal(behind.notReady, true);
  assert.equal(behind.complete, false);
  assert.equal(behind.cursor, first(4, 'a'));
  assert.deepEqual(held(behind).map(([id]) => id), ['a', 'b']);
  reader = step(behind, answer([row('b', 2)], done(4)));
  assert.equal(reader.complete, true);
  assert.equal(reader.notReady, false);
  // On a complete cursor, notReady with more:false is "not yet", not "nothing new": the reader stays complete at its cut.
  const idle = step(reader, answer([], done(4), { notReady: true }));
  assert.equal(idle.complete, true);
  assert.equal(idle.notReady, true);
});

test('Needs you is the viewer\'s current set; an incomplete set keeps earlier flags', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1)], done(1), { needsYou: ['a', 'b'] }));
  reader = step(reader, answer([], done(2), { needsYou: ['c'], needsYouComplete: false }));
  assert.deepEqual([...reader.needsYou].sort(), ['a', 'b', 'c']);
  reader = step(reader, answer([], done(3), { needsYou: ['c'] }));
  assert.deepEqual([...reader.needsYou], ['c']);
});

test('removal memory lasts until a newer row for the id, across complete answers', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1)], done(1)));
  reader = step(reader, answer([gone('a', 4)], done(3)));
  // A slower process's delta still carries a's rev-3 row: it must not bring a back.
  reader = step(reader, answer([row('a', 3)], done(5)));
  assert.deepEqual(held(reader), []);
  reader = step(reader, answer([row('a', 6, 'working')], done(6)));
  assert.deepEqual(held(reader), [['a', 'working']]);
  assert.equal(reader.removed.size, 0);
});

test('the cursor is opaque: an endpoint-wrapped cursor completes on more:false without notReady', () => {
  // c3's endpoint wraps the core cursor as core:depsHash:E; the reader never parses it.
  const wrap = (core: string) => `${core}:h1:1700`;
  let reader = step(createReader<Data>(), answer([row('a', 1)], wrap(first(5, 'a')), { more: true }));
  reader = step(reader, answer([], wrap(first(5, 'a')), { more: true, notReady: true }));
  assert.equal(reader.complete, false);
  reader = step(reader, answer([row('b', 2)], wrap(done(5))));
  assert.equal(reader.complete, true);
  assert.equal(reader.cursor, wrap(done(5)));
});

test('a reset (dependency change) replaces the held set: prune only after its last page, never mid-way', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1), row('b', 2), row('c', 3)], done(3)));
  reader = step(reader, answer([row('a', 1, 'paused')], first(7, 'a'), { more: true, reset: true }));
  assert.equal(reader.phase, 'snapshot');
  assert.equal(reader.complete, false);
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'b', 'c']);
  // A notReady between the pages changes nothing.
  reader = step(reader, answer([], first(7, 'a'), { more: true, notReady: true }));
  reader = step(reader, answer([row('c', 3)], done(7)));
  assert.equal(reader.complete, true);
  assert.equal(reader.phase, 'delta');
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'c']);
  // A later delta never prunes.
  reader = step(reader, answer([row('a', 8)], done(8)));
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'c']);
});

test('a reset row re-derived at the same rev (access revoked, no source write) replaces the held row (c5)', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1, 'working'), row('b', 1, 'working')], done(1)));
  reader = step(reader, answer([row('a', 1, 'revoked')], first(2, 'a'), { more: true, reset: true }));
  reader = step(reader, answer([row('b', 1, 'working')], done(2)));
  assert.deepEqual(held(reader), [['a', 'revoked'], ['b', 'working']]);
  // After the replacement completes, an equal row without a later evaluatedAt is ignored again.
  reader = step(reader, answer([row('a', 1, 'working')], done(3)));
  assert.deepEqual(held(reader), [['a', 'revoked'], ['b', 'working']]);
});

test('in a reset, an equal-rev row evaluated earlier (a slow-clock process) does not replace the held row (c7)', () => {
  let reader = step(createReader<Data>(), answer([{ ...row('a', 1, 'offline'), evaluatedAt: 90_500 }], done(1)));
  reader = step(reader, answer([{ ...row('a', 1, 'working'), evaluatedAt: 89_800 }], done(2), { reset: true }));
  assert.deepEqual(held(reader), [['a', 'offline']]);
  reader = step(reader, answer([{ ...row('a', 1, 'revoked'), evaluatedAt: 91_000 }], done(3), { reset: true }));
  assert.deepEqual(held(reader), [['a', 'revoked']]);
});

test('an answer\'s serverTime never orders an equal rev, inside or outside a reset (c5, c7)', () => {
  let reader = step(createReader<Data>(), answer([row('a', 5, 'working')], done(5), { serverTime: 100 }));
  reader = step(reader, answer([row('a', 5, 'offline')], done(6), { serverTime: 200 }));
  assert.deepEqual(held(reader), [['a', 'working']]);
  // c5's case: held 'working' (evaluatedAt 100_500, process A); a reset row 'revoked' with no evaluatedAt from process B,
  // whose clock (serverTime 100_200) is behind: the revocation still applies.
  reader = step(createReader<Data>(), answer([{ ...row('a', 1, 'working'), evaluatedAt: 100_500 }], done(1), { serverTime: 100_500 }));
  reader = step(reader, answer([row('a', 1, 'revoked')], done(2), { reset: true, serverTime: 100_200 }));
  assert.deepEqual(held(reader), [['a', 'revoked']]);
});

test('an explicit complete field ends an answer; complete:false at more:false does not prune', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1), row('b', 1)], done(1)));
  reader = step(restartReader(reader), answer([row('a', 1)], 'x', { complete: false }));
  assert.equal(reader.complete, false);
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'b']);
  reader = step(reader, answer([row('b', 1)], 'y', { complete: true }));
  assert.equal(reader.complete, true);
  assert.deepEqual(held(reader).map(([id]) => id), ['a', 'b']);
});

test('the answer-level pause follows the latest applied answer; a replay or notReady cannot bring an old one back', () => {
  let reader = step(createReader<Data>(), answer([row('a', 1)], done(1), { pause: null }));
  const before = reader.cursor;
  reader = step(reader, answer([], done(2), { pause: { revision: 1 } }));
  assert.deepEqual(reader.pause, { revision: 1 });
  assert.deepEqual(applyCurrentState(reader, before, answer([], done(2), { pause: null })).pause, { revision: 1 });
  assert.deepEqual(step(reader, answer([], done(2), { notReady: true, pause: null })).pause, { revision: 1 });
  reader = step(reader, answer([], done(3), { pause: null }));
  assert.equal(reader.pause, null);
});

test('a reset arriving while a first read is paged starts that replacement again from its own first page', () => {
  let reader = step(restartReader(step(createReader<Data>(), answer([row('a', 1), row('b', 2)], done(2)))),
    answer([row('a', 1)], first(4, 'a'), { more: true }));
  reader = step(reader, answer([row('b', 2)], first(5, 'b'), { more: true, reset: true }));
  reader = step(reader, answer([], done(5)));
  // Only b was listed by the reset's pages; a, listed only by the abandoned first read, goes.
  assert.deepEqual(held(reader).map(([id]) => id), ['b']);
});
