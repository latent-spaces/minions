import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeferredSends } from '../runtime/project-operations.mjs';

// The server counts a message body in characters (code points), so emoji count once.
test('deferred send accepts a 2000-character body with emoji and refuses 2001 characters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-send-length-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new DeferredSends(join(root, 'deferred.json'), 'identity');
  const send = (id, body) => journal.add({ to: ['agent-1'], body, client_message_id: id });
  assert.equal(send('emoji', '🙂'.repeat(2000)).existing, false);
  assert.throws(() => send('too-long', '🙂'.repeat(2001)), TypeError);
});
