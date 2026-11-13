import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { resolve } from 'node:path';

test('canonicalPath stops at a missing root', async () => {
  let calls = 0;
  mock.module('node:fs', { namedExports: { ...Object.fromEntries(Object.entries(fs).filter(([k]) => k !== 'default')), lstatSync: () => {
    if (++calls > 50) throw new Error('canonicalPath kept walking past the root.');
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  } } });
  const { canonicalPath } = await import('../src/state.mjs');
  const value = resolve('missing-root', 'a', 'b');
  assert.equal(canonicalPath(value), value);
});
