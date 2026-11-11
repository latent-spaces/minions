import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentObservation, BackgroundControlView } from '@mlswarm/contracts';
import { backgroundControlStatus } from '../src/ui/agent-running-state';
import { backgroundIconState } from '../src/ui/agent-status-icon';

const now = 1_000_000;
type Pending = NonNullable<BackgroundControlView['pending']>;
const view = (state: BackgroundControlView['state'], pending: BackgroundControlView['pending'] = null): BackgroundControlView => ({
  target: { site: 'http://127.0.0.1', ownerId: 'o', projectId: 'p'.repeat(64), agentId: 'a' }, missionId: 'm', generation: 1,
  deadlineAt: now + 3_600_000, state, pauseOperationId: state === 'paused' || state === 'pausing' ? 'op' : null,
  updatedAt: now, deviceLastSeenAt: now, available: true, pending,
});
const command = (kind: Pending['kind'], state: Pending['state']): Pending => ({ id: 'c', kind, state, approvedAt: now });

test('a Kill reads Killing and Killed; a stop without a Kill keeps Stopping and Stopped', () => {
  assert.equal(backgroundControlStatus(view('stopping', command('stop', 'accepted')), now), 'Killing');
  assert.equal(backgroundControlStatus(view('stopped', command('stop', 'applied')), now), 'Killed');
  // A closed project, a refused run, shutdown or repeated failures also end in stopped, with no Kill behind them.
  assert.equal(backgroundControlStatus(view('stopping'), now), 'Stopping');
  assert.equal(backgroundControlStatus(view('stopped'), now), 'Stopped');
  assert.equal(backgroundControlStatus(view('stopped', command('pause', 'applied')), now), 'Stopped');
  // A Kill that failed or expired did not end it.
  assert.equal(backgroundControlStatus(view('stopped', command('stop', 'expired')), now), 'Stopped');
  assert.equal(backgroundControlStatus(view('failed', command('stop', 'applied')), now), 'Failed');
});

test('the row icon follows the state, so pausing and saved labels get the pausing icon', () => {
  assert.equal(backgroundControlStatus(view('pausing'), now), 'Pausing · finishing its turn');
  assert.equal(backgroundIconState(view('pausing'), now), 'pausing');
  assert.equal(backgroundControlStatus(view('running', command('pause', 'queued')), now), 'Pause saved · waiting for your computer');
  assert.equal(backgroundIconState(view('running', command('pause', 'queued')), now), 'pausing');
  assert.equal(backgroundIconState(view('running', command('stop', 'accepted')), now), 'pausing');
  assert.equal(backgroundIconState(view('stopping', command('stop', 'accepted')), now), 'stopped');
  assert.equal(backgroundIconState(view('stopped', command('stop', 'applied')), now), 'stopped');
  assert.equal(backgroundIconState(view('paused', command('pause', 'applied')), now), 'paused');
  assert.equal(backgroundIconState(view('running'), now), 'working');
  assert.equal(backgroundIconState(view('waiting'), now), 'idle');
  assert.equal(backgroundIconState({ ...view('running'), deadlineAt: now }, now), 'working');
  assert.equal(backgroundIconState({ ...view('paused'), deadlineAt: now }, now), 'waiting');
});

test('saved activity expires at 90 seconds, even when the deadline has passed', () => {
  for (const state of ['running', 'waiting', 'blocked', 'paused', 'accepted', 'starting'] as const) {
    const stale = { ...view(state), deviceLastSeenAt: now - 90_000 };
    assert.equal(backgroundControlStatus(stale, now), 'Offline');
    assert.equal(backgroundIconState(stale, now), 'offline');
    assert.equal(backgroundControlStatus({ ...stale, deadlineAt: now - 1 }, now), 'Offline');
    assert.equal(backgroundIconState({ ...stale, deadlineAt: now - 1 }, now), 'offline');
  }
  assert.equal(backgroundControlStatus({ ...view('running'), deviceLastSeenAt: now - 89_999 }, now), 'Working');
  assert.equal(backgroundControlStatus({ ...view('running'), deviceLastSeenAt: now + 1 }, now), 'Unknown');
  assert.equal(backgroundIconState({ ...view('running'), deviceLastSeenAt: now + 1 }, now), 'unknown');
  // No process cleanup or terminal state is inferred from losing contact.
  assert.equal(backgroundControlStatus({ ...view('stopped'), deviceLastSeenAt: 0 }, now), 'Stopped');
  assert.equal(backgroundControlStatus({ ...view('recovery_required'), deviceLastSeenAt: 0 }, now), 'Needs a fix on your computer');
});

test('a newer fresh session of the same mission supplies activity; other sessions never revive stale work', () => {
  const session = (extra: Partial<NonNullable<AgentObservation['worker']['session']>> = {}) => ({ missionId: 'm', generation: 1,
    phase: 'working' as const, deadlineAt: now + 600_000, lastContactAt: now, ...extra });
  const stale = { ...view('running'), deviceLastSeenAt: now - 120_000 };
  assert.equal(backgroundControlStatus(stale, now, session()), 'Working');
  assert.equal(backgroundIconState(stale, now, session()), 'working');
  assert.equal(backgroundControlStatus(stale, now, session({ phase: 'waiting' })), 'Idle');
  assert.equal(backgroundIconState(stale, now, session({ phase: 'waiting' })), 'idle');
  assert.equal(backgroundControlStatus(stale, now, session({ phase: 'blocked' })), 'Blocked');
  assert.equal(backgroundControlStatus(stale, now, session({ deadlineAt: now - 1 })), 'Past the end time, finishing its turn');
  for (const other of [session({ missionId: 'another' }), session({ lastContactAt: now - 90_000 }), session({ lastContactAt: now + 1 })]) {
    assert.equal(backgroundControlStatus(stale, now, other), 'Offline');
    assert.equal(backgroundIconState(stale, now, other), 'offline');
  }
  // Control/cleanup states keep precedence over newer activity, just as on the agent page.
  assert.equal(backgroundControlStatus({ ...view('paused'), deviceLastSeenAt: now - 1 }, now, session()), 'Paused');
  assert.equal(backgroundControlStatus({ ...view('stopping'), deviceLastSeenAt: 0 }, now, session()), 'Stopping');
});
