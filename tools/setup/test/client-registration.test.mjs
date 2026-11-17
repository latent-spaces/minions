import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerSetupClients, isSetupEntry } from '../engine-setup.mjs';
import { connectorEnvironment } from '../engine-plan.mjs';
import { finishSetup } from '../../../packages/agent-cli/src/cli.mjs';
import { hostToolEnvironment } from '../../../packages/agent-cli/src/windows-command.mjs';
import { bundledGuideFiles, skillTextHash } from '../../../packages/agent-cli/src/skill-bundle.mjs';
import { ensureHome, writePrivate } from '../../../packages/agent-cli/src/state.mjs';

const execute = promisify(execFile);
const missing = async path => assert.rejects(readFile(path), { code: 'ENOENT' });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'minions first setup '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'person'), home = join(user, '.minions', 'engine'), bin = join(root, 'bin');
  const codex = join(user, '.codex');
  await mkdir(codex, { recursive: true }); await mkdir(bin);
  await writeFile(join(codex, 'config.toml'), 'model = "synthetic-only"\n');
  const source = `const fs=require('node:fs'),path=require('node:path');
    const file=path.join(require('node:os').homedir(),'.claude.json'),args=process.argv.slice(2);
    if(args[0]!=='mcp')throw Error('Only synthetic MCP registration is allowed');
    let config={};try{config=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    config.mcpServers??={};
    if(args[1]==='get')process.exit(config.mcpServers[args[2]]?0:1);
    if(args[1]==='add-json')config.mcpServers[args.at(-2)]=JSON.parse(args.at(-1));
    else if(args[1]==='remove')delete config.mcpServers[args.at(-1)];
    else throw Error('Unexpected synthetic client action');
    fs.writeFileSync(file,JSON.stringify(config));`;
  await writeFile(join(bin, 'client.cjs'), source);
  if (process.platform === 'win32') await writeFile(join(bin, 'claude.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\client.cjs" %*\r\n');
  else await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\n' + source, { mode: 0o755 });
  const base = Object.fromEntries(Object.entries(hostToolEnvironment()).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(base, { HOME: user, USERPROFILE: user, CODEX_HOME: codex, APPDATA: join(user, 'appdata'), LOCALAPPDATA: join(user, 'localappdata'), PATH: [bin, dirname(process.execPath)].join(delimiter) });
  const env = connectorEnvironment(base, { home, port: 18787 });
  ensureHome(env.MINIONS_SERVICE_HOME);
  // Registration describes an existing installation; it never contacts this synthetic endpoint.
  writePrivate(join(env.MINIONS_SERVICE_HOME, 'installation.json'), { version: 1, site: env.MINIONS_SITE_URL, port: 18788, token: 'a'.repeat(64) });
  const skills = ['.claude', '.agents'].map(client => join(user, client, 'skills', 'minions', 'SKILL.md'));
  return { user, env, skills, records: join(env.MINIONS_SERVICE_HOME, 'installed-skills.json'),
    register: (options = {}) => registerSetupClients({ ready: true, connectorEnv: env, env: {}, ...options }),
    manualRegister: () => execute(process.execPath, [fileURLToPath(new URL('../../../packages/agent-cli/src/cli.mjs', import.meta.url)), 'register'], { env, windowsHide: true }) };
}

test('root setup installs both skills after its separate connector step, using only its selected service home', async t => {
  const f = await fixture(t);
  assert.ok(f.env.MINIONS_SERVICE_HOME, 'ordinary root setup still selects a separate connector installation');
  assert.equal(await finishSetup(f.env.MINIONS_SERVICE_HOME, f.env.MINIONS_SITE_URL, () => {}, true, {
    clientHint: false, connect: () => assert.fail('separate connector step cannot modify clients'),
    execute: () => assert.fail('separate connector step cannot configure GitHub'),
    signIn: () => assert.fail('separate connector step cannot sign in to GitHub'),
  }), 0);
  await f.manualRegister();
  for (const skill of f.skills) await missing(skill); // Plain register retains its MCP-only behavior.
  const result = await f.register(); assert.equal(result.registered, true, result.lines);
  const files = bundledGuideFiles();
  for (const skill of f.skills) for (const [name, text] of Object.entries(files)) assert.equal(await readFile(join(dirname(skill), name), 'utf8'), text);
  const records = JSON.parse(await readFile(f.records, 'utf8'));
  for (const skill of f.skills) assert.equal(records[skill], skillTextHash(files['SKILL.md']));
  await missing(join(f.user, '.minions', 'service', 'installed-skills.json'));
  assert.match(await readFile(join(f.user, '.codex', 'config.toml'), 'utf8'), /model = "synthetic-only"/);
  // Current MCP entries must also repair a missing local skill.
  for (const skill of f.skills) await rm(dirname(skill), { recursive: true });
  assert.equal((await f.register()).registered, true);
  for (const skill of f.skills) assert.equal(await readFile(skill, 'utf8'), files['SKILL.md']);
});

test('isolated engines, --no-register and incomplete connector setup change no client or skill files', async t => {
  const f = await fixture(t);
  for (const options of [{ env: { MINIONS_ENGINE_HOME: join(f.user, 'isolated engine') } }, { values: { 'no-register': true } }, { ready: false }]) {
    assert.equal((await f.register(options)).registered, false);
    for (const skill of f.skills) await missing(skill);
    await missing(join(f.user, '.claude.json'));
    await missing(f.records);
    assert.equal(await readFile(join(f.user, '.codex', 'config.toml'), 'utf8'), 'model = "synthetic-only"\n');
  }
});

test('root registration preserves edited older skills and reports its existing customization safeguard', async t => {
  const f = await fixture(t);
  assert.equal((await f.register()).registered, true);
  const bundled = bundledGuideFiles()['SKILL.md'];
  const edited = bundled.replace(/guide-revision: "(\d+)"/, (_, n) => `guide-revision: "${Number(n) - 1}"`) + '\nMy own instructions.\n';
  for (const skill of f.skills) await writeFile(skill, edited);
  const result = await f.register(); assert.equal(result.registered, true);
  assert.match(result.lines, /kept your own Minions skill/);
  for (const skill of f.skills) assert.equal(await readFile(skill, 'utf8'), edited);
});

test('a skill write failure leaves successful MCP registration intact and visible', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  const directories = f.skills.map(dirname);
  for (const path of directories) { await mkdir(path, { recursive: true }); await chmod(path, 0o500); }
  try {
    const result = await f.register();
    assert.equal(result.registered, true, result.lines);
    assert.match(result.lines, /could not install.*Minions skill/);
    assert.equal(JSON.parse(await readFile(join(f.user, '.claude.json'), 'utf8')).mcpServers.minions.type, 'http');
    assert.match(await readFile(join(f.user, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.minions/);
  } finally { for (const path of directories) await chmod(path, 0o700); }
});

test('entry detection compares both physical paths and handles Windows aliases without making POSIX case-insensitive', () => {
  const seen = [];
  const realpath = path => { seen.push(path); return path === 'C:\\LINKED~1\\setup.mjs' ? 'C:\\Code Folder\\SETUP.mjs' : 'c:\\code folder\\setup.mjs'; };
  assert.equal(isSetupEntry('C:\\LINKED~1\\setup.mjs', 'c:\\Code Folder\\setup.mjs', { platform: 'win32', realpath }), true);
  assert.deepEqual(seen, ['C:\\LINKED~1\\setup.mjs', 'c:\\Code Folder\\setup.mjs']);
  assert.equal(isSetupEntry('/link/setup.mjs', '/disk/setup.mjs', { platform: 'darwin', realpath: () => '/physical/setup.mjs' }), true);
  assert.equal(isSetupEntry('/A/setup.mjs', '/a/setup.mjs', { platform: 'linux', realpath: path => path }), false);
  assert.equal(isSetupEntry(undefined), false);
  assert.throws(() => isSetupEntry('/unreadable', '/module', { realpath: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
});

test('a symlinked setup command still performs argument validation before setup', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions setup entry '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'linked-setup.mjs');
  await symlink(fileURLToPath(new URL('../engine-setup.mjs', import.meta.url)), script);
  await assert.rejects(execute(process.execPath, [script, '--invalid-option']), error => error.code === 1 && /Unknown option/.test(error.stderr));
});
