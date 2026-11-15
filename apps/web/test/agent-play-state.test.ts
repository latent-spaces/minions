import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPlayState, repeatExecution, type PlayRequest } from '../src/ui/agent-play-state';
const request: PlayRequest = { id: '12345678-1234-4234-8234-123456789012', projectId: 'project', agentId: 'agent', name: 'bright-fox', execution: { provider: 'codex', model: 'chosen-model' }, approved: true };
function storage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; }
test('another agent or project never restores a saved intent and expired authorization sends nothing', async () => {
  const saved = storage(); saved.setItem('key', JSON.stringify(request)); let sends = 0;
  const options = { key: 'key', projectId: 'other', agentId: 'agent', storage: saved, authorized: () => true, prepare: async () => request,
    send: async () => { sends++; }, refused: () => false, changed: () => {}, accepted: () => {} };
  assert.equal(agentPlayState(options).snapshot().pending, null);
  assert.equal(agentPlayState({ ...options, projectId: 'project', agentId: 'other' }).snapshot().pending, null);
  await agentPlayState({ ...options, authorized: () => false }).start(); assert.equal(sends, 0);
});

test('a replayed start keeps its provider and model, and needs that provider ready on this computer', () => {
  const runtime = { protocol: 1, version: '1', incarnation: 'i', platform: 'darwin', providers: [{ id: 'codex', available: true, reason: 'ready' }], lastSeenAt: 1000, online: true };
  assert.deepEqual(repeatExecution({ execution: { provider: 'codex', model: 'chosen-model' } }, runtime, 2000), { execution: { provider: 'codex', model: 'chosen-model' } });
  assert.throws(() => repeatExecution({ execution: { provider: 'claude', model: null } }, runtime, 2000), /coding tool/);
  assert.throws(() => repeatExecution({ execution: { provider: 'codex', model: null } }, null, 2000), /coding tool/);
});
