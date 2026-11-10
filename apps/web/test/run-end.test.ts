import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEndLine } from '../src/run-end';

const ended = (endReason: string | null) => ({ startedAt: 1, endedAt: 2, endReason });

test('a run stopped by the computer says why', () => {
  assert.match(runEndLine(ended('checkout_missing'))!, /folder isn’t a copy of the project’s repository/);
  assert.equal(runEndLine(ended('controller_failed')), 'Stopped after an error on your computer');
  assert.equal(runEndLine(ended(null)), 'Stopped (reason not reported)');
  assert.equal(runEndLine({ startedAt: 1, endedAt: null, endReason: null }), null);
});
