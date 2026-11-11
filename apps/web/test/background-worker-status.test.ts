import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackgroundControlView } from '@mlswarm/contracts';
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
