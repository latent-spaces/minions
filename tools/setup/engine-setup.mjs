// One command from a fresh clone to a running local engine with this computer connected. Every child this script
// starts is Node itself, without a shell, so checkout paths with spaces and Windows work alike; npm runs the package
// build scripts as any npm run does. Nothing here runs a model.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { npmCli } from './npm-cli.mjs';
import { childEnvironment, connectorCommand, connectorEnvironment, engineEnvironment, engineHome, enginePaths, enginePort, engineUrl,
  initializationState, interruptedByUser, needsInstall, ownerIdentity, pageOpener, requireNode24, startupHint } from './engine-plan.mjs';

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

/** Opens the private sign-in link, which signs this browser in to the local app; the code itself is never printed. */
function openSignIn(linkFile) {
  const opened = openPage(readFileSync(linkFile, 'utf8').trim(), process.env);
  console.info(opened ? 'Your browser is opening the local app; the private link in it signs you in.'
    : `To sign in, open the link in ${linkFile} in your browser on this computer; it expires in five minutes.`);
}

/**
 * The engine runs as an owned child with an IPC channel, so `mlswarm-stop` drains it gracefully on every platform.
 * stop() resolves true only when the engine then exits 0 by itself; a force-kill after 15 s or any failure is unclean.
 */
function startEngine(env, linkFile, files) {
  const child = spawn(process.execPath, [at('apps/server/dist/self-hosted-main.js'), 'start', '--link-file', linkFile],
    { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false, windowsHide: true });
  const exited = new Promise(accept => child.once('exit', (code, signal) => accept({ code, signal })));
  // The engine's routine activity goes to its log file; its errors stay on this console.
  const log = createWriteStream(files.engineLog, { flags: 'a', mode: 0o600 });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); errors += chunk; });
  const url = new Promise((accept, reject) => {
    child.once('error', reject);
    exited.then(({ code, signal }) => reject(new Error(`The engine stopped during startup (${signal ?? `exit ${code}`}). Its messages are above and in ${files.engineLog}.${startupHint(errors, files)}`)));
    child.stdout.on('data', chunk => {
      log.write(chunk);
      if (output === null) return;
      output += chunk;
      const found = engineUrl(output);
      if (found) { output = null; accept(found); }
    });
  });
  exited.then(() => log.end());
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) {
      say('Stopping the engine');
      try { child.send('mlswarm-stop'); } catch { child.kill(); }
    }
    let forced = false;
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 15_000);
    const { code, signal } = await exited;
    clearTimeout(timer);
    return !forced && code === 0 && signal === null;
  })();
  return { url, exited, stop, stopping: () => stopping !== undefined };
}


/** The connector's own setup for this computer: 'connected', 'interrupted' (Ctrl+C, or the engine is stopping) or 'failed'. */
async function connectComputer(url, env, stopping = () => false) {
  try {
    await run('connector setup', [at('packages/agent-cli/src/cli.mjs'), 'setup', '--site', url, '--wait-seconds', '600'], { env });
    return 'connected';
  } catch (error) {
    // While it waits the connector reads keys in raw mode, so a Ctrl+C there reaches only the connector.
    if (stopping() || interruptedByUser(error.exit)) return 'interrupted';
    console.error(`${error.message} The engine keeps running. To connect this computer, run npm run setup again, in another ${shellName()} window or after Ctrl+C here.`);
    return 'failed';
  }
}

const shellName = () => process.platform === 'win32' ? 'PowerShell' : 'terminal';

function summary(url, connected, files, { owned }) {
  const mcpConfig = connectorCommand(process.platform, { node: process.execPath, cli: at('packages/agent-cli/src/cli.mjs'),
    serviceHome: files.serviceHome, credentialHome: files.credentialHome, args: ['mcp-config', '--client', 'claude'] });
  say(`${connected ? 'Done' : 'The engine is running; this computer is not connected yet'}. The local app is at ${url}/viewer/.
${owned ? 'The engine runs until you press Ctrl+C here. ' : ''}Run npm run setup again at any time: it starts the engine when it is stopped, and otherwise opens the local app signed in.
When you want them:
- Use this installation from your coding agent (or --client codex or other); run this in another ${shellName()} window and follow what it prints:
  ${mcpConfig}
- Sign in to GitHub with gh auth login, for agents that work on repositories.`);
}

async function main() {
  requireNode24(process.version);
  const { values } = parseArgs({ args: process.argv.slice(2), options: { 'owner-name': { type: 'string' }, 'owner-email': { type: 'string' } }, allowPositionals: false });
  const home = engineHome({ env: process.env, userHome: homedir(), platform: process.platform });
  const port = enginePort(process.env);
  const files = { home, ...enginePaths(home) };
  const base = childEnvironment(process.env, { nodeDirectory: dirname(process.execPath) });
  const engineEnv = engineEnvironment(base, { home, port });
  const connectorEnv = connectorEnvironment(base, { home, port });
  const site = `http://127.0.0.1:${port}`;
  const engineMain = at('apps/server/dist/self-hosted-main.js');
  const linkFile = join(home, `owner-link-${Date.now()}.txt`);
  const steps = 6;
  let step = 0;
  const next = text => say(`[${++step}/${steps}] ${text}`);

  next('Checking the engine port and files');
  const state = initializationState({ database: existsSync(files.sqlitePath), owner: existsSync(files.ownerFile) });
  if (state === 'incomplete') {
    throw new Error(`An earlier first run stopped before initialization finished: ${home} holds only one of engine.sqlite and owner.json. Nothing was changed. If nothing there needs keeping, remove that directory (or choose a new MLSWARM_ENGINE_HOME) and run npm run setup again.`);
  }
  if (!await portFree(port)) {
    // Only an engine started with this owner file can issue a sign-in link for it, so a link proves the port is this engine.
    const ours = state === 'existing' && existsSync(engineMain)
      && await run('owner link', [engineMain, 'owner-link', '--url', site, '--link-file', linkFile], { env: engineEnv, stdio: 'ignore' }).then(() => true, () => false);
    if (!ours) throw new Error(`Port ${port} is occupied. Stop the program using it, or choose another with MLSWARM_ENGINE_PORT. Nothing was started or stopped.`);
    say(`The engine is already running at ${site}. Opening the local app and checking this computer's connection.`);
    openSignIn(linkFile);
    const result = await connectComputer(site, connectorEnv);
    if (result !== 'interrupted') summary(site, result === 'connected', files, { owned: false });
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
  // The packages' own build scripts; the local app is built for self-hosted sign-in.
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
  const engine = startEngine(engineEnv, linkFile, files);
  // Ctrl+C, a closed terminal (SIGHUP; on Windows a closed console) and Ctrl+Break stop the engine gracefully.
  const stopAndExit = () => { void engine.stop().then(clean => process.exit(clean ? 0 : 1)); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(signal, stopAndExit);
  try {
    const url = await engine.url;
    console.info(`The engine is listening on ${url}; its activity log is ${files.engineLog}.`);
    openSignIn(linkFile);

    next('Connecting this computer');
    console.info('Approve this computer on the page the connector shows, in the browser where you are signed in. Setup waits up to ten minutes.');
    const result = await connectComputer(url, connectorEnv, engine.stopping);
    if (result === 'interrupted') { stopAndExit(); return; }
    summary(url, result === 'connected', files, { owned: true });
    const { code, signal } = await engine.exited;
    if (!engine.stopping() && (code !== 0 || signal !== null)) throw new Error(`The engine stopped unexpectedly (${signal ?? `exit ${code}`}).`);
  } catch (error) {
    if (engine.stopping()) return; // A requested stop exits through stopAndExit with the stop's outcome.
    await engine.stop();
    throw error;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
