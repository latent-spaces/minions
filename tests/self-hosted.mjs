// Build and exercise the standalone entry with fresh synthetic data and no models.
import { createRequire } from 'node:module';
import { dirname, delimiter, resolve } from 'node:path';
import { executable, repository, runProcess, testEnvironment } from './support/disposable-session.mjs';

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Standalone acceptance requires Node.js 24 or newer.');
  if (process.argv.length !== 2) throw new Error('Use npm run test:self-hosted without additional arguments.');
  const env = { ...testEnvironment(), MINIONS_TEST_ENGINE_BUILD: '1' };
  // Keep compiler, bundler, test workers and engine children on the selected Node, including Windows.
  const searchKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const searchPath = searchKey ? env[searchKey] : '';
  if (searchKey) delete env[searchKey];
  env.PATH = `${dirname(process.execPath)}${searchPath ? delimiter + searchPath : ''}`;
  const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const vite = resolve(dirname(webRequire.resolve('vite/package.json')), webRequire('vite/package.json').bin.vite);
  const steps = [
    ['contracts', [executable('typescript', 'tsc'), '-p', 'packages/contracts/tsconfig.json']],
    ['server', [executable('typescript', 'tsc'), '-p', 'apps/server/tsconfig.build.json']],
    ['viewer types', [executable('typescript', 'tsc'), '-p', 'apps/web/tsconfig.json', '--noEmit']],
    ['self-hosted viewer', [vite, 'build', 'apps/web']],
  ];
  for (const [label, args] of steps) {
    console.info(`Standalone acceptance: building ${label} with ${process.version}.`);
    const code = await runProcess(process.execPath, args, { cwd: repository, env });
    if (code) return code;
  }
  console.info('Standalone acceptance: testing compiled engine with fresh synthetic data; no models.');
  return runProcess(process.execPath, [executable('vitest', 'vitest'), 'run',
    'test/self-hosted-config.test.ts', 'test/self-hosted-paths.test.ts', 'test/self-hosted-files.test.ts',
    'test/self-hosted-lock.test.ts', 'test/self-hosted-initialize.test.ts', 'test/self-hosted-runtime.test.ts',
    'test/self-hosted-owner-session.test.ts', 'test/self-hosted-engine.test.ts', 'test/self-hosted-http-flow.test.ts',
    'test/standalone-smoke.test.ts'], { cwd: new URL('../apps/server/', import.meta.url), env: { ...env, NODE_ENV: 'test' } });
}

main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
