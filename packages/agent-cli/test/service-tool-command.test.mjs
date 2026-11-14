// The tool command against a real local MCP service with a synthetic application, and Claude Code registration with
// a fake claude command. Neither touches a live engine, service or Claude Code configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntimeService } from '../src/service/mcp-service.mjs';
import { callServiceTool } from '../src/cli.mjs';
import { registerWithClaudeCode } from '../src/client-setup.mjs';
import { ensureInstallation } from '../src/service/installation.mjs';

const principal = { site: 'http://127.0.0.1:8787', ownerId: 'fixture-owner' };
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const empty = { type: 'object', properties: {}, additionalProperties: false };

async function service(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm tool ')));
  const calls = [];
  const application = {
    listTools: async () => [
      { name: 'get_computer_status', description: 'Synthetic status', inputSchema: empty },
      { name: 'list_my_projects', description: 'Synthetic projects', inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, additionalProperties: false } },
      { name: 'get_project_overview', description: 'Synthetic failure', inputSchema: empty },
    ],
    async callTool(_caller, name, args) {
      calls.push({ name, args });
      if (name === 'get_project_overview') return { ...text({ error: { code: 'engine_unreachable', message: 'The MyLittleSwarm engine isn’t running at http://127.0.0.1:8787. Start it with npm run setup.' } }), isError: true };
      return text(name === 'list_my_projects' ? { projects: [{ id: 'p1', name: 'Garden' }], scope: args.scope ?? null } : {});
    },
  };
  const running = await startRuntimeService({ controllers: { health: async () => ({ ready: true }) }, principal, application, home });
  t.after(async () => { await running.close().catch(() => {}); await rm(home, { recursive: true, force: true }); });
  return { home, calls, running };
}

function capture() {
  const lines = { out: [], err: [] };
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line) };
}

test('tool calls the running service with its own credential and prints the JSON result', { timeout: 20000 }, async t => {
  const { home, calls } = await service(t);
  let c = capture();
  assert.equal(await callServiceTool({ 'state-dir': home }, ['list_my_projects', '{"scope":"owned"}'], c.out, c.err), 0);
  assert.deepEqual(JSON.parse(c.lines.out[0]), { projects: [{ id: 'p1', name: 'Garden' }], scope: 'owned' });
  assert.deepEqual(calls.at(-1), { name: 'list_my_projects', args: { scope: 'owned' } });

  c = capture();
  assert.equal(await callServiceTool({ 'state-dir': home, list: true }, [], c.out, c.err), 0);
  assert.deepEqual(JSON.parse(c.lines.out[0]).map(tool => tool.name), ['get_computer_status', 'list_my_projects', 'get_project_overview']);
  c = capture();
  assert.equal(await callServiceTool({ 'state-dir': home, list: true }, ['list_my_projects'], c.out, c.err), 0);
  assert.equal(JSON.parse(c.lines.out[0]).inputSchema.properties.scope.type, 'string');

  // A tool error goes to stderr with a non-zero exit, keeping the service's own message.
  c = capture();
  assert.equal(await callServiceTool({ 'state-dir': home }, ['get_project_overview'], c.out, c.err), 1);
  assert.match(c.lines.err[0], /engine isn’t running at http:\/\/127\.0\.0\.1:8787/);

  c = capture();
  assert.equal(await callServiceTool({ 'state-dir': home }, ['list_my_projects', '[1]'], c.out, c.err), 2);
  assert.match(c.lines.err[0], /one JSON object/);
});

test('tool says the local service did not answer when it is not running', { timeout: 20000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm tool ')));
  try {
    const c = capture();
    assert.equal(await callServiceTool({ 'state-dir': home }, ['list_my_projects'], c.out, c.err), 1);
    assert.match(c.lines.err[0], /local service didn’t answer.*npm run setup/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Claude Code registration adds the mlswarm entry once, through the claude command, replaces one with an old address and removes the retired per-engine ones', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mlswarm register ')));
  try {
    await ensureInstallation({ home, site: principal.site });
    // A separate user folder: registration reads ~/.claude.json and allows the tools in ~/.claude/settings.json.
    const userHome = join(home, 'user');
    await mkdir(join(userHome, '.claude'), { recursive: true });
    await writeFile(join(userHome, '.claude.json'), JSON.stringify({ mcpServers: { 'mlswarm-b1a61bf2': {}, karma42: {} } }));
    await writeFile(join(userHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)', 'mcp__mlswarm-b1a61bf2'] } }));
    const registry = new Map(), runs = [];
    // A fake claude command: the real one is never run.
    const run = args => {
      runs.push(args);
      const [, action] = args;
      if (action === 'get') return registry.has(args[2]) ? { status: 0, stdout: `${args[2]}:\n  URL: ${JSON.parse(registry.get(args[2])).url}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'No MCP server found' };
      if (action === 'remove') {
        registry.delete(args.at(-1));
        // As the real command does, removing a user entry drops it from ~/.claude.json.
        const file = join(userHome, '.claude.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
        delete saved.mcpServers[args.at(-1)]; writeFileSync(file, JSON.stringify(saved));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (action === 'add-json') { registry.set(args[4], args[5]); return { status: 0, stdout: '', stderr: '' }; }
      throw new Error('unexpected');
    };
    const first = registerWithClaudeCode({ home, userHome, run });
    assert.equal(first.status, 'registered'); assert.equal(first.name, 'mlswarm');
    assert.deepEqual(runs.find(args => args[1] === 'remove'), ['mcp', 'remove', '--scope', 'user', 'mlswarm-b1a61bf2']);
    assert.deepEqual(JSON.parse(await readFile(join(userHome, '.claude', 'settings.json'), 'utf8')).permissions.allow, ['Bash(ls)', 'mcp__mlswarm']);
    assert.deepEqual(runs.at(-1).slice(0, 5), ['mcp', 'add-json', '--scope', 'user', first.name]);
    const entry = JSON.parse(registry.get(first.name));
    assert.equal(entry.type, 'http'); assert.match(entry.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/); assert.match(entry.headersHelper, /headers\.mjs/);
    const count = runs.length;
    assert.equal(registerWithClaudeCode({ home, userHome, run }).status, 'current');
    assert.equal(runs.length, count + 1);
    registry.set(first.name, JSON.stringify({ ...entry, url: 'http://127.0.0.1:1/mcp' }));
    assert.equal(registerWithClaudeCode({ home, userHome, run }).status, 'registered');
    assert.deepEqual(runs.findLast(args => args[1] === 'remove'), ['mcp', 'remove', '--scope', 'user', first.name]);
    assert.equal(JSON.parse(registry.get(first.name)).url, entry.url);
    assert.equal(registerWithClaudeCode({ home, userHome, run: () => null }).status, 'missing');
    assert.throws(() => registerWithClaudeCode({ home, userHome, run: args => args[1] === 'get' ? { status: 1, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'bad entry' } }), /add-json failed: bad entry/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
