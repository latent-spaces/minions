import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerClaudeSettings, workerPrivateRoots } from '../runtime/providers.mjs';

const bundled = readFileSync(new URL('../runtime/claude-settings.json', import.meta.url), 'utf8');
const roots = options => workerPrivateRoots({ envSource: {}, platform: 'darwin', userHome: '/home/person', ...options });

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

test('private roots cover the service, credential and setup engine homes', () => {
  const stateDir = '/srv/minions/engine/connector-service/agents/abc';
  assert.deepEqual(roots({ stateDir, folder: '/work/project', envSource: { MINIONS_CREDENTIAL_HOME: '/srv/minions/engine/connector-credentials', MINIONS_ENGINE_HOME: 'relative' } }),
    ['//srv/minions/engine/connector-service', '//srv/minions/engine', '//srv/minions/engine/connector-credentials']);
  // The default install is covered by the ~/.minions entry workerClaudeSettings always adds.
  assert.deepEqual(roots({ stateDir: '/home/person/.minions/engine/connector-service/agents/abc', folder: '/home/person/minions/projects/repo' }),
    ['//home/person/.minions/engine/connector-service', '//home/person/.minions/engine']);
  // Windows rule spellings differ: only the default ~/.minions entry applies there.
  assert.deepEqual(roots({ stateDir, folder: '/work/project', platform: 'win32' }), []);
});

test('a checkout overlapping private state is refused before launch, including the default ~/.minions', () => {
  // A checkout above private state: its write grant would cover the credentials.
  assert.throws(() => roots({ stateDir: '/srv/state/agents/abc', folder: '/srv', envSource: { MINIONS_CREDENTIAL_HOME: '/srv/creds' } }), /overlap/);
  assert.throws(() => roots({ stateDir: '/srv/state/agents/abc', folder: '/home/person' }), /overlap/);
  assert.throws(() => roots({ stateDir: '/srv/minions/engine/connector-service/agents/abc', folder: '/srv/minions/engine/checkout' }), /checkout and Minions private state overlap/);
  assert.throws(() => roots({ stateDir: '/srv/state/agents/abc', folder: '/home/person/.minions/projects/repo' }), /checkout and Minions private state overlap/);
});

test('a private path the rules cannot spell is refused rather than left readable', () => {
  assert.throws(() => roots({ stateDir: '/srv/Minions (work)/connector-service/agents/abc', folder: '/work/project' }), /characters the worker sandbox rules cannot express/);
  assert.throws(() => roots({ stateDir: '/srv/state/agents/abc', folder: '/work/project', envSource: { MINIONS_CREDENTIAL_HOME: '/srv/creds[1]' } }), /cannot express/);
});
