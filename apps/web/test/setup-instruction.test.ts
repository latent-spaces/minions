import test from 'node:test';
import assert from 'node:assert/strict';
import { setupCommand, computerSetupInstructions } from '../src/setup-instruction';

test('setup commands name every website except the local engine, without shell metacharacters', () => {
  assert.equal(setupCommand('http://127.0.0.1:8787'), 'node packages/agent-cli/src/cli.mjs setup');
  assert.match(computerSetupInstructions('http://127.0.0.1:8787'), /from a checkout of the mylittleswarm repository: in it, run npm ci --ignore-scripts, then run node packages\/agent-cli\/src\/cli\.mjs setup in the background/);
  for (const origin of ['https://swarm.example:8443', 'http://127.0.0.1:5173', 'http://localhost:5174'])
    assert.ok(setupCommand(origin).endsWith(` --site ${origin}`));
  assert.match(computerSetupInstructions('http://127.0.0.1:8787'), /in the background and show me each MyLittleSwarm setup message/);
});

test('URLs accepted by WHATWG still cannot inject shell expressions into the copied setup command', () => {
  for (const origin of ['https://a$(id).example', 'https://a&b.example', 'https://a;b.example', 'https://a`id`.example',
    'https://name:secret@karma42.ai', 'https://karma42.ai/?x=1', 'http://foreign.example'])
    assert.throws(() => setupCommand(origin), undefined, origin);
});
