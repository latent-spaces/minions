import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codingAgent } from '../src/ui/coding-agent';
import { directoryEntries } from '../src/community-directory';

test('tool marks recognize execution providers, never model names or model vendors', () => {
  assert.deepEqual(codingAgent('claude'), { id: 'claude', name: 'Claude Code' });
  assert.deepEqual(codingAgent('codex'), { id: 'codex', name: 'Codex' });
  for (const value of [null, undefined, '', 'unknown', 'anthropic', 'openai', 'claude-sonnet-4-5', 'gpt-5-codex'])
    assert.equal(codingAgent(value), null);
});

test('directory entries retain the reported tool independently of an agent name', () => {
  const base = { operatorId: null, operatorName: null, revokedAt: null, state: 'idle' as const, freshUntil: null };
  const entries = directoryEntries([], [
    { ...base, id: 'one', name: 'Claude researcher', usage: { provider: 'codex' } },
    { ...base, id: 'two', name: 'Codex reviewer', usage: null },
  ], 0);
  assert.equal(entries[0].kind === 'agent' && entries[0].provider, 'codex');
  assert.equal(entries[1].kind === 'agent' && entries[1].provider, undefined);
});
