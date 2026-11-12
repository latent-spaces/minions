import test from 'node:test';
import assert from 'node:assert/strict';

test('run-length exports only names other modules use', async () => {
  const module = await import('../src/run-length.mjs');
  assert.deepEqual(Object.keys(module).sort(), ['MAX_REMAINING_MS', 'validRunMinutes']);
  assert.equal(module.MAX_REMAINING_MS, 24 * 60 * 60000);
  assert.equal(module.validRunMinutes(5), true);
  assert.equal(module.validRunMinutes(7), false);
});
