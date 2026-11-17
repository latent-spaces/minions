// One command from a fresh clone to a local engine running in the background with the connector set up. Every
// child this script starts is Node itself, without a shell, so checkout paths with spaces and Windows work alike; npm
// runs the package build scripts as any npm run does. Nothing here runs a model.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { npmCli } from './npm-cli.mjs';
import { connectorCommand, initializationState, interruptedByUser, occupiedMessage, ownerIdentity, requireNode24, settingsText } from './engine-plan.mjs';
import { installDependencies } from './dependencies.mjs';
import { connectorCli, engineMain, engineState, locate, openPage, portHolder, repository, run, startEngine } from './engine-control.mjs';

const say = text => console.info(`\nMinions setup: ${text}`);

/** Opens the local app, which lets the owner straight in on this computer. */
function openApp(site) {
  const page = `${site}/`;
  console.info(openPage(page, process.env) ? 'Your browser is opening the local app.' : `Open ${page} in your browser on this computer.`);
}

/** The connector's own setup, which signs in as the owner and starts the shared service: 'ready', 'interrupted' (Ctrl+C) or 'failed'. */
async function connectorSetup(url, env) {
  try {
    // This command registers the coding agent itself, so the connector's own hint for a separate installation is left out.
    await run('connector setup', [connectorCli, 'setup', '--site', url, '--wait-seconds', '600', '--no-client-hint'], { env });
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
 * anything was registered. Also installs the bundled skill through that registration; a failure is reported and setup carries on.
 */
function registerClients(env) {
  return new Promise(accept => {
    const child = spawn(process.execPath, [connectorCli, 'register', '--install-skill'],
      { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    child.once('error', error => accept({ registered: false, lines: `Registration failed: ${error.message}` }));
    child.once('exit', code => accept({ registered: code === 0, lines: output.trim() || (code === 0 ? '' : 'Registration failed.') }));
  });
}

/**
 * Links this checkout's `minions` command onto PATH with npm link (owner decision, 16 November 2026); npm writes the
 * Windows .cmd and PowerShell shims itself. A test engine or a Git worktree keeps the computer's existing command.
 * Resolves to the line the summary shows; a failure is reported and setup carries on.
 */
async function linkCommand() {
  if (process.env.MINIONS_ENGINE_HOME) return 'This is a test engine (MINIONS_ENGINE_HOME), so the minions command was not linked.';
  let worktree = false;
  try { worktree = lstatSync(join(repository, '.git')).isFile(); } catch {}
  if (worktree) return 'This checkout is a Git worktree, so the minions command was not linked; setup in the main checkout links it.';
  try {
    await run('npm link', [npmCli(), 'link', '--ignore-scripts', '--no-audit', '--no-fund'], { quiet: true });
    return 'The minions command is ready: try minions status, minions stop or minions start.';
  } catch (error) {
    return `The minions command could not be linked (${error.message}). Run npm link in ${repository} to link it yourself.`;
  }
}

function summary(url, ready, files, registration, command) {
  const connector = args => connectorCommand(process.platform, { node: process.execPath, cli: connectorCli,
    serviceHome: files.serviceHome, credentialHome: files.credentialHome, args });
  const manual = `To register it yourself, run (--client claude, codex or other): ${connector(['mcp-config', '--client', 'claude'])}`;
  say(`${ready ? 'Done' : 'The engine is running; the connector is not set up yet'}. The local app is at ${url}/.
The engine runs in the background; minions stop stops it.
${command}
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
  const registration = await registerSetupClients({ ready, connectorEnv, values });
  summary(url, ready, files, registration, await linkCommand());
}

/** Keep isolated engines and --no-register out of the client/skill registration path. */
export async function registerSetupClients({ ready, connectorEnv, values = {}, env = process.env }) {
  return !ready ? { registered: false, lines: 'No coding agent was registered: the connector is not set up yet.' }
    : values['no-register'] ? { registered: false, lines: 'No coding agent was registered (--no-register).' }
    : env.MINIONS_ENGINE_HOME ? { registered: false, lines: 'This is a test engine (MINIONS_ENGINE_HOME), so no coding agent was registered.' }
    : await registerClients(connectorEnv);
}

async function main() {
  requireNode24(process.version);
  const { values } = parseArgs({ args: process.argv.slice(2), options: { 'owner-name': { type: 'string' }, 'owner-email': { type: 'string' }, 'no-register': { type: 'boolean' } }, allowPositionals: false });
  const installation = locate();
  const { home, files, port, site, base, engineEnv, connectorEnv } = installation;
  // Hard cut to the Minions folders (owner, 16 November 2026): an install from before the rename is left as it was.
  if (!process.env.MINIONS_ENGINE_HOME && existsSync(join(homedir(), '.mlswarm'))) say('An install from before the rename is in ~/.mlswarm and ~/mlswarm. It is not used and was left as it was; delete it when nothing there needs keeping.');
  const steps = 6;
  let step = 0;
  const next = text => say(`[${++step}/${steps}] ${text}`);

  next('Checking the engine port and files');
  const state = initializationState({ database: existsSync(files.sqlitePath), owner: existsSync(files.ownerFile) });
  if (state === 'incomplete') {
    throw new Error(`An earlier first run stopped before initialization finished: ${home} holds only one of engine.sqlite and owner.json. Nothing was changed. If nothing there needs keeping, remove that directory (or choose a new MINIONS_ENGINE_HOME) and run npm run setup again.`);
  }
  // Always the same address: 8787, unless MINIONS_ENGINE_PORT or an earlier run's saved port says otherwise.
  const running = await engineState(installation);
  if (running !== 'free') {
    if (running === 'running') {
      say(`The engine is already running at ${site}. Opening the local app and checking the connector.`);
      openApp(site);
      const result = await connectorSetup(site, connectorEnv);
      if (result !== 'interrupted') await finish(site, result === 'ready', files, connectorEnv, values);
      return;
    }
    throw new Error(occupiedMessage(port, portHolder(port)));
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
  await installDependencies({ cwd: repository, env: base, npm });

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

/** Physical path equivalence keeps linked checkouts and Windows case/short-name aliases working on Node 24.0+. */
export function isSetupEntry(script, moduleFile = fileURLToPath(import.meta.url), { platform = process.platform,
  realpath = target => { try { return realpathSync.native(target); } catch { return realpathSync(target); } } } = {}) {
  if (!script) return false;
  const physical = target => { const value = realpath(target); return platform === 'win32' ? value.toLowerCase() : value; };
  try { return physical(script) === physical(moduleFile); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

if (isSetupEntry(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
