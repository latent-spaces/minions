import test from 'node:test';
import assert from 'node:assert/strict';
import { projectToolResult } from '../src/service/project-tool-result.mjs';

test('valid text tool refusals pass through without JSON-only parsing', () => {
  const result = { isError: true, content: [{ type: 'text', text: 'intent_conflict: reread the task revision' }] };
  assert.equal(projectToolResult({ result }), result);
});

test('protocol refusals retain bounded code/message and discard error data', () => {
  const result = projectToolResult({ error: { code: -32602, message: 'Tool comment_task not found', data: { token: 'hidden' } } });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { error: { code: -32602, message: 'Tool comment_task not found' } });
  const redacted = projectToolResult({ error: { code: 'refused', message: 'binding-secret Bearer other-secret token=third-secret\n' + 'x'.repeat(1000) } }, 'binding-secret');
  const error = JSON.parse(redacted.content[0].text).error;
  assert.equal(error.code, 'refused');
  assert.equal(error.message.length, 256);
  assert.doesNotMatch(error.message, /binding-secret|other-secret|third-secret|\n/);
  assert.match(error.message, /redacted/);
  assert.equal(JSON.parse(projectToolResult({ error: { code: 'binding-secret', message: '' } }, 'binding-secret').content[0].text).error.code, 'project_refused');
  assert.equal(projectToolResult(null).isError, true);
});

test('protocol diagnostics redact quoted credential fields before clipping', () => {
  for (const fragment of [
    '{"token":"other-secret"}',
    '{"access_token": "other-secret with spaces"}',
    '{"authorization":"Bearer other-secret"}',
    "{'api_key':'other-secret'}",
    '{"apiKey":"other-secret\\\"escaped"}',
    '{"accessToken": "other-secret"}',
    '{"refresh_token": "other-secret"}',
    '{"client_secret": "other-secret"}',
    '{"password": "other-secret"}',
    'Authorization: Basic other-secret',
  ]) {
    const result = projectToolResult({ error: { code: -32602, message: `failure ${fragment}` } }, 'binding-secret');
    const { message } = JSON.parse(result.content[0].text).error;
    assert.doesNotMatch(message, /other-secret|escaped/);
    assert.match(message, /redacted/);
  }
  const message = JSON.parse(projectToolResult({ error: { code: -32602, message: 'é'.repeat(300) } }).content[0].text).error.message;
  assert.equal(message.length, 256);
  assert.equal(Buffer.byteLength(message), 512);
});
