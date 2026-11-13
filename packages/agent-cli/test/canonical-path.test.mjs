import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { canonicalPath } from '../src/state.mjs';

// Every path missing, including the root: what Windows reports for an unmounted drive such as Z:\.
test('canonicalPath stops at a root that does not exist, such as an unmounted Windows drive', () => {
  let calls = 0;
  const exists = () => { if (++calls > 50) throw new Error('canonicalPath kept walking past the root.'); return false; };
  const value = resolve('missing-root', 'a', 'b');
  assert.equal(canonicalPath(value, { exists }), value);
});
