import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectWorkersView } from '@mlswarm/contracts';
import { jobTokensUsed, parseTokenCap, tidyTokenCap } from '../src/ui/job-limits';

// Synthetic sessions only: no server, computer or model.
const agent = (session: Record<string, unknown> | null) => ({ agentId: 'a', agentName: 'a', worker: { available: true, session } }) as unknown as ProjectWorkersView['agents'][number];
const tokens = (counted: number, othersUsed?: number) => agent({ tokens: { counted, unknownTurns: 0 }, ...(othersUsed === undefined ? {} : { tokenLimit: { tokens: 1000, othersUsed } }) });

test('the job total is the largest pool report, or the sum of current missions when that is larger', () => {
  assert.equal(jobTokensUsed([]), 0);
  assert.equal(jobTokensUsed([agent(null), agent({})]), 0);
  // Without a cap only the current missions are known.
  assert.equal(jobTokensUsed([tokens(100), tokens(250)]), 350);
  // With a cap each agent's last reply carried what the pool counted outside its mission, ended missions included.
  assert.equal(jobTokensUsed([tokens(100, 900), tokens(250, 700)]), 1000);
  // An older report never lowers the total below what the current missions add up to.
  assert.equal(jobTokensUsed([tokens(600, 0), tokens(500, 0)]), 1100);
});

test('the cap editor takes a whole number of tokens, with separators, and names every other input plainly', () => {
  assert.deepEqual(parseTokenCap('2,000,000'), { tokens: 2_000_000, error: null });
  assert.deepEqual(parseTokenCap(' 1 500 '), { tokens: 1500, error: null });
  assert.equal(parseTokenCap('').error, 'Enter the number of tokens.');
  assert.equal(parseTokenCap('1.5').error, 'Use whole numbers only, like 2,000,000.');
  assert.equal(parseTokenCap('-3').error, 'Use whole numbers only, like 2,000,000.');
  assert.equal(parseTokenCap('2k').error, 'Use whole numbers only, like 2,000,000.');
  assert.equal(parseTokenCap('0').error, 'The cap must be at least 1 token.');
  assert.equal(parseTokenCap('99999999999999999').error, 'That number is too large.');
  assert.equal(tidyTokenCap('2000000'), '2,000,000');
  assert.equal(tidyTokenCap('2k'), '2k');
});

