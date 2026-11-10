import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSmokeSummary } from '../scripts/native-smoke-report.mjs';

test('shareable native smoke report retains bounded evidence and excludes private output, credentials, paths and dollar estimates', () => {
  const secret = 'must-stay-private';
  const summary = nativeSmokeSummary({ passed: false, platform: 'win32', phase: 'verifying', root: secret, error: secret, cleanupErrors: [secret], providers: {
    claude: { selectedModel: 'sonnet', initialFile: true, prompt: secret, auth: secret, outcomes: [{ text: secret, outcome: { text: secret, delivery: 'acknowledged', cleanupConfirmed: true, usage: { model: 'sonnet', costUsd: 0.1, tokens: { input: 10, output: 3, credentials: secret } }, diagnostics: { phase: 'turn', stderr: secret, exit_code: 0 } } }] },
  } });
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('costUsd'), false);
  assert.equal(summary.cleanupFailed, true);
  assert.deepEqual(summary.providers.claude.outcomes[0].tokens, { input: 10, output: 3, cacheRead: null, cacheWrite: null, modelCalls: null });
});
