import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reusableConfiguration, renderReusableConfiguration } from '../src/mcp-configuration.mjs';
import { ensureInstallation, readInstallation } from '../src/service/installation.mjs';

async function installation(t) {
  const home = mkdtempSync(join(tmpdir(), 'minions-configuration-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await ensureInstallation({ home, site: 'http://127.0.0.1:8787' });
  return home;
}

test('Claude and Codex registration share HTTP without exposing installation credentials', async t => {
  const home = await installation(t), privateRecord = readInstallation(home);
  const claude = reusableConfiguration({ client: 'claude', home });
  const codex = reusableConfiguration({ client: 'codex', home });
  // One minions entry per computer (owner decision, 14 November 2026).
  assert.equal(claude.name, 'minions');
  assert.equal(codex.name, claude.name);
  assert.equal(claude.entry.url, codex.entry.url);
  assert.equal(claude.entry.type, 'http');
  assert.equal(claude.entry.headersHelper, codex.entry.http_headers_helper);
  if (process.platform === 'win32') {
    // Windows registration deliberately uses a JSON settings entry, not a shell command.
    assert.equal(claude.command, null);
    const instructions = renderReusableConfiguration(claude);
    assert.match(instructions, /on Windows, use the JSON entry in the settings editor/);
    assert.ok(instructions.includes(JSON.stringify(claude.generic, null, 2)));
    assert.deepEqual(claude.generic.mcpServers[claude.name], claude.entry);
  } else assert.match(claude.command, /add-json/);
  assert.match(codex.toml, /http_headers_helper = /);
  for (const config of [claude, codex, reusableConfiguration({ client: 'other', home })]) {
    assert.equal(config.site, 'http://127.0.0.1:8787');
    const printed = JSON.stringify(config) + renderReusableConfiguration(config);
    assert(!printed.includes(privateRecord.token));
    assert(!printed.includes('mcp-serve'));
    assert(!Object.hasOwn(config.entry, 'args'));
    assert(!Object.hasOwn(config.entry, 'env'));
    assert.match(renderReusableConfiguration(config), /never stop or restart running agents/);
  }
});
