import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerMatches } from '../runtime/project-operations.mjs';

test('the local MCP bridge accepts only its exact bearer secret', () => {
  const secret = 'a'.repeat(64);
  assert.equal(bearerMatches(`Bearer ${secret}`, secret), true);
  for (const header of [undefined, '', `Bearer ${'b'.repeat(64)}`, `Bearer ${secret} `, `bearer ${secret}`, `Bearer ${secret.slice(1)}`, ['Bearer', secret]])
    assert.equal(bearerMatches(header, secret), false);
});
