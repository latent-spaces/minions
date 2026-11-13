import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuredWebsiteOrigin, selfHostedWebsiteOrigin, trustedWebsiteUrl } from '../src/website-origin.mjs';
import { defaultSiteStateHome } from '../src/site-state.mjs';
import { workspaceHome, projectFolder } from '../src/layout.mjs';
import { sessionId } from '../src/session.mjs';

const site = 'https://swarm.example:8443';
const enrolled = { MLSWARM_SELF_HOSTED_ORIGIN: site };

test('only the explicitly enrolled HTTPS origin joins the existing website policy', () => {
  assert.equal(trustedWebsiteUrl(`${site}/?view=projects`, {}), false);
  assert.equal(trustedWebsiteUrl(`${site}/?view=projects`, enrolled), true);
  for (const url of ['https://swarm.example', 'https://swarm.example:8444', 'https://swarm.example.evil:8443',
    'https://other.example:8443', 'http://swarm.example:8443', 'https://user:secret@swarm.example:8443']) {
    assert.equal(trustedWebsiteUrl(url, enrolled), false, url);
  }
  for (const url of ['http://127.0.0.1:8787', 'http://127.0.0.1:5173']) {
    assert.equal(trustedWebsiteUrl(url, enrolled), true, url);
  }
  // Enrolling another origin never brings back the live site.
  for (const url of ['https://karma42.ai', 'https://karma42-launch.web.app']) {
    assert.equal(trustedWebsiteUrl(url, enrolled), false, url);
  }
});

test('enrollment refuses noncanonical URLs and fails closed', () => {
  for (const value of ['', 'http://swarm.example', `${site}/`, `${site}/path`, `${site}?token=secret`, `${site}#fragment`,
    'https://user:secret@swarm.example', 'https://SWARM.example', 'https://swarm.example:443',
    'https://swarm.example.', 'https://*.example', 'https://karma42.ai', 'https://karma42-launch.web.app']) {
    const env = { MLSWARM_SELF_HOSTED_ORIGIN: value };
    assert.throws(() => selfHostedWebsiteOrigin(env), /canonical HTTPS origin/, value);
    assert.throws(() => configuredWebsiteOrigin(env), /canonical HTTPS origin/, value);
    assert.throws(() => trustedWebsiteUrl(site, env), /canonical HTTPS origin/, value);
  }
  assert.equal(selfHostedWebsiteOrigin({}), null);
  assert.equal(configuredWebsiteOrigin({}), 'http://127.0.0.1:8787');
  assert.equal(configuredWebsiteOrigin(enrolled), site);
  assert.equal(configuredWebsiteOrigin({ ...enrolled, MLSWARM_SITE_URL: site }), site);
  for (const other of ['http://127.0.0.1:8787', 'http://127.0.0.1:5173', 'https://other.example']) {
    const env = { ...enrolled, MLSWARM_SITE_URL: other };
    assert.throws(() => configuredWebsiteOrigin(env), /must match/);
    assert.throws(() => defaultSiteStateHome('service', env), /must match/);
    assert.throws(() => workspaceHome(env), /must match/);
    assert.throws(() => trustedWebsiteUrl(site, env), /must match/);
  }
});

test('independent sites use separate default private state without migrating hosted state', () => {
  const userHome = join(tmpdir(), 'synthetic-user');
  const hosted = defaultSiteStateHome('service', {}, userHome);
  const first = defaultSiteStateHome('service', enrolled, userHome);
  const other = defaultSiteStateHome('service', { MLSWARM_SELF_HOSTED_ORIGIN: 'https://other.example' }, userHome);
  assert.equal(hosted, join(userHome, '.mlswarm', 'service'));
  assert.notEqual(first, hosted);
  assert.notEqual(first, other);
  assert.equal(first, defaultSiteStateHome('service', enrolled, userHome));
  assert.equal(first.replace(/service$/, 'mcp'), defaultSiteStateHome('mcp', enrolled, userHome));
  assert.throws(() => defaultSiteStateHome('unknown', enrolled, userHome));
  // Connection IDs already include the origin through the full service URL.
  assert.notEqual(sessionId(`${site}/p/${'a'.repeat(64)}`, 'agent'), sessionId(`http://127.0.0.1:8787/p/${'a'.repeat(64)}`, 'agent'));
});


test('same project names and IDs on independent sites receive separate default workspaces', () => {
  const userHome = join(tmpdir(), 'synthetic-user');
  const hosted = workspaceHome({}, userHome);
  const first = workspaceHome(enrolled, userHome);
  const other = workspaceHome({ MLSWARM_SELF_HOSTED_ORIGIN: 'https://other.example' }, userHome);
  assert.equal(hosted, join(userHome, 'mlswarm'));
  assert.notEqual(first, hosted);
  assert.notEqual(first, other);
  const folder = root => projectFolder(root, 'a'.repeat(64), 'Same Project', []);
  assert.notEqual(folder(first), folder(hosted));
  assert.notEqual(folder(first), folder(other));
  assert.match(defaultSiteStateHome('service', enrolled, userHome), /instances[/\\][a-f0-9]{24}[/\\]service$/);
});

test('enrollment refuses subdomains of the live site too', () => {
  for (const value of ['https://www.karma42.ai', 'https://app.karma42.ai', 'https://preview.karma42-launch.web.app']) {
    assert.throws(() => selfHostedWebsiteOrigin({ MLSWARM_SELF_HOSTED_ORIGIN: value }), /canonical HTTPS origin/, value);
  }
  assert.equal(selfHostedWebsiteOrigin({ MLSWARM_SELF_HOSTED_ORIGIN: 'https://notkarma42.ai' }), 'https://notkarma42.ai');
});

test('a project folder never reuses a folder another project already holds, also after the ID suffix', () => {
  const projects = join('/r', 'projects'), id = 'abc123' + 'f'.repeat(58);
  const placed = [{ projectId: 'b'.repeat(64), folder: join(projects, 'tools') }, { projectId: 'c'.repeat(64), folder: join(projects, 'tools-abc123') }];
  const folder = projectFolder('/r', id, 'Tools', placed);
  assert.equal(placed.some(p => p.folder === folder), false, folder);
});
