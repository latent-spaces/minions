import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommunicationAgent } from '@minions/contracts';
import { ApiError } from '../src/authorized-request';
import type { CurrentStateAnswer } from '../src/ui/communication-map/current-state-reader';
import { CURRENT_STATE_CONTINUE_MS, CURRENT_STATE_FAST_POLL_MS, CURRENT_STATE_POLL_MS, accessRefused, createCurrentStateMap,
  currentStateRound, type CurrentStateMap } from '../src/ui/communication-map/current-state-source';

type Answer = CurrentStateAnswer<CommunicationAgent>;
const R = (s: number) => `${String(s).padStart(12, '0')}.000000000`;
const agent = (id: string, at: number, state: CommunicationAgent['state'] = 'idle', extra: Partial<CommunicationAgent> = {}) =>
  ({ id, rev: R(at), evaluatedAt: at, name: id, mine: false, state, focus: null, reportedAt: null, lastContactAt: null, freshUntil: null, ...extra });
const answer = (rows: Answer['rows'], cursor: string, extra: Partial<Answer> = {}): Answer =>
  ({ rows, cursor, more: false, notReady: false, complete: !extra.more && !extra.notReady, pause: null, needsYou: [],
    needsYouComplete: true, serverTime: 1000, ...extra });
/** A server that answers from a script, recording the paths it was asked. */
function server(script: (Answer | Error)[]) {
  const asked: string[] = [];
  return { asked, read: async (path: string) => { asked.push(path); const next = script.shift(); if (!next) throw new Error('unscripted'); if (next instanceof Error) throw next; return next; } };
}
const states = (round: { observations: { agents: CommunicationAgent[] } | null }) => round.observations?.agents.map(a => [a.id, a.state]);

test('a first read pages at once, then shows the agents with Needs you applied', async () => {
  const s = server([
    answer([agent('a', 1, 'working'), agent('b', 2)], 's.x.b', { more: true }),
    answer([agent('c', 3, 'revoked'), agent('d', 4, 'working', { projectPause: { revision: 1, requestedAt: 1, confirmedAt: null, externalChat: false } })], 'P.~',
      { needsYou: ['b', 'c', 'd'] }),
  ]);
  const round = await currentStateRound(createCurrentStateMap(), s.read, false);
  assert.deepEqual(s.asked, ['/communication/agents/current', '/communication/agents/current?cursor=s.x.b']);
  assert.deepEqual([round.served, round.nextMs], ['current', CURRENT_STATE_POLL_MS]);
  // Needs you never over a revocation or a project pause; rev/evaluatedAt are not map fields.
  assert.deepEqual(states(round), [['a', 'working'], ['b', 'needs_you'], ['c', 'revoked'], ['d', 'working']]);
  assert.equal('rev' in round.observations!.agents[0]!, false);
  assert.equal(round.observations!.serverTime, 1000);
});

test('until a first read completes the map shows no states (never an empty complete one): notReady and page budget', async () => {
  let round = await currentStateRound(createCurrentStateMap(), server([answer([], 's.x.a', { more: true, notReady: true })]).read, false);
  assert.deepEqual([round.observations, round.served, round.nextMs, round.state.ready], [null, 'pending', CURRENT_STATE_FAST_POLL_MS, false]);
  const endless = Array.from({ length: 30 }, (_, i) => answer([agent(`a${i}`, 1)], `s.x.a${i}`, { more: true }));
  round = await currentStateRound(createCurrentStateMap(), server(endless).read, false);
  assert.deepEqual([round.observations, round.served, round.nextMs], [null, 'pending', CURRENT_STATE_CONTINUE_MS]);
});

test('any failure other than a refused cursor reaches the caller; 401/403/404 are access refusals, 5xx and network are not', async () => {
  const held = (await currentStateRound(createCurrentStateMap(), server([answer([agent('a', 1, 'working')], 'P1.~')]).read, false)).state;
  for (const failure of [new ApiError(404, 'Not found.'), new ApiError(503, 'Unavailable.'), new TypeError('fetch failed')])
    await assert.rejects(currentStateRound(held, server([failure]).read, false), failure);
  assert.deepEqual([401, 403, 404, 500, 503].map(status => accessRefused(new ApiError(status, 'x'))), [true, true, true, false, false]);
  assert.equal(accessRefused(new TypeError('fetch failed')), false);
});

test('once ready, deltas update the map; notReady keeps what it shows and asks again soon', async () => {
  let state: CurrentStateMap = createCurrentStateMap();
  let round = await currentStateRound(state, server([answer([agent('a', 1, 'working')], 'P1.~')]).read, false);
  state = round.state;
  round = await currentStateRound(state, server([answer([agent('a', 1, 'offline', { evaluatedAt: 2 } as Partial<CommunicationAgent>)], 'P2.~')]).read, true);
  assert.deepEqual(states(round), [['a', 'offline']]);
  assert.equal(round.nextMs, CURRENT_STATE_FAST_POLL_MS);
  state = round.state;
  assert.equal(round.served, 'current');
  round = await currentStateRound(state, server([answer([], 'P2.~', { notReady: true })]).read, false);
  assert.deepEqual([round.nextMs, round.served], [CURRENT_STATE_FAST_POLL_MS, 'held']);
  assert.deepEqual(states(round), [['a', 'offline']]);
});

test('a refused cursor (400: another project or an older format) starts a first read and keeps the rows until it completes', async () => {
  let state = (await currentStateRound(createCurrentStateMap(), server([answer([agent('a', 1), agent('b', 1)], 'P1.~')]).read, false)).state;
  const s = server([new ApiError(400, 'Use a cursor this status read returned.'), answer([agent('a', 1)], 'P5.~')]);
  const round = await currentStateRound(state, s.read, false);
  assert.deepEqual(s.asked, ['/communication/agents/current?cursor=P1.~', '/communication/agents/current']);
  assert.deepEqual(states(round), [['a', 'idle']]);
  state = round.state;
  assert.equal(state.ready, true);
  // A 400 on a first read is not retried (no loop): it reaches the caller as an error.
  await assert.rejects(currentStateRound(createCurrentStateMap(), server([new ApiError(400, 'bad')]).read, false));
});
