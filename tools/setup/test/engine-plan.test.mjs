import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnvironment, connectorCommand, connectorEnvironment, engineEnvironment, engineHome, enginePaths, enginePort, engineUrl,
  initializationState, interruptedByUser, needsInstall, holderFromLsof, occupiedMessage, ownerIdentity, pageOpener, pidFromNetstat, requireNode24, savedPort, settingsText, startupHint } from '../engine-plan.mjs';

test('the engine needs Node.js 24 or newer', () => {
  assert.throws(() => requireNode24('v22.20.0'), /Node\.js 24/);
  requireNode24('v24.0.0'); requireNode24('v26.13.0');
});

test('Windows and POSIX homes stay inside the user folder, with every engine and connector file apart', () => {
  const windows = engineHome({ env: {}, userHome: 'C:\\Users\\Ana Lee', platform: 'win32' });
  assert.equal(windows, 'C:\\Users\\Ana Lee\\.minions\\engine');
  const files = enginePaths(windows, 'win32');
  assert.equal(files.ownerFile, 'C:\\Users\\Ana Lee\\.minions\\engine\\owner.json');
  assert.equal(new Set(Object.values(files)).size, Object.keys(files).length);
  assert.equal(engineHome({ env: {}, userHome: '/Users/ana', platform: 'darwin' }), '/Users/ana/.minions/engine');
  assert.equal(engineHome({ env: { MINIONS_ENGINE_HOME: '/tmp/engine one' }, userHome: '/Users/ana', platform: 'darwin' }), '/tmp/engine one');
  assert.throws(() => engineHome({ env: { MINIONS_ENGINE_HOME: 'relative' }, userHome: '/Users/ana', platform: 'darwin' }), /absolute/);
  assert.throws(() => engineHome({ env: { MINIONS_ENGINE_HOME: 'engine' }, userHome: 'C:\\Users\\Ana', platform: 'win32' }), /absolute/);
});

test('the port defaults to 8787 and refuses privileged or invalid values', () => {
  assert.equal(enginePort({}), 8787);
  assert.equal(enginePort({ MINIONS_ENGINE_PORT: '8797' }), 8797);
  for (const value of ['80', 'abc', '70000', '']) assert.throws(() => enginePort({ MINIONS_ENGINE_PORT: value }), /1024 to 65535/);
});

test('a restarted engine keeps the port it last ran on unless MINIONS_ENGINE_PORT names another', () => {
  assert.equal(savedPort(settingsText(8789)), 8789);
  assert.equal(enginePort({}, savedPort(settingsText(8789))), 8789);
  assert.equal(enginePort({ MINIONS_ENGINE_PORT: '8797' }, 8789), 8797);
  for (const text of [null, '', '{', '{"port":80}', '{"port":"8789"}', '{"port":8789.5}']) assert.equal(savedPort(text), null);
  assert.equal(enginePort({}, savedPort('{"port":80}')), 8787);
});

test('a busy port is never swapped for another; the message names the program holding it', () => {
  assert.match(occupiedMessage(8787, 'node (process 4242)'), /^Port 8787 is used by node \(process 4242\), so the engine could not start there\..*MINIONS_ENGINE_PORT.*Nothing was started or stopped/);
  assert.match(occupiedMessage(9000), /^Port 9000 is used by another program/);
  assert.equal(holderFromLsof('p4242\ncnode\n'), 'node (process 4242)');
  assert.equal(holderFromLsof(''), null);
  const netstat = '  Proto  Local Address  Foreign Address  State  PID\r\n  TCP  0.0.0.0:18787  0.0.0.0:0  LISTENING  11\r\n  TCP  127.0.0.1:8787  0.0.0.0:0  LISTENING  4242\r\n';
  assert.equal(pidFromNetstat(netstat, 8787), '4242');
  assert.equal(pidFromNetstat(netstat, 8788), null);
});

test('children get one PATH led by the selected Node and no test-session or enrolled-origin settings', () => {
  const env = { Path: 'C:\\Windows', MINIONS_TEST_SESSION: 'minions-tests-0123456789ab', TRUST_PROXY: '1', MINIONS_SELF_HOSTED_ORIGIN: 'https://engine.example', HOST: '0.0.0.0', PORT: '3000', HOME: 'C:\\Users\\Ana', NODE_ENV: 'production' };
  const result = childEnvironment(env, { nodeDirectory: 'C:\\Program Files\\nodejs', platform: 'win32' });
  assert.deepEqual(result, { HOME: 'C:\\Users\\Ana', PATH: 'C:\\Program Files\\nodejs;C:\\Windows' });
  assert.deepEqual(childEnvironment({}, { nodeDirectory: '/opt/node/bin', platform: 'darwin' }), { PATH: '/opt/node/bin' });
  const engine = engineEnvironment(result, { home: 'C:\\Users\\Ana\\.minions\\engine', port: 8787, platform: 'win32' });
  assert.equal(engine.MINIONS_ENGINE, 'self-hosted');
  assert.equal(engine.HOST, '127.0.0.1'); assert.equal(engine.PORT, '8787');
  assert.equal(engine.MINIONS_SQLITE_PATH, 'C:\\Users\\Ana\\.minions\\engine\\engine.sqlite');
  const connector = connectorEnvironment(result, { home: '/Users/ana/.minions/engine', port: 8797, platform: 'darwin' });
  assert.equal(connector.MINIONS_SITE_URL, 'http://127.0.0.1:8797');
  assert.equal(connector.MINIONS_SERVICE_HOME, '/Users/ana/.minions/engine/connector-service');
  assert.equal(connector.MINIONS_SELF_HOSTED_ORIGIN, undefined);
});

test('the owner identity prefers explicit options and falls back to Git, never to a guess', () => {
  const git = key => ({ 'user.name': 'Ana Lee', 'user.email': 'ana@example.test' })[key];
  assert.deepEqual(ownerIdentity({}, git), { name: 'Ana Lee', email: 'ana@example.test', fromGit: true });
  assert.deepEqual(ownerIdentity({ 'owner-name': 'Ana', 'owner-email': 'a@example.test' }, () => ''), { name: 'Ana', email: 'a@example.test', fromGit: false });
  assert.throws(() => ownerIdentity({ 'owner-name': 'Ana' }, () => ''), /--owner-email/);
});

test('pages open through the platform opener and never over SSH, CI or a headless Linux session', () => {
  assert.deepEqual(pageOpener('darwin', {}), ['open']);
  assert.deepEqual(pageOpener('win32', {}), ['rundll32', 'url.dll,FileProtocolHandler']);
  assert.deepEqual(pageOpener('linux', { DISPLAY: ':0' }), ['xdg-open']);
  assert.equal(pageOpener('linux', {}), null);
  assert.equal(pageOpener('darwin', { SSH_CONNECTION: '1' }), null);
  assert.equal(pageOpener('win32', { CI: 'true' }), null);
  assert.equal(pageOpener('darwin', { MINIONS_NO_BROWSER: '1' }), null);
});

test('npm ci runs again unless npm finished an install at least as new as package-lock.json', () => {
  assert.equal(needsInstall({ hiddenLockfile: null, lockfile: 1000 }), true); // partial install or none
  assert.equal(needsInstall({ hiddenLockfile: 900, lockfile: 1000 }), true); // dependencies changed since
  assert.equal(needsInstall({ hiddenLockfile: 1000, lockfile: 1000 }), false);
  assert.equal(needsInstall({ hiddenLockfile: 1200, lockfile: 1000 }), false);
});

test('only a database with its owner file counts as initialized; one without the other is an interrupted first run', () => {
  assert.equal(initializationState({ database: false, owner: false }), 'new');
  assert.equal(initializationState({ database: true, owner: true }), 'existing');
  assert.equal(initializationState({ database: true, owner: false }), 'incomplete');
  assert.equal(initializationState({ database: false, owner: true }), 'incomplete');
});

test('a connector Ctrl+C is SIGINT on POSIX and exit 130 on Windows; other failures are not', () => {
  assert.equal(interruptedByUser({ code: null, signal: 'SIGINT' }), true);
  assert.equal(interruptedByUser({ code: 130, signal: null }), true);
  for (const exit of [{ code: 1, signal: null }, { code: null, signal: 'SIGTERM' }, undefined]) assert.equal(interruptedByUser(exit), false);
});

test('known startup refusals get recovery advice that names the files, and others get none', () => {
  const files = { home: '/Users/ana/.minions/engine', sqlitePath: '/Users/ana/.minions/engine/engine.sqlite' };
  assert.match(startupHint('The database has no completed standalone initialization. Startup never repairs an existing store.', files), /remove that directory/);
  assert.equal(startupHint('Build the local viewer first.', files), '');
});

test('the printed connector command quotes paths with spaces and quotes for PowerShell and POSIX shells', () => {
  const windows = connectorCommand('win32', { node: 'C:\\Program Files\\nodejs\\node.exe', cli: "C:\\Users\\Ana O'Neil\\minions\\cli.mjs",
    serviceHome: 'C:\\Users\\Ana O\'Neil\\.minions\\engine\\connector-service', credentialHome: 'C:\\x y\\creds', args: ['setup', '--site', 'http://127.0.0.1:8787'] });
  assert.equal(windows, "$env:MINIONS_SERVICE_HOME='C:\\Users\\Ana O''Neil\\.minions\\engine\\connector-service'; $env:MINIONS_CREDENTIAL_HOME='C:\\x y\\creds'; "
    + "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Ana O''Neil\\minions\\cli.mjs' 'setup' '--site' 'http://127.0.0.1:8787'");
  const posix = connectorCommand('darwin', { node: '/opt/node 24/bin/node', cli: "/Users/ana/it's/cli.mjs", serviceHome: '/s h', credentialHome: '/c', args: ['mcp-config'] });
  assert.equal(posix, "MINIONS_SERVICE_HOME='/s h' MINIONS_CREDENTIAL_HOME='/c' '/opt/node 24/bin/node' '/Users/ana/it'\\''s/cli.mjs' 'mcp-config'");
});

test('the listening address is read from engine output with LF or CRLF line endings', () => {
  assert.equal(engineUrl('Standalone engine listening on http://127.0.0.1:8787\r\n'), 'http://127.0.0.1:8787');
  assert.equal(engineUrl('Standalone engine list'), null);
});
