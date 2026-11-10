import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackgroundControlView } from '@mlswarm/contracts';
import { backgroundControlStatus } from '../src/ui/agent-running-state';
import { backgroundIconState } from '../src/ui/agent-status-icon';

const now = 1_000_000;
type Pending = NonNullable<BackgroundControlView['pending']>;
const view = (state: BackgroundControlView['state'], pending: BackgroundControlView['pending'] = null): BackgroundControlView => ({
  target: { site: 'http://127.0.0.1', ownerId: 'o', projectId: 'p'.repeat(64), agentId: 'a' }, missionId: 'm', generation: 1,
  state, pauseOperationId: state === 'paused' || state === 'pausing' ? 'op' : null,
  updatedAt: now, deviceLastSeenAt: now, available: true, pending,
});
const command = (kind: Pending['kind'], state: Pending['state']): Pending => ({ id: 'c', kind, state, approvedAt: now });

test('a Kill reads Killing and Killed; a stop without a Kill keeps Stopping and Stopped', () => {
  assert.equal(backgroundControlStatus(view('stopping', command('stop', 'accepted'))), 'Killing');
  assert.equal(backgroundControlStatus(view('stopped', command('stop', 'applied'))), 'Killed');
  // A closed project, a refused run, shutdown or repeated failures also end in stopped, with no Kill behind them.
  assert.equal(backgroundControlStatus(view('stopping')), 'Stopping');
  assert.equal(backgroundControlStatus(view('stopped')), 'Stopped');
  assert.equal(backgroundControlStatus(view('stopped', command('pause', 'applied'))), 'Stopped');
  // A Kill that failed or expired did not end it.
  assert.equal(backgroundControlStatus(view('stopped', command('stop', 'expired'))), 'Stopped');
  assert.equal(backgroundControlStatus(view('failed', command('stop', 'applied'))), 'Failed');
});

test('the row icon follows the state, so pausing and saved labels get the pausing icon', () => {
  assert.equal(backgroundControlStatus(view('pausing')), 'Pausing · finishing its turn');
  assert.equal(backgroundIconState(view('pausing')), 'pausing');
  assert.equal(backgroundControlStatus(view('running', command('pause', 'queued'))), 'Pause saved · waiting for your computer');
  assert.equal(backgroundIconState(view('running', command('pause', 'queued'))), 'pausing');
  assert.equal(backgroundIconState(view('running', command('stop', 'accepted'))), 'pausing');
  assert.equal(backgroundIconState(view('stopping', command('stop', 'accepted'))), 'stopped');
  assert.equal(backgroundIconState(view('stopped', command('stop', 'applied'))), 'stopped');
  assert.equal(backgroundIconState(view('paused', command('pause', 'applied'))), 'paused');
  assert.equal(backgroundIconState(view('running')), 'working');
  assert.equal(backgroundIconState(view('waiting')), 'idle');
  assert.equal(backgroundIconState(view('paused')), 'paused');
});

// A job has no time limit (owner decision, 10 November 2026): an end time stored before that decision changes nothing.
test('an old stored end time in the past leaves the status and icon as they are', () => {
  const old = (state: BackgroundControlView['state']) => ({ ...view(state), deadlineAt: now - 3_600_000 }) as BackgroundControlView;
  assert.equal(backgroundControlStatus(old('running')), 'Working');
  assert.equal(backgroundIconState(old('running')), 'working');
  assert.equal(backgroundControlStatus(old('paused')), 'Paused');
  assert.equal(backgroundIconState(old('paused')), 'paused');
});
