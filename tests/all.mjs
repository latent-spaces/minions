// Tracked validation entrypoint. Each suite gets its own log; failures never hide later results.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { testEnvironment } from './support/disposable-session.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const bin = (pkg, name) => {
  const manifest = require.resolve(`${pkg}/package.json`);
  const metadata = require(manifest);
  return resolve(dirname(manifest), typeof metadata.bin === 'string' ? metadata.bin : metadata.bin[name]);
};
const step = (name, args, cwd = '.', needs = []) => ({ name, args, cwd: join(repository, cwd), needs });
export function validationSteps(profile = 'full', platform = process.platform) {
  if (!['full', 'portable'].includes(profile)) throw new Error('Use --profile full or --profile portable.');
  if (profile === 'full' && platform === 'win32') throw new Error('The full profile includes POSIX-only subprocess and release checks. Use --profile portable for native Windows checks; run the full suite on macOS/Linux.');
  const steps = [
    step('contracts-build', [bin('typescript', 'tsc'), '-p', 'tsconfig.json'], 'packages/contracts'),
    step('connector-build', ['scripts/build.mjs'], 'packages/agent-cli', ['contracts-build']),
  ];
  if (profile === 'portable') return [...steps,
    step('connector-native', ['--test', '--test-concurrency=1',
      'test/runtime-store-ownership.test.mjs', 'test/website-origin.test.mjs',
      'test/mcp-configuration.test.mjs', 'test/local-permissions.test.mjs',
      'test/client-setup.test.mjs', 'test/skill-bundle.test.mjs', 'test/worker-guidance.test.mjs','test/run-journal.test.mjs',
      'test/deadline-extension.test.mjs', 'test/runtime-mixed-providers.test.mjs',
      'test/windows-command.test.mjs', 'test/windows-supervision.test.mjs',
      'test/native-smoke-options.test.mjs', 'test/native-smoke-coordination.test.mjs', 'test/native-smoke-report.test.mjs',
      'test/native-smoke-harness.test.mjs',
      'test/context-measurement.test.mjs', 'test/turn-context.test.mjs', 'test/context-overhead-capture.test.mjs',
      'test/runtime-owner-participation-controls.test.mjs', 'test/runtime-participation-routing.test.mjs',
      'test/runtime-installation.test.mjs',
      'test/deferred-sends.test.mjs', 'test/deferred-send-length.test.mjs',
      'test/setup-repeat.test.mjs', 'test/setup-hint.test.mjs', 'test/codex-entry.test.mjs',
      'test/repository-access.test.mjs', 'test/setup-github.test.mjs', 'test/queued-run-tools.test.mjs',
      // Windows skips the two symlink-only merge-policy cases; ownership tests retain their native gates.
      'test/codex-merge-policy.test.mjs', 'test/provider-limits.test.mjs',
      'test/work-controller.test.mjs', 'test/runtime-worker-operations.test.mjs',
      'test/runtime-participation.test.mjs', 'test/native-task-guidance.test.mjs'], 'packages/agent-cli', ['connector-build']),
    step('setup-tools', ['--test', 'test/*.test.mjs'], 'tools/setup'),
    step('tool-safety', ['--test', 'tests/support/api-readiness.test.mjs', 'tests/support/owned-process-tree.test.mjs', 'tests/all.test.mjs']),
  ];
  return [...steps,
    step('connector-tests', ['--test', '--test-concurrency=1', 'test/*.test.mjs'], 'packages/agent-cli', ['connector-build']),
    step('test-guards', ['--test', 'tests/support/*.test.mjs', 'tests/all.test.mjs']),
    step('setup-tools', ['--test', 'test/*.test.mjs'], 'tools/setup'),
    step('web-tests', ['--import', 'tsx', '--test', 'test/*.test.ts'], 'apps/web', ['contracts-build']),
    step('web-types', [bin('typescript', 'tsc'), '--noEmit'], 'apps/web', ['contracts-build']),
    step('web-build', [bin('vite', 'vite'), 'build'], 'apps/web', ['contracts-build']),
    step('backend-types', [bin('typescript', 'tsc'), '--noEmit'], 'apps/server', ['contracts-build']),
    step('backend-build', [bin('typescript', 'tsc'), '-p', 'tsconfig.build.json'], 'apps/server', ['contracts-build']),
    // This launcher creates its own disposable test session and store.
    step('backend-tests', ['tests/run.mjs'], '.', ['connector-build']),
  ];
}

export async function runSuites(steps, { logDirectory, env = testEnvironment(), onResult = console.info, signal } = {}) {
  await mkdir(logDirectory, { recursive: true });
  // Descendant npm/tsx launchers must use the same pinned Node as this entrypoint.
  // Windows environment keys are case insensitive; emit one PATH key.
  const childEnv = { ...env };
  const sourcePath = Object.keys(process.env).sort().find(key => key.toLowerCase() === 'path');
  const selectedPath = Object.keys(childEnv).sort().find(key => key.toLowerCase() === 'path');
  const searchPath = selectedPath ? childEnv[selectedPath] : process.env[sourcePath];
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'path') delete childEnv[key];
  childEnv.PATH = `${dirname(process.execPath)}${searchPath ? delimiter + searchPath : ''}`;
  const results = [];
  for (const suite of steps) {
    const log = join(logDirectory, `${suite.name}.log`);
    const blocked = suite.needs?.filter(name => !results.some(result => result.name === name && result.status === 'passed')) ?? [];
    if (signal?.aborted || blocked.length) {
      const result = { name: suite.name, status: 'skipped', reason: signal?.aborted ? 'Interrupted' : `Failed prerequisite: ${blocked.join(', ')}`, log };
      await writeFile(log, `${result.reason}\n`); results.push(result); onResult(result); continue;
    }
    let stream;
    try { stream = (await open(log, 'w')).createWriteStream(); }
    catch (error) {
      const result = { name: suite.name, status: 'failed', exitCode: 1, log, error: `Cannot open suite log: ${error.message}` };
      results.push(result); onResult(result); continue;
    }
    const streamDone = finished(stream);
    // Attach rejection handling immediately, including while the child is running.
    streamDone.catch(() => {});
    stream.write(`${JSON.stringify({ executable: process.execPath, args: suite.args, cwd: suite.cwd })}\n`);
    const started = Date.now();
    let error;
    const exitCode = await new Promise(accept => {
      const child = spawn(process.execPath, suite.args, { cwd: suite.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], signal });
      const timer = setTimeout(() => { error = 'Suite timed out'; child.kill(); }, suite.timeoutMs ?? 30 * 60 * 1000);
      timer.unref();
      stream.once('error', value => { error = `Cannot write suite log: ${value.message}`; child.kill(); });
      child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
      child.once('error', value => { clearTimeout(timer); error = value.message; });
      child.once('close', (code, terminationSignal) => { clearTimeout(timer); if (terminationSignal) error ??= `Terminated by ${terminationSignal}`; accept(code ?? 1); });
    });
    if (error) stream.write(`${error}\n`);
    stream.end();
    try { await streamDone; } catch (value) { error = `Cannot write suite log: ${value.message}`; }
    const result = { name: suite.name, status: exitCode === 0 && !error ? 'passed' : 'failed', exitCode: error ? (exitCode || 1) : exitCode, log, durationMs: Date.now() - started, ...(error ? { error } : {}) };
    results.push(result); onResult(result);
  }
  await writeFile(join(logDirectory, 'summary.json'), `${JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2)}\n`);
  return results.every(result => result.status === 'passed') ? 0 : 1;
}

async function main() {
  let profile = 'full'; let logDirectory;
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === '--profile' && args.length) profile = args.shift();
    else if (flag === '--logs' && args.length) logDirectory = resolve(args.shift());
    else throw new Error('Usage: node tests/all.mjs [--profile full|portable] [--logs directory]');
  }
  const steps = validationSteps(profile);
  logDirectory ??= await mkdtemp(join(tmpdir(), 'mlswarm-validation-'));
  console.info(`Validation: ${profile}; Node ${process.version}; ${process.platform}; logs: ${logDirectory}`);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try { process.exitCode = await runSuites(steps, { logDirectory, signal: controller.signal }); }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
