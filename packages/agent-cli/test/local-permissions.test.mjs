import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, localPermissionGuidance } from '../runtime/providers.mjs';

test('Codex commit guidance requests narrow native review without promising permission or changing other providers', () => {
  const codex = localPermissionGuidance('humans', 'codex');
  assert.match(codex, /linked-worktree metadata/);
  assert.match(codex, /rather than an explicit approval denial/);
  assert.match(codex, /exact necessary command using require_escalated/);
  assert.match(codex, /does not guarantee review approval/);
  assert.match(codex, /Never make Git metadata writable, relocate it, change sandbox settings/);
  assert.match(codex, /report that no commit was created/);
  assert.match(codex, /do not retry a denied action/);
  for (const provider of ['claude', undefined]) {
    assert.doesNotMatch(localPermissionGuidance('humans', provider), /require_escalated/);
  }
});

test('unanswered native approvals decline one action without terminating useful work', () => {
  const replies = [], denials = [];
  const stream = createProvider('codex', {}).collector({ rpc: {}, permission: value => denials.push(value) });
  stream.process = { stdin: { destroyed: false, write: line => replies.push(JSON.parse(line)) } };
  stream.delivery = 'acknowledged'; stream.threadId = 'thread'; stream.turnId = 'turn';
  for (const [id, method] of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].entries()) {
    stream.line(JSON.stringify({ id: id + 100, method, params: { threadId: 'thread', turnId: 'turn', command: 'git commit -m approved-local-result' } }));
    assert.deepEqual(replies.at(-1), { id: id + 100, result: { decision: 'decline' } });
  }
  assert.equal(denials.length, 2);
  assert.equal(stream.closed, false);
  assert.equal(stream.failure, null);
});
