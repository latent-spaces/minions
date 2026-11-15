import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentObservation } from '@minions/contracts';
import { atTokenCap, PAST_END, providerLimitText, TIME_AND_TOKEN_CAP, TOKEN_CAP, tokenUsageNote, waitingTitle, workerAgentStatus } from '../src/ui/agent-running-state';
import { agentIconState } from '../src/ui/agent-status-icon';

// One agent's two observations of the same mission: the computer's background snapshot (owner tick) and the worker's
// own session (turn end and every 20 s). Activity comes from whichever was asserted last.
const now = 1_000_000, mission = 'm1';
const agent = (b: Partial<NonNullable<AgentObservation['backgroundControl']>>, s: Partial<NonNullable<AgentObservation['worker']['session']>>) => ({
  agentId: 'a', agentName: 'a',
  backgroundControl: { missionId: mission, state: 'running', deadlineAt: now + 600_000, deviceLastSeenAt: now - 40_000, ...b },
  worker: { session: { missionId: mission, generation: 1, phase: 'working', deadlineAt: now + 600_000, lastContactAt: now - 5_000, ...s } },
}) as unknown as AgentObservation;

test('a newer worker session shows the agent idle while the older snapshot still says running', () => {
  assert.equal(workerAgentStatus(agent({ state: 'running' }, { phase: 'waiting' }), now).label, 'Idle');
  assert.equal(workerAgentStatus(agent({ state: 'waiting' }, { phase: 'working' }), now).label, 'Working');
  assert.equal(workerAgentStatus(agent({ state: 'running' }, { phase: 'blocked' }), now).label, 'Blocked');
});

test('the newer session also carries the time it confirmed after added time', () => {
  const status = workerAgentStatus(agent({ deadlineAt: now + 60_000 }, { deadlineAt: now + 1_860_000 }), now);
  assert.equal(status.timeLeft, 1_860_000);
});

test('an older or different-mission session leaves the snapshot in charge', () => {
  assert.equal(workerAgentStatus(agent({ state: 'running', deviceLastSeenAt: now - 1_000 }, { phase: 'waiting', lastContactAt: now - 5_000 }), now).label, 'Working');
  assert.equal(workerAgentStatus(agent({ state: 'running' }, { missionId: 'other', phase: 'waiting' }), now).label, 'Unknown');
});

test('pause, stop and recovery stay with the computer even when the session is newer', () => {
  assert.equal(workerAgentStatus(agent({ state: 'paused' }, { phase: 'working' }), now).label, 'Paused');
  assert.equal(workerAgentStatus(agent({ state: 'stopped' }, { phase: 'working' }), now).label, 'Stopped');
  assert.equal(workerAgentStatus(agent({ state: 'stopping' }, { phase: 'working' }), now).label, 'Stopping');
  assert.equal(workerAgentStatus(agent({ state: 'recovery_required' }, { phase: 'working' }), now).label, 'Recovery');
});

test('a session from the future is not trusted for activity', () => {
  assert.equal(workerAgentStatus(agent({ state: 'running' }, { phase: 'waiting', lastContactAt: now + 1_000 }), now).label, 'Working');
});

test('a session heard within 90 s shows its activity even when the computer snapshot is older, as on the map', () => {
  assert.equal(workerAgentStatus(agent({ state: 'running', deviceLastSeenAt: now - 90_000 }, { phase: 'waiting', lastContactAt: now }), now).label, 'Idle');
  assert.equal(workerAgentStatus(agent({ state: 'waiting', deviceLastSeenAt: now - 120_000 }, { phase: 'working', lastContactAt: now - 1_000 }), now).label, 'Working');
});

test('Offline only when neither the computer nor the session was heard within 90 s', () => {
  assert.equal(workerAgentStatus(agent({ state: 'running', deviceLastSeenAt: now - 120_000 }, { phase: 'working', lastContactAt: now - 90_000 }), now).label, 'Offline');
  assert.equal(workerAgentStatus(agent({ state: 'paused', deviceLastSeenAt: now - 120_000 }, { phase: 'working', lastContactAt: now }), now).label, 'Offline');
});

// Owner decision, 9 November 2026: at the job's end time an agent is not ended. It finishes its turn, then waits.
test('past the end time an agent is shown finishing its turn, then waiting for more time, never stopping', () => {
  const past = { deadlineAt: now - 1 };
  const finishing = { label: 'Working', title: 'Past the end time, finishing its turn', timeLeft: null, pastEnd: true };
  const waiting = { label: 'Waiting', title: 'Time is up. Waiting for more time', timeLeft: null, pastEnd: true };
  // The session is the newer observation.
  assert.deepEqual(workerAgentStatus(agent(past, { ...past, phase: 'working' }), now), finishing);
  for (const phase of ['waiting', 'blocked'] as const) assert.deepEqual(workerAgentStatus(agent(past, { ...past, phase }), now), waiting);
  // Only the computer's snapshot is fresh.
  const snapshot = { ...past, deviceLastSeenAt: now - 1_000 }, old = { ...past, lastContactAt: now - 5_000 };
  assert.deepEqual(workerAgentStatus(agent({ ...snapshot, state: 'running' }, old), now), finishing);
  for (const state of ['waiting', 'paused'] as const) assert.deepEqual(workerAgentStatus(agent({ ...snapshot, state }, old), now), waiting);
  // No computer snapshot at all.
  const alone = (phase: string) => ({ ...agent({}, { ...past, phase: phase as never }), backgroundControl: null }) as AgentObservation;
  assert.deepEqual(workerAgentStatus(alone('working'), now), finishing);
  assert.deepEqual(workerAgentStatus(alone('waiting'), now), waiting);
  // Ended work stays ended, and an agent nobody hears from is still Offline.
  assert.equal(workerAgentStatus(agent({ ...past, state: 'stopped' }, past), now).label, 'Stopped');
  assert.equal(workerAgentStatus(alone('stopped'), now).label, 'Stopped');
  assert.equal(workerAgentStatus(agent({ ...past, deviceLastSeenAt: now - 120_000 }, { ...past, lastContactAt: now - 120_000 }), now).label, 'Offline');
});

// Owner decision, 9 November 2026: Pause lets the turn finish, however long it takes.
test('a Pause waits for the current turn; a project Pause is unconfirmed only when the worker is out of contact or between turns', () => {
  assert.deepEqual(workerAgentStatus(agent({ state: 'pausing' }, {}), now), { label: 'Pausing', title: 'Finishing its current turn, then it pauses.', timeLeft: 600_000 });
  const paused = (s: Parameters<typeof agent>[1], requestedAt = now - 60_000) => ({ ...agent({}, s), projectPause: { revision: 1, requestedAt, confirmedAt: null, externalChat: false } }) as AgentObservation;
  assert.deepEqual(workerAgentStatus(paused({ phase: 'working' }), now), { label: 'Pausing', title: 'Project Pause requested. Finishing its current turn, then it pauses.', timeLeft: 600_000 });
  assert.equal(workerAgentStatus(paused({ phase: 'working', lastContactAt: now - 90_000 }), now).label, 'Pause unconfirmed');
  assert.equal(workerAgentStatus(paused({ phase: 'waiting' }), now).label, 'Pause unconfirmed');
  assert.equal(workerAgentStatus(paused({ phase: 'waiting' }, now - 1_000), now).label, 'Pausing');
});

test('once time is added the worker reports the new end and shows the time left again', () => {
  const status = workerAgentStatus(agent({ deadlineAt: now - 1 }, { phase: 'working', deadlineAt: now + 1_800_000 }), now);
  assert.deepEqual(status, { label: 'Working', title: 'Working on its own.', timeLeft: 1_800_000 });
});

test('a queued start that only lacks job time says it waits for more time', () => {
  assert.equal(waitingTitle('time'), 'Waiting for more time.');
  const queued = { ...agent({}, {}), backgroundControl: null, worker: { session: null }, run: { state: 'pending', waitingFor: 'time' } } as unknown as AgentObservation;
  assert.deepEqual(workerAgentStatus(queued, now), { label: 'Waiting', title: 'Waiting for more time.', timeLeft: null });
});

test('a worker waiting at the token cap says why it waits and how many tokens it used of how many', () => {
  const capped = { phase: 'waiting' as const, tokens: { counted: 52_340, unknownTurns: 0 }, tokenLimit: { tokens: 50_000, othersUsed: 0 } };
  const status = workerAgentStatus(agent({ state: 'running' }, capped), now);
  assert.equal(status.label, 'Waiting');
  assert.equal(status.title, `${TOKEN_CAP}. Used 52,340 of 50,000 tokens for this job. Raise the cap to continue.`);
  assert.equal(agentIconState(TOKEN_CAP), 'waiting');
  // Under the cap it is idle as before, and the note still says how much it used.
  const under = { ...capped, tokens: { counted: 1_200, unknownTurns: 2 } };
  assert.equal(workerAgentStatus(agent({ state: 'running' }, under), now).label, 'Idle');
  assert.equal(tokenUsageNote(under), 'Used 1,200 of 50,000 tokens for this job. 2 turns reported no usage and are not counted.');
  // The cap is one pool: what it counted outside this mission counts too.
  const pool = { tokens: { counted: 400, unknownTurns: 0 }, tokenLimit: { tokens: 1_000, othersUsed: 600 } };
  assert.equal(atTokenCap(pool), true);
  assert.equal(tokenUsageNote(pool), 'Used 1,000 of 1,000 tokens for this job.');
  // No cap: unchanged, and no token note.
  assert.equal(workerAgentStatus(agent({ state: 'running' }, { phase: 'waiting', tokens: { counted: 9_000_000, unknownTurns: 0 }, tokenLimit: null }), now).label, 'Idle');
  assert.equal(tokenUsageNote({ tokens: { counted: 9_000_000, unknownTurns: 0 }, tokenLimit: null }), null);
  // Past the end time and at the cap, it names both reasons; past the end time alone, only the time.
  const late = workerAgentStatus(agent({ state: 'running' }, { ...capped, deadlineAt: now - 1 }), now);
  assert.equal(late.pastEnd, true);
  assert.equal(late.title, TIME_AND_TOKEN_CAP);
  assert.equal(agentIconState(TIME_AND_TOKEN_CAP), 'waiting');
  assert.equal(workerAgentStatus(agent({ state: 'running' }, { ...under, deadlineAt: now - 1 }), now).title, PAST_END.waiting);
});

test('a worker held by a provider limit says so, with the time it tries again when the provider named one', () => {
  const at = new Date(2026, 10, 10, 14, 5).getTime();
  assert.equal(providerLimitText({ providerLimit: { retryAt: at } }), 'Provider limit reached. Trying again at 14:05');
  assert.equal(providerLimitText({ providerLimit: { retryAt: null } }), 'Provider limit reached. Trying again');
  assert.equal(providerLimitText({}), null);
  const status = workerAgentStatus(agent({ state: 'running' }, { phase: 'waiting', providerLimit: { retryAt: at } }), now);
  assert.deepEqual([status.label, status.title], ['Waiting', 'Provider limit reached. Trying again at 14:05.']);
  // Working again: the limit no longer shows.
  assert.equal(workerAgentStatus(agent({ state: 'running' }, { phase: 'working', providerLimit: { retryAt: at } }), now).label, 'Working');
});
