import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './engine-control.mjs';
import { needsInstall } from './engine-plan.mjs';

const modified = file => { try { return statSync(file).mtimeMs; } catch { return null; } };

/** Setup builds from source, so even a production environment needs the development dependencies. */
export async function installDependencies({ cwd, env, npm, info = console.info }) {
  const changed = needsInstall({ hiddenLockfile: modified(join(cwd, 'node_modules/.package-lock.json')),
    lockfile: modified(join(cwd, 'package-lock.json')) });
  // A recent hidden lockfile can also describe an omitted-dev or subsequently damaged install.
  const complete = !changed && spawnSync(process.execPath, [npm, 'ls', '--all', '--include=dev', '--parseable'],
    { cwd, env, stdio: 'ignore', shell: false, windowsHide: true, timeout: 30_000 }).status === 0;
  if (complete) {
    info('Dependencies are installed and match package-lock.json; skipping npm ci.');
    return;
  }
  info('Running npm ci with build dependencies; this downloads the dependencies the first time and can take a few minutes on a slow connection.');
  await run('npm ci', [npm, 'ci', '--include=dev', '--no-audit', '--no-fund'], { cwd, env, quiet: true });
}
