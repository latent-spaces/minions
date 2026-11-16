// One command from a fresh clone to a local engine running in the background with the connector set up. Every
// child this script starts is Node itself, without a shell, so checkout paths with spaces and Windows work alike; npm
// runs the package build scripts as any npm run does. Nothing here runs a model.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { npmCli } from './npm-cli.mjs';
import { childEnvironment, connectorCommand, connectorEnvironment, engineEnvironment, engineHome, enginePaths, engineUrl, initializationState,
  enginePort, holderFromLsof, interruptedByUser, needsInstall, occupiedMessage, ownerIdentity, pageOpener, pidFromNetstat, requireNode24, savedPort, settingsText, startupHint } from './engine-plan.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const at = (...parts) => join(repository, ...parts);
const say = text => console.info(`\nMinions setup: ${text}`);
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

/** Something answers a connection to 127.0.0.1 on this port. */
function answers(port) {
  return new Promise(accept => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1_000, () => { socket.destroy(); accept(false); });
    socket.once('connect', () => { socket.destroy(); accept(true); });
    socket.once('error', () => accept(false));
  });
}

/**
 * Free only when nothing answers there and 127.0.0.1 can be bound. Binding alone is not enough: macOS lets a program
 * bind 127.0.0.1 on a port another program holds on all addresses (0.0.0.0), and both would then share the port.
 */
/** The program listening on port, as "name (process 1234)", or null when it cannot be found. */
function portHolder(port) {
  const output = (command, args) => spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 }).stdout ?? '';
  if (process.platform !== 'win32') return holderFromLsof(output('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']));
  const pid = pidFromNetstat(output('netstat', ['-ano', '-p', 'TCP']), port);
  if (!pid) return null;
  const name = /^"([^"]+)"/.exec(output('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).trim())?.[1];
  return `${name ?? 'a program'} (process ${pid})`;
}

async function portFree(port) {
  if (await answers(port)) return false;
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

/** The connector's own setup, which signs in as the owner and starts the shared service: 'ready', 'interrupted' (Ctrl+C) or 'failed'. */
async function connectorSetup(url, env) {
  try {
    // This command registers the coding agent itself, so the connector's own hint for a separate installation is left out.
    await run('connector setup', [at('packages/agent-cli/src/cli.mjs'), 'setup', '--site', url, '--wait-seconds', '600', '--no-client-hint'], { env });
    return 'ready';
  } catch (error) {
    // During its GitHub sign-in step the connector reads keys in raw mode, so a Ctrl+C there reaches only the connector.
    if (interruptedByUser(error.exit)) return 'interrupted';
    console.error(`${error.message} The engine keeps running. To finish setting up the connector, run npm run setup again.`);
    return 'failed';
  }
}

/**
 * Registers the MCP server as minions with Claude Code and Codex, where they are on this computer, replacing older
 * mlswarm-… entries (owner decisions, 13 and 14 November 2026). Resolves to the register command's lines and whether
 * anything was registered; a failure is reported and setup carries on.
 */
function registerClients(env) {
  return new Promise(accept => {
    const child = spawn(process.execPath, [at('packages/agent-cli/src/cli.mjs'), 'register'],
      { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    child.once('error', error => accept({ registered: false, lines: `Registration failed: ${error.message}` }));
    child.once('exit', code => accept({ registered: code === 0, lines: output.trim() || (code === 0 ? '' : 'Registration failed.') }));
  });
}

function summary(url, ready, files, registration) {
  const connector = args => connectorCommand(process.platform, { node: process.execPath, cli: at('packages/agent-cli/src/cli.mjs'),
    serviceHome: files.serviceHome, credentialHome: files.credentialHome, args });
  const manual = `To register it yourself, run (--client claude, codex or other): ${connector(['mcp-config', '--client', 'claude'])}`;
  say(`${ready ? 'Done' : 'The engine is running; the connector is not set up yet'}. The local app is at ${url}/.
The engine runs in the background; npm run stop stops it.
${registration.lines}
${registration.registered
    ? `Until a new session loads the Minions tools, call them with: ${connector(['tool', '--list'])} (then tool NAME '{...}').`
    : manual}
For agents that work on repositories, sign in to GitHub with gh auth login.`);
}

/**
 * After the connector's own setup: registers the coding agents, then prints the summary. A test engine in its own
 * MINIONS_ENGINE_HOME never replaces the computer's minions entry (owner decision, 14 November 2026).
 */
async function finish(url, ready, files, connectorEnv, values) {
  const registration = !ready ? { registered: false, lines: 'No coding agent was registered: the connector is not set up yet.' }
    : values['no-register'] ? { registered: false, lines: 'No coding agent was registered (--no-register).' }
    : process.env.MINIONS_ENGINE_HOME ? { registered: false, lines: 'This is a test engine (MINIONS_ENGINE_HOME), so no coding agent was registered.' }
    : await registerClients(connectorEnv);
  summary(url, ready, files, registration);
}

async function main() {
  requireNode24(process.version);
  const { values } = parseArgs({ args: process.argv.slice(2), options: { 'owner-name': { type: 'string' }, 'owner-email': { type: 'string' }, 'no-register': { type: 'boolean' } }, allowPositionals: false });
  const home = engineHome({ env: process.env, userHome: homedir(), platform: process.platform });
  const files = { home, ...enginePaths(home) };
  // Hard cut to the Minions folders (owner, 16 November 2026): an install from before the rename is left as it was.
  if (!process.env.MINIONS_ENGINE_HOME && existsSync(join(homedir(), '.mlswarm'))) say('An install from before the rename is in ~/.mlswarm and ~/mlswarm. It is not used and was left as it was; delete it when nothing there needs keeping.');
  const base = childEnvironment(process.env, { nodeDirectory: dirname(process.execPath) });
  const engineMain = at('apps/server/dist/self-hosted-main.js');
  const steps = 6;
  let step = 0;
  const next = text => say(`[${++step}/${steps}] ${text}`);

  next('Checking the engine port and files');
  const state = initializationState({ database: existsSync(files.sqlitePath), owner: existsSync(files.ownerFile) });
  if (state === 'incomplete') {
    throw new Error(`An earlier first run stopped before initialization finished: ${home} holds only one of engine.sqlite and owner.json. Nothing was changed. If nothing there needs keeping, remove that directory (or choose a new MINIONS_ENGINE_HOME) and run npm run setup again.`);
  }
  // Always the same address: 8787, unless MINIONS_ENGINE_PORT or an earlier run's saved port says otherwise.
  const port = enginePort(process.env, savedPort(readText(files.settingsFile)));
  if (!await portFree(port)) {
    // Only an engine started with this owner file signs sessions with its secret, so a verified session proves the port is this engine.
    const ours = state === 'existing' && existsSync(engineMain)
      && await run('engine check', [engineMain, 'check-running', '--url', `http://127.0.0.1:${port}`], { env: engineEnvironment(base, { home, port }), stdio: 'ignore' }).then(() => true, () => false);
    if (ours) {
      const site = `http://127.0.0.1:${port}`, connectorEnv = connectorEnvironment(base, { home, port });
      say(`The engine is already running at ${site}. Opening the local app and checking the connector.`);
      openApp(site);
      const result = await connectorSetup(site, connectorEnv);
      if (result !== 'interrupted') await finish(site, result === 'ready', files, connectorEnv, values);
      return;
    }
    throw new Error(occupiedMessage(port, portHolder(port)));
  }
  const engineEnv = engineEnvironment(base, { home, port });
  const connectorEnv = connectorEnvironment(base, { home, port });
  const site = `http://127.0.0.1:${port}`;
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
  // Saved before the engine starts, so the next setup or stop finds it at the same address even when this run gives up
  // waiting for it.
  writeFileSync(files.settingsFile, settingsText(port), { mode: 0o600 });
  const url = await startEngine(engineEnv, files);
  console.info(`The engine is listening on ${url} in the background; its activity log is ${files.engineLog}.`);
  openApp(url);

  next('Signing in and starting the shared service');
  const result = await connectorSetup(url, connectorEnv);
  if (result !== 'interrupted') await finish(url, result === 'ready', files, connectorEnv, values);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
