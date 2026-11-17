import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerClaudeSettings } from '../runtime/providers.mjs';

const bundled = readFileSync(new URL('../runtime/claude-settings.json', import.meta.url), 'utf8');

test('every worker command runs in the sandbox, with no excluded command patterns', () => {
  for (const mode of ['human', 'anyone']) {
    const { sandbox } = workerClaudeSettings(bundled, mode);
    assert.equal(sandbox.enabled, true);
    assert.equal(sandbox.allowUnsandboxedCommands, false);
    // An excluded pattern runs unsandboxed under the worker's Bash grant; `npx playwright test` runs checkout code.
    assert.equal(sandbox.excludedCommands, undefined);
  }
});
