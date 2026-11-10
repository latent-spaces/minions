import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecution, validateOutcome } from '../src/service/contracts.mjs';

const outcome = extra => ({ delivery: 'acknowledged', failed: false, interrupted: false, retryable: false, cleanupConfirmed: true, ...extra });

test('execution must carry its own provider and model fields', () => {
  assert.deepEqual(validateExecution({ provider: 'claude', model: null }), { provider: 'claude', model: null });
  assert.throws(() => validateExecution({ provider: 'codex', model: 'gpt-5', untilProjectEnds: true }), /Invalid execution fields/);
  assert.throws(() => validateExecution(Object.create({ provider: 'claude', model: null })), /Invalid execution fields/);
  assert.throws(() => validateExecution({ provider: 'claude' }), /Invalid execution fields/);
  assert.throws(() => validateExecution({ provider: 'claude', model: null, extra: 1 }), /Invalid execution fields/);
  assert.throws(() => validateExecution([]), /Invalid execution fields/);
});

test('outcome status flags must be booleans', () => {
  assert.doesNotThrow(() => validateOutcome(outcome()));
  assert.doesNotThrow(() => validateOutcome(outcome({ textTruncated: true })));
  for (const key of ['failed', 'interrupted', 'retryable', 'cleanupConfirmed']) {
    assert.throws(() => validateOutcome(outcome({ [key]: undefined })), new RegExp(`Invalid ${key}`));
    assert.throws(() => validateOutcome(outcome({ [key]: 'false' })), new RegExp(`Invalid ${key}`));
  }
  assert.throws(() => validateOutcome(outcome({ textTruncated: 1 })), /Invalid textTruncated/);
});
