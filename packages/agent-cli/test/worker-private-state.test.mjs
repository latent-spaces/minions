import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workerClaudeSettings, workerPrivateRoots } from '../runtime/providers.mjs';

const bundled = readFileSync(new URL('../runtime/claude-settings.json', import.meta.url), 'utf8');
// Paths under one real temporary folder, so physical and spelled paths agree unless a test adds a link.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'minions-private-roots-')));
test.after(() => rmSync(base, { recursive: true, force: true }));
const at = (...parts) => join(base, ...parts);
const home = at('home', 'person');
// These cases spell POSIX paths with node:path and create symlinks, so they run off Windows only.
const posixOnly = { skip: process.platform === 'win32' };
const roots = options => workerPrivateRoots({ envSource: {}, platform: 'darwin', userHome: home, ...options });

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

test('private roots cover the service, credential and setup engine homes', posixOnly, () => {
  const stateDir = at('srv', 'engine', 'connector-service', 'agents', 'abc');
  assert.deepEqual(roots({ stateDir, folder: at('work', 'project'), envSource: { MINIONS_CREDENTIAL_HOME: at('srv', 'engine', 'connector-credentials'), MINIONS_ENGINE_HOME: 'relative' } }),
    [`/${at('srv', 'engine', 'connector-service')}`, `/${at('srv', 'engine')}`, `/${at('srv', 'engine', 'connector-credentials')}`]);
  // The default install is covered by the ~/.minions entry workerClaudeSettings always adds.
  assert.deepEqual(roots({ stateDir: join(home, '.minions', 'engine', 'connector-service', 'agents', 'abc'), folder: join(home, 'minions', 'projects', 'repo') }),
    [`/${join(home, '.minions', 'engine', 'connector-service')}`, `/${join(home, '.minions', 'engine')}`]);
});

test('a checkout overlapping private state is refused before launch, including the default ~/.minions', posixOnly, () => {
  // A checkout above private state: its write grant would cover the credentials.
  assert.throws(() => roots({ stateDir: at('srv', 'state', 'agents', 'abc'), folder: at('srv'), envSource: { MINIONS_CREDENTIAL_HOME: at('srv', 'creds') } }), /overlap/);
  assert.throws(() => roots({ stateDir: at('srv', 'state', 'agents', 'abc'), folder: home }), /overlap/);
  assert.throws(() => roots({ stateDir: at('srv', 'engine', 'connector-service', 'agents', 'abc'), folder: at('srv', 'engine', 'checkout') }), /overlap/);
  assert.throws(() => roots({ stateDir: at('srv', 'state', 'agents', 'abc'), folder: join(home, '.minions', 'projects', 'repo') }), /overlap/);
});

test('a linked home is compared by its physical path and denied by both spellings', posixOnly, () => {
  const real = at('disk', 'person'), linked = at('linked-person');
  mkdirSync(join(real, '.minions'), { recursive: true }); symlinkSync(real, linked);
  const stateDir = at('srv', 'state', 'agents', 'abc');
  // The adapter receives the physical checkout; ~/.minions is spelled through the link.
  assert.throws(() => roots({ stateDir, folder: join(real, '.minions', 'projects', 'repo'), userHome: linked }), /overlap/);
  const rules = roots({ stateDir, folder: at('work', 'project'), userHome: linked, envSource: { MINIONS_CREDENTIAL_HOME: join(linked, 'creds') } });
  assert.ok(rules.includes(`/${join(real, '.minions')}`));
  assert.ok(rules.includes(`/${join(linked, 'creds')}`) && rules.includes(`/${join(real, 'creds')}`));
});

test('a private path the rules cannot spell is refused rather than left readable', posixOnly, () => {
  assert.throws(() => roots({ stateDir: at('Minions (work)', 'connector-service', 'agents', 'abc'), folder: at('work', 'project') }), /characters the worker sandbox rules cannot express/);
  assert.throws(() => roots({ stateDir: at('srv', 'state', 'agents', 'abc'), folder: at('work', 'project'), envSource: { MINIONS_CREDENTIAL_HOME: at('creds[1]') } }), /cannot express/);
});

test('Windows roots use the //c/… spelling Claude Code reads as C:\\…, compared without letter case', () => {
  const win = options => workerPrivateRoots({ platform: 'win32', userHome: 'C:\\Users\\Person', realpath: path => path, envSource: {}, ...options });
  assert.deepEqual(win({ stateDir: 'D:\\Minions\\engine\\connector-service\\agents\\abc', folder: 'C:\\Users\\Person\\minions\\projects\\repo',
    envSource: { minions_credential_home: 'D:\\Minions\\engine\\connector-credentials' } }),
  ['//d/Minions/engine/connector-service', '//d/Minions/engine', '//d/Minions/engine/connector-credentials']);
  // The default install needs no entry beyond ~/.minions.
  assert.deepEqual(win({ stateDir: 'C:\\Users\\Person\\.minions\\engine\\connector-service\\agents\\abc', folder: 'C:\\Users\\Person\\minions\\projects\\repo' }),
    ['//c/Users/Person/.minions/engine/connector-service', '//c/Users/Person/.minions/engine']);
  assert.throws(() => win({ stateDir: 'C:\\Users\\Person\\.minions\\engine\\connector-service\\agents\\abc', folder: 'c:\\users\\person\\.MINIONS\\projects\\repo' }), /overlap/);
  assert.throws(() => win({ stateDir: '\\\\server\\share\\minions\\agents\\abc', folder: 'C:\\work\\repo' }), /network path/);
});

test('a client without deny rules still gets the overlap refusal, without the rule-spelling one', posixOnly, () => {
  assert.throws(() => roots({ stateDir: at('srv', 'state', 'agents', 'abc'), folder: join(home, '.minions', 'projects', 'repo'), rules: false }), /overlap/);
  assert.deepEqual(roots({ stateDir: at('Minions (work)', 'connector-service', 'agents', 'abc'), folder: at('work', 'project'), rules: false }), []);
});
