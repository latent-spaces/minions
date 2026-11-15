import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectClients, withCodexEntry } from '../src/client-setup.mjs';
import { ensureInstallation, readInstallation } from '../src/service/installation.mjs';
import { reusableConfiguration } from '../src/mcp-configuration.mjs';

async function computer(t) {
  const root = mkdtempSync(join(tmpdir(), 'minions-clients-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'service'), userHome = join(root, 'user');
  await ensureInstallation({ home, site: 'http://127.0.0.1:8787' });
  mkdirSync(join(userHome, '.claude', 'skills', 'minions'), { recursive: true });
  mkdirSync(join(userHome, '.codex'), { recursive: true });
  return { home, userHome, env: {} };
}
// Each site has its own entry name, so another installation's minions entry is never replaced.
const entryName = home => reusableConfiguration({ client: 'claude', home }).name;

test('setup replaces only this site\'s entries, keeps the everyday karma42 install\'s entry, the person\'s settings and edited skill, and writes no key', async t => {
  const where = await computer(t), { userHome } = where, name = entryName(where.home);
  assert.match(name, /^minions-[a-f0-9]{8}$/);
  writeFileSync(join(userHome, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { url: 'x' }, karma42: { url: 'everyday' }, [name]: { command: 'old' } } }));
  writeFileSync(join(userHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  const edited = '---\nname: minions\n---\nmy notes\n';
  writeFileSync(join(userHome, '.claude', 'skills', 'minions', 'SKILL.md'), edited);
  writeFileSync(join(userHome, '.codex', 'config.toml'), `model = "o3"\n\n[mcp_servers.karma42]\nurl = "everyday"\n\n[mcp_servers.${name}]\ncommand = "old"\n\n[mcp_servers.${name}.env]\nA = "1"\n\n[mcp_servers.other]\nurl = "y"\n`);

  const results = connectClients(where);
  assert.deepEqual(results.map(r => [r.client, r.connected]), [['Claude Code', true], ['Codex', true]]);
  const claude = JSON.parse(readFileSync(join(userHome, '.claude.json'), 'utf8'));
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(claude.mcpServers.other, { url: 'x' });
  assert.deepEqual(claude.mcpServers.karma42, { url: 'everyday' });
  assert.equal(claude.mcpServers[name].type, 'http');
  assert.deepEqual(JSON.parse(readFileSync(join(userHome, '.claude', 'settings.json'), 'utf8')).permissions.allow, ['Bash(ls)', `mcp__${name}`]);
  assert.equal(readFileSync(join(userHome, '.claude', 'skills', 'minions', 'SKILL.md'), 'utf8'), edited);
  assert.match(results[0].note, /kept your own Minions skill/);
  const toml = readFileSync(join(userHome, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "o3"/);
  assert.match(toml, /\[mcp_servers\.other\]\nurl = "y"/);
  assert.match(toml, /\[mcp_servers\.karma42\]\nurl = "everyday"/);
  assert.doesNotMatch(toml, /command = "old"|A = "1"/);
  assert.match(toml, /http_headers_helper/);
  assert.match(readFileSync(join(userHome, '.agents', 'skills', 'minions', 'SKILL.md'), 'utf8'), /name: minions/);
  const token = readInstallation(where.home).token;
  for (const file of [join(userHome, '.claude.json'), join(userHome, '.codex', 'config.toml')]) assert(!readFileSync(file, 'utf8').includes(token));
});

test('a minions entry setup does not recognize, or settings it cannot read, are left untouched', async t => {
  const where = await computer(t), { userHome } = where, name = entryName(where.home);
  assert.throws(() => withCodexEntry('[mcp_servers]\nminions = { url = "x" }\n', '[mcp_servers.minions]'), /does not change/);
  writeFileSync(join(userHome, '.claude.json'), '{ not json');
  const original = `[mcp_servers]\n${name} = { url = "x" }\n`;
  writeFileSync(join(userHome, '.codex', 'config.toml'), original);
  assert.deepEqual(connectClients(where).map(r => r.connected), [false, false]);
  assert.equal(readFileSync(join(userHome, '.claude.json'), 'utf8'), '{ not json');
  assert.equal(readFileSync(join(userHome, '.codex', 'config.toml'), 'utf8'), original);
});

test('a Windows config keeps its CRLF line endings', () => {
  assert.equal(withCodexEntry('model = "o3"\r\n\r\n[mcp_servers.minions]\r\ncommand = "old"\r\n', '[mcp_servers.minions]\nurl = "u"'), 'model = "o3"\r\n\r\n[mcp_servers.minions]\r\nurl = "u"\r\n');
});

test('a settings file linked from a dotfiles folder is updated where it lives and stays a link', async t => {
  const where = await computer(t), { userHome } = where, dotfiles = join(userHome, '..', 'dotfiles');
  mkdirSync(dotfiles);
  writeFileSync(join(dotfiles, 'config.toml'), 'model = "o3"\n', { mode: 0o640 });
  try { symlinkSync(join(dotfiles, 'config.toml'), join(userHome, '.codex', 'config.toml')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('creating symbolic links needs extra rights here'); throw error; }
  assert.deepEqual(connectClients(where).find(r => r.client === 'Codex').connected, true);
  assert.ok(lstatSync(join(userHome, '.codex', 'config.toml')).isSymbolicLink());
  assert.match(readFileSync(join(dotfiles, 'config.toml'), 'utf8'), /model = "o3"[\s\S]*\[mcp_servers\.minions-[a-f0-9]{8}\]/);
  if (process.platform !== 'win32') assert.equal(statSync(join(dotfiles, 'config.toml')).mode & 0o777, 0o640);
});

test('a link to a missing settings file is left unchanged', async t => {
  const where = await computer(t), { userHome } = where, missing = join(userHome, '..', 'gone.toml');
  try { symlinkSync(missing, join(userHome, '.codex', 'config.toml')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('creating symbolic links needs extra rights here'); throw error; }
  const codex = connectClients(where).find(r => r.client === 'Codex');
  assert.equal(codex.connected, false);
  assert.match(codex.note, /links to a missing file/);
  assert.ok(lstatSync(join(userHome, '.codex', 'config.toml')).isSymbolicLink());
  assert.equal(existsSync(missing), false);
});

test('Claude settings saved with a byte order mark are still read', async t => {
  const where = await computer(t), { userHome } = where;
  writeFileSync(join(userHome, '.claude', 'settings.json'), '\uFEFF' + JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  assert.equal(connectClients(where).find(r => r.client === 'Claude Code').connected, true);
  assert.deepEqual(JSON.parse(readFileSync(join(userHome, '.claude', 'settings.json'), 'utf8')).permissions.allow, ['Bash(ls)', `mcp__${entryName(where.home)}`]);
});
