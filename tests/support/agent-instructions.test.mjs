import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Claude Code reads CLAUDE.md and other coding agents read AGENTS.md; both must give the
// same instructions. Line endings are normalized so a Windows checkout compares equal.
const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('CLAUDE.md and AGENTS.md hold the same instructions', () => {
  assert.equal(read('CLAUDE.md'), read('AGENTS.md'),
    'CLAUDE.md and AGENTS.md differ: make the same edit in both files.');
});
