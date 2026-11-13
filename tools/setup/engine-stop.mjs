// `npm run stop`: gracefully stops the background engine that `npm run setup` started, on every platform. It asks the
// engine CLI's `stop`, which proves itself with this owner file's key; nothing else is stopped or removed.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, engineEnvironment, engineHome, enginePaths, enginePort, requireNode24, savedPort } from './engine-plan.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

function main() {
  requireNode24(process.version);
  const home = engineHome({ env: process.env, userHome: homedir(), platform: process.platform });
  const files = enginePaths(home);
  let settings = null;
  try { settings = readFileSync(files.settingsFile, 'utf8'); } catch {}
  const port = enginePort(process.env, savedPort(settings));
  const env = engineEnvironment(childEnvironment(process.env, { nodeDirectory: dirname(process.execPath) }), { home, port });
  const child = spawn(process.execPath, [join(repository, 'apps/server/dist/self-hosted-main.js'), 'stop', '--url', `http://127.0.0.1:${port}`],
    { cwd: repository, env, stdio: 'inherit', shell: false, windowsHide: true });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
