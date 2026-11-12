import test from 'node:test';
import assert from 'node:assert/strict';

test('turn-context exports only names other modules use', async () => {
  const module = await import('../src/turn-context.mjs');
  assert.deepEqual(Object.keys(module).sort(), ['CONTEXT_TOOL_NAMES', 'controllerPrompt', 'emptyPromptSources', 'validPromptSources']);
  assert.equal(module.validPromptSources(module.emptyPromptSources(), 0), true);
});
