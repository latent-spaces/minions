// Pure counting and scheduling checks for the job's token cap. No provider, model or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countedTokens, tokenCapReached, validTokenLimit } from '../src/service/token-cap.mjs';
import { createWorkController } from '../runtime/work-controller.mjs';

const turn = (usage, delivery = 'acknowledged') => ({ outcome: { delivery, failed: false, interrupted: false, retryable: false, cleanupConfirmed: true, ...(usage === undefined ? {} : { usage }) } });
const claude = tokens => ({ provider: 'claude', inputSemantics: 'uncached', tokens });
const codex = tokens => ({ provider: 'codex', inputSemantics: 'includes-cache', tokens });

test('Claude counts input + cache writes + output; cache reads do not count', () => {
  assert.deepEqual(countedTokens([turn(claude({ input: 100, output: 20, cacheRead: 50000, cacheWrite: 300, modelCalls: null }))]), { counted: 420, unknownTurns: 0 });
});

test('Codex input includes cached input, so the count is (input - cacheRead) + cacheWrite + output', () => {
  assert.deepEqual(countedTokens([turn(codex({ input: 1000, output: 100, cacheRead: 600, cacheWrite: 7, modelCalls: null }))]), { counted: 507, unknownTurns: 0 });
  // A missing or impossible cache count takes nothing out, so the count errs high.
  assert.equal(countedTokens([turn(codex({ input: 1000, output: 100, cacheRead: null, cacheWrite: null, modelCalls: null }))]).counted, 1100);
  assert.equal(countedTokens([turn(codex({ input: 100, output: 1, cacheRead: 900, cacheWrite: 0, modelCalls: null }))]).counted, 101);
});

test('a turn with no reported usage is unknown, never 0; a turn that never reached the model is skipped', () => {
  const known = turn(claude({ input: 10, output: 3, cacheRead: 0, cacheWrite: 0, modelCalls: null }));
  assert.deepEqual(countedTokens([known, turn(undefined), turn(claude(null)), turn(claude({ input: 10, output: null, cacheRead: 0, cacheWrite: 0, modelCalls: null })), turn(undefined, 'not_submitted'), known]),
    { counted: 26, unknownTurns: 3 });
  assert.deepEqual(countedTokens([]), { counted: 0, unknownTurns: 0 });
});

test('the cap is reached at its amount, counting what the pool counted outside this mission', () => {
  assert.equal(tokenCapReached({ counted: 10_000_000, unknownTurns: 0 }, null), false, 'no cap');
  assert.equal(tokenCapReached({ counted: 999, unknownTurns: 0 }, { tokens: 1000, othersUsed: 0 }), false);
  assert.equal(tokenCapReached({ counted: 1000, unknownTurns: 0 }, { tokens: 1000, othersUsed: 0 }), true);
  assert.equal(tokenCapReached({ counted: 299, unknownTurns: 0 }, { tokens: 1000, othersUsed: 700 }), false);
  assert.equal(tokenCapReached({ counted: 400, unknownTurns: 0 }, { tokens: 1000, othersUsed: 600 }), true);
  for (const bad of [undefined, {}, { tokens: 0, othersUsed: 0 }, { tokens: 5 }, { tokens: 5, othersUsed: -1 }, { tokens: 5, othersUsed: Number.MAX_SAFE_INTEGER + 2 }, [], { othersUsed: 0, extra: 1 }])
    assert.equal(validTokenLimit(bad), false);
  assert.equal(validTokenLimit(null), true);
  assert.equal(validTokenLimit({ tokens: 5, othersUsed: 0 }), true);
  // A field a later server adds is ignored; the known fields are still checked.
  assert.equal(validTokenLimit({ tokens: 5, othersUsed: 0, extra: 1 }), true);
  assert.equal(validTokenLimit({ tokens: 5, othersUsed: Number.MAX_SAFE_INTEGER }), true);
});

test('the scheduler waits at the cap between turns and runs as before without one', () => {
  const news = { project: { started: true, paused: false }, pending: 0, acknowledged: 0 };
  const scheduler = createWorkController({});
  assert.deepEqual(scheduler.decide({ news, tokenCap: true }), { action: 'wait', reason: 'token_cap', interrupt: false });
  assert.deepEqual(scheduler.decide({ news }), { action: 'run', reason: 'first' });
});
