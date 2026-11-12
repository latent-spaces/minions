import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProvider } from '../runtime/providers.mjs';
import { createRunJournal, readRunJournal } from '../src/run-journal.mjs';
const identity = { target: { site: 'http://127.0.0.1:8787', ownerId: 'synthetic-owner', projectId: 'synthetic-project', agentId: 'synthetic-agent' }, missionId: randomUUID(), generation: 1, provider: 'claude', model: null };
const event = kind => ({ kind, turnId: randomUUID(), attemptId: randomUUID() });
function fixture(fn) { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'karma-journal-'))); try { return fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); } }

test('private journal captures only allowlisted observations, redacts bridge token, pages and binds identity', () => fixture(directory => {
  const journal = createRunJournal({ directory, identity, redact: ['secret-token'] }), attempt = event('attempt_started');
  journal.append(attempt);
  journal.append({ ...attempt, kind: 'assistant_text', text: 'Done secret-token', arguments: 'NEVER_SAVE', reasoning: 'NEVER_SAVE' });
  journal.append({ ...attempt, kind: 'tool', name: 'Bash', result: 'NEVER_SAVE' });
  journal.append({ ...attempt, kind: 'attempt_finished', failed: false, interrupted: false, cleanupConfirmed: true });
  const first = readRunJournal({ directory, identity, limit: 2 });
  assert.equal(first.availability, 'available'); assert.equal(first.records.length, 2); assert.equal(first.hasMore, true); assert.deepEqual(first.interruptedAttempts, []);
  assert.equal(first.records[1].text, 'Done [REDACTED]');
  const second = readRunJournal({ directory, identity, after: first.nextAfter, limit: 2 }); assert.equal(second.hasMore, false); assert.equal(second.nextAfter, 4);
  const bytes = readFileSync(join(directory,'run-evidence.jsonl'),'utf8'); assert.equal(/NEVER_SAVE|secret-token/.test(bytes), false);
  assert.equal(readRunJournal({ directory, identity: { ...identity, target: { ...identity.target, ownerId: 'foreign' } } }).availability, 'corrupt');
}));

for (const provider of ['claude','codex']) test(`${provider} collector scrubs a credential crossing the text capture limit before clipping`, () => fixture(directory => {
  const token = 'synthetic-long-bridge-token-never-expose';
  const journal = createRunJournal({directory,identity,redact:[token]}), attempt = event('attempt_started');
  const stream = createProvider(provider,{}).collector({rpc: {}, assistantText: text => journal.append({...attempt,kind:'assistant_text',text})});
  const text = 'x'.repeat(3980) + token + 'end';
  if (provider==='claude') stream.feed(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}})+'\n');
  else { stream.threadId='11111111-1111-4111-8111-111111111111'; stream.turnId='test-turn'; stream.feed(JSON.stringify({method:'item/completed',params:{threadId:stream.threadId,turnId:stream.turnId,item:{type:'agentMessage',text}}})+'\n'); }
  const record=readRunJournal({directory,identity}).records[0];
  assert.equal(record.textTruncated,true); assert.equal(record.text.includes('synthetic-long-bridge'),false); assert.ok(record.text.includes('[REDACTED]'));
}));

test('text cut short only because redaction lengthened it is marked truncated', () => fixture(directory => {
  const journal = createRunJournal({ directory, identity, redact: ['ab'] }), attempt = event('attempt_started');
  journal.append(attempt);
  journal.append({ ...attempt, kind: 'assistant_text', text: `ab${'x'.repeat(3998)}` });
  const [, record] = readRunJournal({ directory, identity }).records;
  assert.equal([...record.text].length, 4000);
  assert.equal(record.textTruncated, true);
}));
