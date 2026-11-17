import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerClaudeSettings, workerPrivateRoots } from '../runtime/providers.mjs';

const bundled = readFileSync(new URL('../runtime/claude-settings.json', import.meta.url), 'utf8');

test('worker commands and the Read tool are kept out of the Minions private folders', () => {
  const settings = workerClaudeSettings(bundled, 'anyone', ['//srv/minions/engine/connector-service']);
  for (const root of ['~/.minions', '//srv/minions/engine/connector-service']) {
    assert.ok(settings.sandbox.filesystem.denyRead.includes(root));
    assert.ok(settings.permissions.deny.includes(`Read(${root}/**)`));
    assert.ok(settings.permissions.deny.includes(`Edit(${root}/**)`));
  }
  assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.ssh'));
  assert.throws(() => workerClaudeSettings(bundled, 'anyone', ['relative/path']), /Invalid private state path/);
});

test('private roots cover the service home and the setup engine home, never the checkout', () => {
  const stateDir = '/srv/minions/engine/connector-service/agents/abc';
  assert.deepEqual(workerPrivateRoots({ stateDir, folder: '/work/project', envSource: { MINIONS_CREDENTIAL_HOME: '/srv/minions/engine/connector-credentials' }, platform: 'darwin' }),
    ['//srv/minions/engine/connector-service', '//srv/minions/engine', '//srv/minions/engine/connector-credentials']);
  // A checkout inside a candidate root keeps that root readable rather than hiding the agent's own work.
  assert.deepEqual(workerPrivateRoots({ stateDir, folder: '/srv/minions/engine/checkout', envSource: {}, platform: 'linux' }), ['//srv/minions/engine/connector-service']);
  assert.deepEqual(workerPrivateRoots({ stateDir, folder: '/work/project', envSource: { MINIONS_ENGINE_HOME: 'relative' }, platform: 'linux' }).length, 2);
  assert.deepEqual(workerPrivateRoots({ stateDir, folder: '/work/project', platform: 'win32' }), []);
});
