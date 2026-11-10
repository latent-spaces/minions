import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSmokeOptions } from '../scripts/native-smoke-options.mjs';

const approved = ['--approved', '--claude-model', 'sonnet', '--codex-model', 'gpt-6.1-sol', '--expect-platform', 'win32'];
const windows = { platform: 'win32', nodeMajor: 24 };
test('real smoke setup requires explicit approval, pinned models, Node24 and the actual native platform before launch', () => {
  assert.throws(() => nativeSmokeOptions(approved.slice(1), windows), /approval/);
  assert.throws(() => nativeSmokeOptions(['--approved'], windows), /Pin an available model/);
  assert.throws(() => nativeSmokeOptions(approved, { ...windows, platform: 'darwin' }), /actual native host/);
  assert.throws(() => nativeSmokeOptions(approved, { ...windows, nodeMajor: 25 }), /Node 24/);
  for (const extra of [['--timeout-seconds', '301'], ['--timeout-seconds', '10'], ['--timeout-seconds', '1.2'], ['--approved'], ['--unknown'], ['--claude', '\0']]) assert.throws(() => nativeSmokeOptions([...approved, ...extra], windows));
});
test('real Windows smoke options retain chosen models and executable paths with spaces as literal arguments', () => {
  const options = nativeSmokeOptions([...approved, '--claude', 'C:\\Coding clients\\claude.exe', '--codex', 'C:\\Users\\Person\\codex.cmd', '--timeout-seconds', '240'], windows);
  assert.deepEqual(options.models, { claude: 'sonnet', codex: 'gpt-6.1-sol' });
  assert.equal(options.executables.codex, 'C:\\Users\\Person\\codex.cmd');
  assert.equal(options.timeoutSeconds, 240);
});
