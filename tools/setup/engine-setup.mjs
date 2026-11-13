// One command from a fresh clone to a local engine running in the background with this computer connected. Every
// child this script starts is Node itself, without a shell, so checkout paths with spaces and Windows work alike; npm
// runs the package build scripts as any npm run does. Nothing here runs a model.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { npmCli } from './npm-cli.mjs';
import { childEnvironment, connectorCommand, connectorEnvironment, engineEnvironment, engineHome, enginePaths, enginePort, engineUrl,
  initializationState, interruptedByUser, needsInstall, ownerIdentity, pageOpener, requireNode24, savedPort, settingsText, startupHint } from './engine-plan.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const at = (...parts) => join(repository, ...parts);
const say = text => console.info(`\nMyLittleSwarm setup: ${text}`);
const modified = file => { try { return statSync(file).mtimeMs; } catch { return null; } };

/** Runs Node with these arguments. Quiet runs keep their output and show it only when they fail. */
function run(label, args, { cwd = repository, env, stdio = 'inherit', quiet = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : stdio, shell: false, windowsHide: true });
    let output = '';
    if (quiet) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return accept();
      if (quiet) process.stderr.write(output);
      reject(Object.assign(new Error(`${label} failed (${signal ?? `exit ${code}`}).${quiet ? ' Its output is above.' : ''}`), { exit: { code, signal } }));
    });
  });
}

function portFree(port) {
  return new Promise(accept => {
    const server = createServer();
    server.once('error', () => accept(false));
    server.listen(port, '127.0.0.1', () => server.close(() => accept(true)));
  });
}

function openPage(url, env) {
  const opener = pageOpener(process.platform, env);
  if (!opener) return false;
  try {
    const child = spawn(opener[0], [...opener.slice(1), url], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.once('error', () => {}); child.unref();
    return true;
  } catch { return false; }
}

/** Opens the local app, which lets the owner straight in on this computer. */
function openApp(site) {
  const page = `${site}/`;
  console.info(openPage(page, process.env) ? 'Your browser is opening the local app.' : `Open ${page} in your browser on this computer.`);
}

const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

/**
 * Starts the engine detached, with its output appended to engine.log, so it keeps running after this command ends,
 * the terminal closes or the coding session that ran setup finishes (owner, 13 November 2026). `npm run stop` stops
 * it gracefully on every platform. Resolves with its address once it listens; rejects if it exits first.
 */
async function startEngine(env, files) {
  const offset = existsSync(files.engineLog) ? statSync(files.engineLog).size : 0;
  const log = openSync(files.engineLog, 'a', 0o600);
  const child = spawn(process.execPath, [at('apps/server/dist/self-hosted-main.js'), 'start'],
    { cwd: repository, env, detached: true, stdio: ['ignore', log, log], shell: false, windowsHide: true });
  closeSync(log);
  let exit = null, failure = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.once('error', error => { failure = error; });
  child.unref();
  const output = () => (readText(files.engineLog) ?? '').slice(offset);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
    if (failure) throw failure;
    const url = engineUrl(output());
    if (url) return url;
    if (exit) {
      const text = output().trim();
      throw new Error(`The engine stopped during startup (${exit.signal ?? `exit ${exit.code}`}).${text ? `\n${text}\n` : ' '}Its log is ${files.engineLog}.${startupHint(text, files)}`);
    }
    await new Promise(accept => setTimeout(accept, 200));
  }
  throw new Error(`The engine did not report its address within two minutes. It may still be starting; its log is ${files.engineLog}. Stop it with npm run stop.`);
}

/** The connector's own setup for this computer: 'connected', 'interrupted' (Ctrl+C) or 'failed'. */
async function connectComputer(url, env) {
  try {
    await run('connector setup', [at('packages/agent-cli/src/cli.mjs'), 'setup', '--site', url, '--wait-seconds', '600'], { env });
    return 'connected';
  } catch (error) {
    // During its GitHub sign-in step the connector reads keys in raw mode, so a Ctrl+C there reaches only the connector.
    if (interruptedByUser(error.exit)) return 'interrupted';
    console.error(`${error.message} The engine keeps running. To connect this computer, run npm run setup again.`);
    return 'failed';
  }
}

const shellName = () => process.platform === 'win32' ? 'PowerShell' : 'terminal';

function summary(url, connected, files) {
  const mcpConfig = connectorCommand(process.platform, { node: process.execPath, cli: at('packages/agent-cli/src/cli.mjs'),
    serviceHome: files.serviceHome, credentialHome: files.credentialHome, args: ['mcp-config', '--client', 'claude'] });
  say(`${connected ? 'Done' : 'The engine is running; this computer is not connected yet'}. The local app is at ${url}/.
The engine runs in the background, also after this window closes; npm run stop stops it. Run npm run setup again at any time: it starts the engine when it is stopped, and otherwise opens the local app.
When you want them:
- Use this installation from your coding agent (or --client codex or other); run this in another ${shellName()} window and follow what it prints:
  ${mcpConfig}
- Sign in to GitHub with gh auth login, for agents that work on repositories.`);
}

async function main() {
  requireNode24(process.version);
  const { values } = parseArgs({ args: process.argv.slice(2), options: { 'owner-name': { type: 'string' }, 'owner-email': { type: 'string' } }, allowPositionals: false });
  const home = engineHome({ env: process.env, userHome: homedir(), platform: process.platform });
  const files = { home, ...enginePaths(home) };
  const port = enginePort(process.env, savedPort(readText(files.settingsFile)));
  const base = childEnvironment(process.env, { nodeDirectory: dirname(process.execPath) });
  const engineEnv = engineEnvironment(base, { home, port });
  const connectorEnv = connectorEnvironment(base, { home, port });
  const site = `http://127.0.0.1:${port}`;
  const engineMain = at('apps/server/dist/self-hosted-main.js');
  const steps = 6;
  let step = 0;
  const next = text => say(`[${++step}/${steps}] ${text}`);

  next('Checking the engine port and files');
  const state = initializationState({ database: existsSync(files.sqlitePath), owner: existsSync(files.ownerFile) });
  if (state === 'incomplete') {
    throw new Error(`An earlier first run stopped before initialization finished: ${home} holds only one of engine.sqlite and owner.json. Nothing was changed. If nothing there needs keeping, remove that directory (or choose a new MLSWARM_ENGINE_HOME) and run npm run setup again.`);
  }
  if (!await portFree(port)) {
    // Only an engine started with this owner file signs sessions with its secret, so a verified session proves the port is this engine.
    const ours = state === 'existing' && existsSync(engineMain)
      && await run('engine check', [engineMain, 'check-running', '--url', site], { env: engineEnv, stdio: 'ignore' }).then(() => true, () => false);
    if (!ours) throw new Error(`Port ${port} is occupied. Stop the program using it, or choose another with MLSWARM_ENGINE_PORT. Nothing was started or stopped.`);
    say(`The engine is already running at ${site}. Opening the local app and checking this computer's connection.`);
    openApp(site);
    const result = await connectComputer(site, connectorEnv);
    if (result !== 'interrupted') summary(site, result === 'connected', files);
    return;
  }
  // A first run needs the owner's identity and this checkout's revision; check both before minutes of installing.
  let owner, revision;
  if (state === 'new') {
    const git = args => spawnSync('git', args, { cwd: repository, encoding: 'utf8', shell: false, windowsHide: true }).stdout?.trim() || '';
    owner = ownerIdentity(values, key => git(['config', '--get', key]));
    revision = git(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Could not read the Git revision of this checkout. Run setup inside the cloned repository with Git installed.');
  }
  console.info(`Engine files: ${home}; engine address: ${site}.`);

  next('Installing dependencies');
  const npm = npmCli();
  if (!needsInstall({ hiddenLockfile: modified(at('node_modules/.package-lock.json')), lockfile: modified(at('package-lock.json')) })) {
    console.info('Dependencies are installed and match package-lock.json; skipping npm ci.');
  } else {
    console.info('Running npm ci; this downloads the dependencies the first time and can take a few minutes on a slow connection.');
    await run('npm ci', [npm, 'ci', '--no-audit', '--no-fund'], { env: base, quiet: true });
  }

  next('Building the contracts, engine, local app and connector');
  // The packages' own build scripts.
  await run('contracts build', [npm, 'run', 'build', '--workspace', 'packages/contracts'], { env: base, quiet: true });
  await run('engine build', [npm, 'run', 'build:backend', '--workspace', 'apps/server'], { env: base, quiet: true });
  await run('local app build', [npm, 'run', 'build', '--workspace', 'apps/web'], { env: base, quiet: true });
  await run('connector build', [npm, 'run', 'build', '--workspace', 'packages/agent-cli'], { env: base, quiet: true });

  next('Initializing the database');
  if (state === 'existing') console.info(`Database exists at ${files.sqlitePath}; keeping it. The engine verifies it at startup.`);
  else {
    if (owner.fromGit) console.info(`Owner identity from Git: ${owner.name} <${owner.email}>. Pass --owner-name and --owner-email to choose another.`);
    await run('database initialization', [engineMain, 'init', '--owner-name', owner.name, '--owner-email', owner.email, '--source-revision', revision], { env: engineEnv });
  }

  next('Starting the engine');
  const url = await startEngine(engineEnv, files);
  // The next setup or stop finds this engine at the same address.
  writeFileSync(files.settingsFile, settingsText(port), { mode: 0o600 });
  console.info(`The engine is listening on ${url} in the background; its activity log is ${files.engineLog}.`);
  openApp(url);

  next('Connecting this computer');
  const result = await connectComputer(url, connectorEnv);
  if (result !== 'interrupted') summary(url, result === 'connected', files);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
