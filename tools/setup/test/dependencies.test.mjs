import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installDependencies } from '../dependencies.mjs';
import { childEnvironment } from '../engine-plan.mjs';
import { npmCli } from '../npm-cli.mjs';

// Local file dependencies keep this real npm check offline and independent of the workspace install.
async function fixture(check) {
  const cwd = mkdtempSync(join(tmpdir(), 'minions dependency setup '));
  try {
    mkdirSync(join(cwd, 'tool'));
    writeFileSync(join(cwd, 'tool/package.json'), JSON.stringify({ name: 'setup-build-tool', version: '1.0.0', main: 'index.cjs' }));
    writeFileSync(join(cwd, 'tool/index.cjs'), 'module.exports = true;');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'setup-fixture', version: '1.0.0',
      scripts: { prepare: 'node check.cjs' }, devDependencies: { 'setup-build-tool': 'file:tool' } }));
    writeFileSync(join(cwd, 'check.cjs'), "require('setup-build-tool'); require('node:fs').writeFileSync('built', 'ok');");
    const env = childEnvironment({ ...process.env, NODE_ENV: 'production', npm_config_omit: 'dev', npm_config_offline: 'true',
      npm_config_cache: join(cwd, 'cache'), npm_config_ignore_scripts: 'false' }, { nodeDirectory: dirname(process.execPath) });
    const npm = npmCli();
    const command = args => {
      const result = spawnSync(process.execPath, [npm, ...args, '--no-audit', '--no-fund'], { cwd, env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    };
    command(['install', '--package-lock-only', '--ignore-scripts']);
    await check({ cwd, env, npm, command });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('source setup includes build dependencies despite npm omit=dev, then reuses a complete install', () => fixture(async options => {
  const messages = [];
  const install = () => installDependencies({ ...options, info: message => messages.push(message) });
  await install();
  assert.equal(existsSync(join(options.cwd, 'built')), true, 'prepare can use its dev dependency');
  await install();
  assert.match(messages.at(-1), /skipping npm ci/);
}));

test('setup repairs a recent omitted-dev install and a subsequently missing package', () => fixture(async options => {
  options.command(['ci', '--ignore-scripts']);
  assert.equal(existsSync(join(options.cwd, 'node_modules/setup-build-tool')), false);
  // Ensure the timestamp optimization admits this install; the dependency check must reject it.
  utimesSync(join(options.cwd, 'package-lock.json'), new Date(1000), new Date(1000));
  const messages = [];
  const install = () => installDependencies({ ...options, info: message => messages.push(message) });
  await install();
  assert.equal(existsSync(join(options.cwd, 'built')), true);
  rmSync(join(options.cwd, 'node_modules/setup-build-tool'), { recursive: true, force: true });
  await install();
  assert.equal(existsSync(join(options.cwd, 'node_modules/setup-build-tool')), true);
  assert.equal(messages.filter(message => /Running npm ci/.test(message)).length, 2);
}));
