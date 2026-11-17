import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAppended } from '../engine-control.mjs';
import { engineUrl } from '../engine-plan.mjs';

test('startup output after an earlier non-ASCII log is found at its byte offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minions engine log '));
  try {
    const log = join(dir, 'engine.log');
    // Multi-byte text makes the byte size larger than the decoded string length.
    writeFileSync(log, 'Standalone engine listening on http://127.0.0.1:1111\n✓ café 日本語 ☃\n');
    const offset = statSync(log).size;
    assert.equal(readAppended(log, offset), '');
    appendFileSync(log, 'Standalone engine listening on http://127.0.0.1:8787\n');
    assert.equal(engineUrl(readAppended(log, offset)), 'http://127.0.0.1:8787');
    assert.equal(readAppended(join(dir, 'missing.log'), 0), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
