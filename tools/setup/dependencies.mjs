import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './engine-control.mjs';

const receiptName = '.minions-setup.json';
const hash = text => createHash('sha256').update(text).digest('hex');

function installation(cwd) {
  try {
    const lockfile = readFileSync(join(cwd, 'package-lock.json'), 'utf8');
    const installed = readFileSync(join(cwd, 'node_modules/.package-lock.json'), 'utf8');
    const packages = Object.keys(JSON.parse(installed).packages);
    // npm ls tolerates missing optional packages, including the platform binaries we need.
    if (!packages.every(name => statSync(join(cwd, name, 'package.json')).isFile())) return null;
    return { version: 1, lockfile: hash(lockfile), installed: hash(installed),
      node: process.version, platform: process.platform, arch: process.arch };
  } catch { return null; }
}

function matchesReceipt(cwd, current) {
  try {
    const receipt = JSON.parse(readFileSync(join(cwd, 'node_modules', receiptName), 'utf8'));
    return current !== null && Object.entries(current).every(([key, value]) => receipt[key] === value);
  } catch { return false; }
}

/** Source builds need dev tools and the optional platform binaries used by esbuild and Sharp. */
export async function installDependencies({ cwd, env, npm, info = console.info }) {
  // Only our successful full installs can be reused. External npm installs/prunes change the hidden lockfile;
  // npm ci also removes this receipt. An old timestamp alone cannot establish that optional packages exist.
  const complete = matchesReceipt(cwd, installation(cwd)) && spawnSync(process.execPath,
    [npm, 'ls', '--all', '--include=dev', '--include=optional', '--parseable'],
    { cwd, env, stdio: 'ignore', shell: false, windowsHide: true, timeout: 30_000 }).status === 0;
  if (complete) {
    info('Dependencies are installed and match package-lock.json; skipping npm ci.');
    return;
  }
  info('Running npm ci with build dependencies; this downloads the dependencies the first time and can take a few minutes on a slow connection.');
  await run('npm ci', [npm, 'ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'], { cwd, env, quiet: true });
  const current = installation(cwd);
  if (current !== null) writeFileSync(join(cwd, 'node_modules', receiptName), `${JSON.stringify(current)}\n`);
}
