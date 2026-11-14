import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WEBSITE_ORIGIN, trustedWebsiteUrl } from '../src/website-origin.mjs';
import { createDiscovery } from '../src/discovery.mjs';
import { ownerOrigin } from '../src/owner-client.mjs';
import { openPage } from '../src/system.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureInstallation, readInstallation } from '../src/service/installation.mjs';
import { reusableConfiguration, renderReusableConfiguration } from '../src/mcp-configuration.mjs';
import { formatGitHubAttribution } from '../src/github-attribution.mjs';
import { OWNER_TOOLS } from '../src/owner-tools.mjs';

test('the same transport policy accepts the local engine and loopback sites and refuses the live site and foreign destinations', () => {
  assert.equal(DEFAULT_WEBSITE_ORIGIN, 'http://127.0.0.1:8787');
  for (const site of [DEFAULT_WEBSITE_ORIGIN, 'http://127.0.0.1:5173', 'http://localhost:5174']) {
    assert.equal(trustedWebsiteUrl(site), true, site);
    assert.equal(ownerOrigin(site), new URL(site).origin);
    assert.doesNotThrow(() => createDiscovery({ site }));
  }
  // This repository no longer connects to the live site (owner decision, 10 November 2026).
  for (const site of ['https://karma42.ai', 'https://karma42-launch.web.app', 'https://karma42-beta.web.app', 'https://example.com', 'https://karma42-launch.web.app.evil.test', 'https://user:secret@karma42-launch.web.app',
    'http://karma42-launch.web.app', 'https://karma42-launch.web.app:444', 'https://127.0.0.1:5173', 'http://localhost.evil.test:5173']) {
    assert.equal(trustedWebsiteUrl(site), false, site);
    assert.throws(() => ownerOrigin(site));
    assert.throws(() => createDiscovery({ site }));
    assert.equal(openPage(`${site}/?view=projects`, { platform: 'darwin', env: {}, spawnImpl: () => assert.fail('A foreign page must not launch a browser.') }), false);
  }
  for (const path of ['/path', '/?token=private', '/#fragment']) {
    assert.throws(() => ownerOrigin(`${DEFAULT_WEBSITE_ORIGIN}${path}`));
    assert.throws(() => createDiscovery({ site: `${DEFAULT_WEBSITE_ORIGIN}${path}` }));
  }
});

test('MyLittleSwarm pages use native browser opening without shell interpolation on each platform', () => {
  const url = 'http://127.0.0.1:12345/?project=' + 'a'.repeat(64) + '#synthetic';
  for (const [platform, expected] of [['darwin','open'],['win32','rundll32'],['linux','xdg-open']]) {
    let called;
    const opened = openPage(url, { platform, env: { DISPLAY: ':synthetic' }, spawnImpl: (command, args, options) => { called={command,args,options}; return {on(){},unref(){}}; } });
    assert.equal(opened,true); assert.equal(called.command,expected); assert.equal(called.args.at(-1),url); assert.equal(called.options.shell,undefined);
  }
  assert.equal(openPage(url,{platform:'linux',env:{SSH_CONNECTION:'synthetic'},spawnImpl:()=>assert.fail('Remote shells keep the URL for manual opening.')}),false);
});

test('enrolled origins work across setup, browser, discovery and attribution without rebinding saved installations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mlswarm self-host origin-'));
  const previous = process.env.MLSWARM_SELF_HOSTED_ORIGIN;
  const previousSite = process.env.MLSWARM_SITE_URL;
  const site = 'https://swarm.example:8443';
  try {
    process.env.MLSWARM_SELF_HOSTED_ORIGIN = site;
    delete process.env.MLSWARM_SITE_URL;
    assert.equal(ownerOrigin(), site);
    assert.doesNotThrow(() => createDiscovery());
    const installation = await ensureInstallation({ home });
    assert.equal(installation.site, site);
    const configs = ['claude', 'codex', 'other'].map(client => reusableConfiguration({ client, home }));
    const name = configs[0].name;
    assert.equal(name, 'mlswarm');
    for (const tool of OWNER_TOOLS) assert.ok(`mcp__${name}__${tool.name}`.length <= 64, tool.name);
    for (const config of configs) {
      assert.equal(config.site, site);
      assert.equal(config.name, name);
      assert.deepEqual(Object.keys(config.generic.mcpServers), [name]);
      assert.ok(config.toml.startsWith(`[mcp_servers.${name}]`));
      const printed = renderReusableConfiguration(config);
      if (config.client === 'claude') {
        assert.ok(printed.includes(`mcp__${name}`));
        if (config.command) assert.ok(config.command.includes(`'${name}'`));
      }
    }
    for (const platform of ['darwin', 'win32', 'linux']) {
      let opened;
      assert.equal(openPage(`${site}/?view=projects`, { platform, env: { DISPLAY: ':synthetic' },
        spawnImpl: (_command, args, options) => { opened = args.at(-1); assert.equal(options.shell, undefined); return { on() {}, unref() {} }; } }), true);
      assert.equal(opened, `${site}/?view=projects`);
      assert.equal(openPage(`${site}/unrelated`, { platform, env: { DISPLAY: ':synthetic' },
        spawnImpl: () => assert.fail('Only supported MyLittleSwarm pages may open.') }), false);
    }
    const attribution = formatGitHubAttribution({ projectId: 'a'.repeat(64),
      agent: { id: 'synthetic-agent', name: 'Agent' }, participant: { id: 'synthetic-person', name: 'Member' } });
    assert.ok(attribution.includes(`${site}/`));
    assert.ok(!attribution.includes(`${DEFAULT_WEBSITE_ORIGIN}/`));
    await assert.rejects(ensureInstallation({ home, site: DEFAULT_WEBSITE_ORIGIN }), /different website/);
    assert.deepEqual(readInstallation(home), installation);
    delete process.env.MLSWARM_SELF_HOSTED_ORIGIN;
    assert.throws(() => readInstallation(home), /requires the MyLittleSwarm website/);
    process.env.MLSWARM_SELF_HOSTED_ORIGIN = site;
    assert.deepEqual(readInstallation(home), installation);
  } finally {
    if (previous === undefined) delete process.env.MLSWARM_SELF_HOSTED_ORIGIN;
    else process.env.MLSWARM_SELF_HOSTED_ORIGIN = previous;
    if (previousSite === undefined) delete process.env.MLSWARM_SITE_URL;
    else process.env.MLSWARM_SITE_URL = previousSite;
    await rm(home, { recursive: true, force: true });
  }
});
