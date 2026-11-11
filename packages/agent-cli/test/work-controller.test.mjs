import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkController } from '../runtime/work-controller.mjs';

const news = (project = {}, extra = {}) => ({ project: { started: true, paused: false, closed: false, ...project }, pending: 0, acknowledged: 0, ...extra });
const controller = (options = {}) => createWorkController({ random: () => 0.5, now: () => 1000, ...options });
const turn = (work, observed, outcome = {}) => { work.beginTurn(observed); work.recordOutcome({ kind: 'ok', news: observed, now: 1000, ...outcome }); };

test('the first observation runs; closed and paused projects do not, and a job whose time is up waits', () => {
  assert.deepEqual(controller().decide({ news: news(), now: 1000 }), { action: 'run', reason: 'first' });
  assert.deepEqual(controller({ deadline: 1000 }).decide({ news: news(), now: 1000 }), { action: 'wait', reason: 'time_up', interrupt: false });
  assert.deepEqual(controller({ deadline: 1000 }).decide({ news: news({ closed: true }), now: 1000 }), { action: 'stop', reason: 'project_closed' });
  assert.deepEqual(controller().decide({ news: news({ closed: true }), now: 1000 }), { action: 'stop', reason: 'project_closed' });
  assert.equal(controller().decide({ news: news({ paused: true }), now: 1000 }).reason, 'paused');
  assert.equal(controller().decide({ news: news({ started: false }), now: 1000 }).reason, 'paused');
  assert.equal(controller().decide({ news: news(), paused: true, now: 1000 }).reason, 'paused');
  assert.equal(controller().decide({ news: { project: {} }, now: 1000 }).reason, 'unknown_contact');
});

test('an active turn and held deliveries wait, but an owner steer does not wait for delivery', () => {
  const work = controller();
  work.beginTurn(news());
  assert.equal(work.decide({ news: news(), now: 1000 }).reason, 'active');
  work.recordOutcome({ kind: 'ok', news: news(), now: 1000 });
  assert.equal(work.decide({ news: news(), pendingDeliveries: 1, now: 1000 }).reason, 'pending_delivery');
  assert.deepEqual(work.decide({ news: news(), pendingDeliveries: 1, steering: true, now: 1000 }), { action: 'run', reason: 'steering' });
});

test('a finished turn waits for a new observation, then runs only for new work', () => {
  const work = controller(), seen = news();
  turn(work, seen);
  assert.equal(work.decide({ news: seen, now: 1000 }).reason, 'fresh_observation');
  assert.equal(work.decide({ news: news(), now: 1000 }).reason, 'idle');
  assert.equal(work.decide({ news: news({ paused: false, revision: 2 }), now: 1000 }).reason, 'project_change');
  assert.equal(work.decide({ news: news({}, { pending: 1, acknowledged: 0 }), now: 1000 }).reason, 'inbox');
  assert.equal(work.decide({ news: news(), notices: 1, now: 1000 }).reason, 'notices');
});

test('WORK_NEXT runnable continues; an interrupted turn continues too', () => {
  const work = controller();
  turn(work, news(), { continuation: true });
  assert.equal(work.decide({ news: news(), now: 1000 }).reason, 'continuation');
  work.beginTurn(news());
  work.recordOutcome({ kind: 'interrupted' });
  assert.equal(work.decide({ news: news(), now: 1000 }).reason, 'continuation');
});

test('a durable runnable checkpoint runs once per revision', () => {
  const work = controller(), runnable = news({}, { work: { runnable: true, revision: 3 } });
  turn(work, news());
  assert.equal(work.decide({ news: runnable, now: 1000 }).reason, 'durable');
  turn(work, runnable);
  assert.equal(work.decide({ news: news({}, { work: { runnable: true, revision: 3 } }), now: 1000 }).reason, 'idle');
  assert.equal(work.decide({ news: news({}, { work: { runnable: true, revision: 4 } }), now: 1000 }).reason, 'durable');
});

test('failures back off exponentially and stop at the limit; a non-retryable failure stops at once', () => {
  const work = controller({ retryBaseMs: 100, maxFailures: 3 });
  work.beginTurn(news()); work.recordOutcome({ kind: 'failed', news: news(), now: 1000 });
  assert.deepEqual(work.decide({ news: news(), now: 1050 }), { action: 'wait', reason: 'retry_backoff', retryAt: 1100 });
  assert.deepEqual(work.decide({ news: news(), now: 1100 }), { action: 'run', reason: 'retry' });
  work.beginTurn(news()); work.recordOutcome({ kind: 'failed', news: news(), now: 2000 });
  assert.equal(work.decide({ news: news(), now: 2199 }).retryAt, 2200);
  work.beginTurn(news()); work.recordOutcome({ kind: 'failed', news: news(), now: 3000 });
  assert.deepEqual(work.decide({ news: news(), now: 9000 }), { action: 'stop', reason: 'failure_limit' });
  const fatal = controller();
  fatal.beginTurn(news()); fatal.recordOutcome({ kind: 'failed', retryable: false, news: news(), now: 1000 });
  assert.deepEqual(fatal.decide({ news: news(), now: 1000 }), { action: 'stop', reason: 'failure_limit' });
});

test('a turn that leaves its inbox unacknowledged counts as a failure until the limit', () => {
  const work = controller({ retryBaseMs: 100, maxFailures: 2 });
  for (const at of [1000, 2000]) {
    const unread = news({}, { pending: 2, acknowledged: 5 });
    work.beginTurn(unread); work.recordOutcome({ kind: 'ok', news: unread, now: at });
    const decision = work.decide({ news: news({}, { pending: 2, acknowledged: 5 }), now: at + 1000 });
    if (at === 2000) assert.deepEqual(decision, { action: 'stop', reason: 'unacknowledged_inbox' });
    else assert.deepEqual(decision, { action: 'wait', reason: 'retry_backoff', retryAt: 2100 });
  }
  const reader = controller();
  const unread = news({}, { pending: 2, acknowledged: 5 });
  reader.beginTurn(unread); reader.recordOutcome({ kind: 'ok', news: news({}, { pending: 0, acknowledged: 7 }), now: 1000 });
  assert.equal(reader.decide({ news: news({}, { pending: 0, acknowledged: 7 }), now: 1000 }).reason, 'idle');
});

test('project-only announcements wake a worker only with a project change, after a jittered delay', () => {
  const work = controller({ announcementJitterMs: 1000 });
  turn(work, news());
  // Broadcasts alone do not start a turn while the project state is unchanged.
  assert.equal(work.decide({ news: news({}, { pending: 1, project_only: true }), now: 1000 }).reason, 'idle');
  const changed = () => news({ revision: 1 }, { pending: 1, project_only: true });
  assert.deepEqual(work.decide({ news: changed(), now: 1000 }), { action: 'wait', reason: 'announcement_backoff', retryAt: 1500 });
  assert.deepEqual(work.decide({ news: changed(), now: 1500 }), { action: 'run', reason: 'inbox' });
  // A direct message is not delayed.
  assert.deepEqual(work.decide({ news: news({}, { pending: 1, project_only: false }), now: 1000 }), { action: 'run', reason: 'inbox' });
});


test('a provider limit is a wait, not a failure: a named reset time is kept, otherwise the wait doubles up to 15 minutes', () => {
  const work = controller({ retryBaseMs: 10_000, maxFailures: 3 });
  const limit = (now, resetAt = null) => { work.beginTurn(news()); work.recordOutcome({ kind: 'failed', providerLimited: true, resetAt, news: news(), now }); };
  limit(1000, 50_000);
  assert.deepEqual(work.decide({ news: news(), now: 49_999 }), { action: 'wait', reason: 'provider_limit', retryAt: 50_000 });
  assert.deepEqual(work.status().limited, { retryAt: 50_000, resetAt: 50_000, streak: 1 });
  // Ten limits in a row never stop the worker; without a reset time the wait grows to the 15-minute ceiling.
  let at = 50_000;
  for (let i = 0; i < 10; i++) { limit(at); at = work.status().retryAt; assert.equal(work.decide({ news: news(), now: at - 1 }).reason, 'provider_limit'); }
  assert.equal(work.status().failures, 0);
  assert.equal(work.status().limited.retryAt - work.status().limited.retryAt % 1, work.status().limited.retryAt, 'a whole millisecond');
  limit(at); assert.equal(work.status().retryAt - at, 15 * 60_000);
  assert.deepEqual(work.decide({ news: news(), now: at + 15 * 60_000 }), { action: 'run', reason: 'continuation' });
  // A reset time already past is not trusted: the growing wait applies.
  limit(at, at - 5); assert.equal(work.status().limited.resetAt, null);
  // A working turn clears the limit.
  turn(work, news(), { now: at + 20 * 60_000 }); assert.equal(work.status().limited, null);
});

test('provider limits between real failures do not reset their count, and a non-retryable limit still stops', () => {
  const work = controller({ retryBaseMs: 1, maxFailures: 3 });
  const fail = (extra = {}) => { work.beginTurn(news()); work.recordOutcome({ kind: 'failed', news: news(), now: 1000, ...extra }); };
  fail(); fail({ providerLimited: true }); fail();
  assert.equal(work.status().failures, 2);
  fail(); assert.deepEqual(work.decide({ news: news(), now: 99_999 }), { action: 'stop', reason: 'failure_limit' });
  const uncertain = controller();
  uncertain.beginTurn(news()); uncertain.recordOutcome({ kind: 'failed', providerLimited: true, retryable: false, news: news(), now: 1000 });
  assert.deepEqual(uncertain.decide({ news: news(), now: 1000 }), { action: 'stop', reason: 'failure_limit' });
});

test('a restored worker keeps its provider limit wait', () => {
  const work = controller({ first: false, seen: { fingerprint: null, handledRevision: -1, limitedUntil: 90_000, limitResetAt: 90_000, limitStreak: 2 } });
  assert.deepEqual(work.decide({ news: news(), now: 1000 }), { action: 'wait', reason: 'provider_limit', retryAt: 90_000 });
  assert.deepEqual(work.decide({ news: news(), now: 90_000 }), { action: 'run', reason: 'continuation' });
});

test('an extended deadline must increase and lets work continue', () => {
  const work = controller({ deadline: 2000 });
  assert.throws(() => work.setDeadline(2000), /increase/);
  work.setDeadline(5000); work.requestContinuation();
  assert.equal(work.decide({ news: news(), now: 3000 }).action, 'run');
});
