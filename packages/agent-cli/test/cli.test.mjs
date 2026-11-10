import test from 'node:test';
import assert from 'node:assert/strict';
import { main, HELP, specs } from '../src/cli.mjs';
const run = async args => { const out = [], err = []; return { exit: await main(args, value => out.push(value), value => err.push(value)), out: out.join('\n'), err: err.join('\n') }; };
test('setup refuses a conflicting explicit site before saving approvals or contacting a server', async t => {
  const previous = process.env.MLSWARM_SELF_HOSTED_ORIGIN;
  process.env.MLSWARM_SELF_HOSTED_ORIGIN = 'https://swarm.example';
  t.after(() => {
    if (previous === undefined) delete process.env.MLSWARM_SELF_HOSTED_ORIGIN;
    else process.env.MLSWARM_SELF_HOSTED_ORIGIN = previous;
  });
  const result = await run(['setup', '--site', 'http://127.0.0.1:8787']);
  assert.notEqual(result.exit, 0);
  assert.match(result.err, /--site must match MLSWARM_SELF_HOSTED_ORIGIN/);
  assert.equal(result.out, '');
});
test('retired commands and secret-bearing, duplicate or unknown arguments fail without echo', async () => {
  for (const command of ['connect', 'start', 'browser-connect', 'browser-prepare', 'session-connect', 'session-serve', 'mcp-serve', 'doctor', 'preview']) assert.equal((await run([command])).exit, 2);
  for (const args of [ ['mcp-config', '--client', 'claude', '--token', 'PRIVATE_SECRET'], ['mcp-serve', '--provider', 'PRIVATE_SECRET'], ['mcp-config', '--client', 'claude', '--client', 'codex'], ['mcp-serve', '--state-dir', 'relative'] ]) {
    const result = await run(args); assert.equal(result.exit, 2); assert.ok(!result.err.includes('PRIVATE_SECRET'));
  }
});
test('every option the help names for a command is one that command accepts', () => {
  const missing = [];
  let commands = [];
  for (const line of HELP.split('\n')) {
    const head = /^ {2}(\S.*?)(?: \[| --|$)/.exec(line);
    if (head) commands = head[1].split(/ \/ |\|/).filter(name => Object.hasOwn(specs, name));
    if (!/^ {2}\S/.test(line) && !/^ {6}/.test(line)) commands = [];
    const only = /For (\S+) only:/.exec(line)?.[1];
    for (const option of line.matchAll(/--([a-z][a-z-]*)/g))
      for (const command of only ? [only] : commands) if (!Object.hasOwn(specs[command], option[1])) missing.push(`${command} --${option[1]}`);
  }
  assert.deepEqual(missing, []);
});
