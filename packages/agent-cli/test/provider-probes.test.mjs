import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('background provider probes suppress Windows console windows', async t => {
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    const stdout = args.includes('--version') ? 'codex-cli 0.164.0'
      : args.includes('mcp') ? '[]'
      : args.includes('execpolicy') ? '{"decision":"forbidden"}' : 'signed in';
    return { stdout, stderr: '' };
  };
  const original = childProcess.execFile;
  childProcess.execFile = Object.assign(() => {}, { [promisify.custom]: execute });
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  const { createProvider } = await import('../runtime/providers.mjs');
  // Node itself resolves on every platform, including the Windows command adapter.
  const settings = { claude: process.execPath, codex: process.execPath, repoDir: process.cwd() };
  const signal = new AbortController().signal;
  await createProvider('claude', settings).preflight({ signal });
  const codex = createProvider('codex', settings);
  await codex.preflight({ signal });
  await codex.validateMergeRules('synthetic.rules', 'human', { signal });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(call => call.args.at(0)), ['--version', '--version', 'login', '-c', 'execpolicy']);
  for (const { options } of calls) {
    assert.equal(options.windowsHide, true);
    assert.equal(options.signal, signal);
    assert.equal(options.timeout, 15_000);
    assert.equal(options.killSignal, 'SIGKILL');
  }
});
