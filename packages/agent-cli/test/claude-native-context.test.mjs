import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../runtime/providers.mjs';
import { validNativeContext } from '../src/context-measurement.mjs';

const feed = (stream, ...events) => { for (const e of events) stream.feed(JSON.stringify(e) + '\n'); };
const assistant = (id, usage, extra = {}) => ({ type: 'assistant', message: { id, content: [], usage }, ...extra });

test('Claude reports its latest request input, its model window and compactions', () => {
  const stream = createProvider('claude', {}).collector({});
  feed(stream,
    { type: 'system', subtype: 'init', model: 'claude-synthetic' },
    assistant('m1', { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 }),
    assistant('m1', { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 40 }),
    assistant('s1', { input_tokens: 99999, output_tokens: 1 }, { parent_tool_use_id: 'tool-1' }),
    { type: 'system', subtype: 'compact_boundary' },
    assistant('m2', { input_tokens: 3, cache_read_input_tokens: 4000, output_tokens: 7 }),
    { type: 'result', session_id: 'synthetic', modelUsage: { 'claude-small': { contextWindow: 50000 }, 'claude-synthetic': { contextWindow: 200000 } } });
  assert.deepEqual(stream.nativeContext, { source: 'claude-stream-json', coverage: 'partial-turn-stream', lastInputTokens: 4003, lastTotalTokens: 4010, modelContextWindow: 200000, observations: 2, completedCompactions: 1 });
  assert.equal(validNativeContext(stream.nativeContext), true);
});

test('Claude reports no context when no request usage arrives, and ignores malformed counts', () => {
  const stream = createProvider('claude', {}).collector({});
  feed(stream, assistant('m1', { input_tokens: -1, output_tokens: 2 }), { type: 'result', modelUsage: { x: { contextWindow: 1000 } } });
  assert.equal(stream.nativeContext, null);
});
