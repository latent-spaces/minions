import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTurnOutcome, providerLimitResetAt } from '../src/native-worker-adapter.mjs';

const claudeError = (result, extra = {}) => ({ provider: 'claude', delivery: 'acknowledged', closed: true,
  report: { is_error: true, subtype: 'success', num_turns: 1, result, errors: [] }, ...extra });

test('provider usage limits, 429 and 529 are temporary: the worker waits and tries again', () => {
  for (const result of ['Claude AI usage limit reached|1792960000', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']) {
    const outcome = modelTurnOutcome({ stream: claudeError(result), exitCode: 1 });
    assert.equal(outcome.failureCode, 'provider_limited', result);
    assert.equal(outcome.retryable, true, result);
  }
  // Claude refuses before any model turn: the prompt stays submitted, yet nothing ran.
  const refused = modelTurnOutcome({ stream: claudeError('API Error: 429 rate_limit_error', { delivery: 'submitted', report: { is_error: true, num_turns: 0, result: 'API Error: 429 rate_limit_error', errors: [] } }), exitCode: 1 });
  assert.deepEqual([refused.failureCode, refused.retryable], ['provider_limited', true]);
  const codex = modelTurnOutcome({ stream: { provider: 'codex', delivery: 'acknowledged', closed: true, failure: { code: 'native_turn_failed', phase: 'turn' },
    report: { is_error: true, result: '', errors: ["You've hit your usage limit. Try again later."] } }, exitCode: 0 });
  assert.deepEqual([codex.failureCode, codex.retryable], ['provider_limited', true]);
});

test('real authentication errors stay permanent and local protocol failures keep their code', () => {
  const auth = modelTurnOutcome({ stream: claudeError('Invalid API key · Please run /login'), exitCode: 1 });
  assert.deepEqual([auth.failureCode, auth.retryable], ['authentication_required', false]);
  const local = modelTurnOutcome({ stream: { delivery: 'acknowledged', closed: true, failure: { code: 'native_protocol_error' },
    report: { is_error: true, result: '', errors: ['frame 429 malformed'] } }, exitCode: 1 });
  assert.deepEqual([local.failureCode, local.retryable], ['native_protocol_error', false]);
});

test('the model\'s own final text is not classified as a terminal error', () => {
  // A non-error report whose process still exited non-zero: only stderr and error fields count.
  const outcome = modelTurnOutcome({ stream: { provider: 'claude', delivery: 'acknowledged', closed: false,
    report: { is_error: false, result: 'Fixed the unauthorized 429 handler; permission denied paths now log in.', errors: [] } }, exitCode: 1 });
  assert.equal(outcome.failed, true);
  assert.equal(outcome.failureCode, 'local_execution_failure');
  assert.equal(outcome.retryable, true);
});

test('a failed Codex turn classifies its terminal error, not the final prose copied into result', () => {
  const outcome = modelTurnOutcome({ stream: { provider: 'codex', delivery: 'acknowledged', closed: true, failure: { code: 'native_turn_failed', phase: 'turn' },
    report: { is_error: true, result: 'The EPERM was permission denied; the unauthorized path needs login.', errors: ['stream disconnected: connection reset'] } }, exitCode: 0 });
  assert.deepEqual([outcome.failureCode, outcome.retryable], ['native_turn_failed', true]);
});

test('a 429 seen only on stderr keeps an uncertain submission from being retried', () => {
  const outcome = modelTurnOutcome({ stream: { provider: 'claude', delivery: 'submitted', closed: false, report: null }, stderr: 'HTTP 429 Too Many Requests', exitCode: 1 });
  assert.deepEqual([outcome.failureCode, outcome.retryable], ['provider_limited', false]);
});

// None of these shapes comes from a recorded native run: Claude Code's "usage limit reached|<epoch>" and the duration and
// Retry-After wordings are assumed from the providers' public messages.
test('the reset time of a provider limit is read when the error names one, and only a near future time is trusted', () => {
  const now = 1_792_960_000_000;
  assert.equal(providerLimitResetAt('Claude AI usage limit reached|1792963600', now), 1_792_963_600_000);
  assert.equal(providerLimitResetAt("You've hit your usage limit. Try again in 2 hours 5 minutes.", now), now + 7_500_000);
  assert.equal(providerLimitResetAt('try again in 1 day, 3h and 20m', now), now + 86_400_000 + 3 * 3_600_000 + 20 * 60_000);
  assert.equal(providerLimitResetAt('HTTP 429 Too Many Requests retry-after: 30', now), now + 30_000);
  for (const text of ['API Error: 429 rate_limit_error', 'Claude AI usage limit reached|1700000000', 'try again in 9 days', 'Try again later.'])
    assert.equal(providerLimitResetAt(text, now), null, text);
  const outcome = modelTurnOutcome({ stream: claudeError('Claude AI usage limit reached|1792963600'), exitCode: 1, now });
  assert.deepEqual([outcome.failureCode, outcome.limitResetAt], ['provider_limited', 1_792_963_600_000]);
  assert.equal(Object.hasOwn(modelTurnOutcome({ stream: claudeError('API Error: 529 overloaded_error'), exitCode: 1, now }), 'limitResetAt'), false);
  // Codex: the same wording in a terminal error field.
  const codex = modelTurnOutcome({ stream: { provider: 'codex', delivery: 'acknowledged', closed: true, failure: { code: 'native_turn_failed', phase: 'turn' },
    report: { is_error: true, result: '', errors: ["You've hit your usage limit. Try again in 45 minutes."] } }, exitCode: 0, now });
  assert.deepEqual([codex.failureCode, codex.limitResetAt], ['provider_limited', now + 45 * 60_000]);
});
