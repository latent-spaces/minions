// Owns a fresh disposable test session (its own SQLite store and media folder). No models or saved-state import/export.
import { join } from 'node:path';
import { executable, repository, runProcess, testEnvironment, withDisposableSession } from './support/disposable-session.mjs';

const server = join(repository, 'apps/server');
async function main() {
  const args = process.argv.slice(2);
  const connector = join(repository, 'packages/agent-cli');
  const code = await runProcess(process.execPath, [join(connector, 'scripts/build.mjs')], { cwd: connector, env: testEnvironment() });
  if (code) return code;
  // Test files run serially and share the session's store with the processes a test starts.
  return withDisposableSession(() => [process.execPath, executable('vitest', 'vitest'), 'run', ...args], { cwd: server });
}
main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
