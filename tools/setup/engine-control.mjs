// The side effects that `npm run setup` and the `minions` command share: finding this installation, starting,
// checking and stopping the engine, and calling the connector. Every child is Node itself, without a shell, so
// checkout paths with spaces and Windows work alike. Nothing here runs a model.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, connectorEnvironment, engineEnvironment, engineHome, enginePaths, enginePort, engineUrl, holderFromLsof,
  pageOpener, pidFromNetstat, savedPort, startupHint } from './engine-plan.mjs';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const at = (...parts) => join(repository, ...parts);
export const engineMain = at('apps/server/dist/self-hosted-main.js');
export const connectorCli = at('packages/agent-cli/src/cli.mjs');
export const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
/** Text appended after `offset` bytes (the file's size earlier); slicing decoded text would count UTF-16 units instead. */
export const readAppended = (file, offset) => { try { return readFileSync(file).subarray(offset).toString('utf8'); } catch { return ''; } };

/** This installation's folder, files, port, address and the environments its engine and connector run with. */
export function locate(env = process.env) {
  const home = engineHome({ env, userHome: homedir(), platform: process.platform });
  const files = { home, ...enginePaths(home) };
  const port = enginePort(env, savedPort(readText(files.settingsFile)));
  const base = childEnvironment(env, { nodeDirectory: dirname(process.execPath) });
  return { home, files, port, site: `http://127.0.0.1:${port}`, base,
    engineEnv: engineEnvironment(base, { home, port }), connectorEnv: connectorEnvironment(base, { home, port }) };
}

/** Runs Node with these arguments. Quiet runs keep their output and show it only when they fail. */
export function run(label, args, { cwd = repository, env, stdio = 'inherit', quiet = false } = {}) {
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

/** Runs the connector CLI with these arguments and resolves with its exit code and output, without showing it. */
export function connector(args, env) {
  return new Promise(accept => {
    const child = spawn(process.execPath, [connectorCli, ...args], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => accept({ code: null, stdout, stderr: error.message }));
    child.once('exit', code => accept({ code, stdout, stderr }));
  });
}

/** Something answers a connection to 127.0.0.1 on this port. */
export function answers(port) {
  return new Promise(accept => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1_000, () => { socket.destroy(); accept(false); });
    socket.once('connect', () => { socket.destroy(); accept(true); });
    socket.once('error', () => accept(false));
  });
}

/** The program listening on port, as "name (process 1234)", or null when it cannot be found. */
export function portHolder(port) {
  const output = (command, args) => spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 }).stdout ?? '';
  if (process.platform !== 'win32') return holderFromLsof(output('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']));
  const pid = pidFromNetstat(output('netstat', ['-ano', '-p', 'TCP']), port);
  if (!pid) return null;
  const name = /^"([^"]+)"/.exec(output('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).trim())?.[1];
  return `${name ?? 'a program'} (process ${pid})`;
}

/**
 * Free only when nothing answers there and 127.0.0.1 can be bound. Binding alone is not enough: macOS lets a program
 * bind 127.0.0.1 on a port another program holds on all addresses (0.0.0.0), and both would then share the port.
 */
export async function portFree(port) {
  if (await answers(port)) return false;
  return new Promise(accept => {
    const server = createServer();
    server.once('error', () => accept(false));
    server.listen(port, '127.0.0.1', () => server.close(() => accept(true)));
  });
}

/**
 * 'running' when this installation's engine answers on its port, 'free' when nothing does, 'other' when another
 * program holds it. Only an engine started with this owner file signs sessions with its secret, so check-running's
 * verified session proves the port is this engine.
 */
export async function engineState({ files, port, engineEnv }) {
  if (await portFree(port)) return 'free';
  if (!existsSync(files.ownerFile) || !existsSync(engineMain)) return 'other';
  return run('engine check', [engineMain, 'check-running', '--url', `http://127.0.0.1:${port}`], { env: engineEnv, stdio: 'ignore' })
    .then(() => 'running', () => 'other');
}

/** Opens a page in this desktop's browser; false when there is no desktop to open it on. */
export function openPage(url, env = process.env) {
  const opener = pageOpener(process.platform, env);
  if (!opener) return false;
  try {
    const child = spawn(opener[0], [...opener.slice(1), url], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.once('error', () => {}); child.unref();
    return true;
  } catch { return false; }
}

/**
 * Starts the engine detached, with its output appended to engine.log, so it keeps running after this command ends,
 * the terminal closes or the coding session that ran it finishes (owner, 13 November 2026). `minions stop` stops it
 * gracefully on every platform. Resolves with its address once it listens; rejects if it exits first.
 */
export async function startEngine(env, files) {
  const offset = existsSync(files.engineLog) ? statSync(files.engineLog).size : 0;
  const log = openSync(files.engineLog, 'a', 0o600);
  const child = spawn(process.execPath, [engineMain, 'start'],
    { cwd: repository, env, detached: true, stdio: ['ignore', log, log], shell: false, windowsHide: true });
  closeSync(log);
  let exit = null, failure = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.once('error', error => { failure = error; });
  child.unref();
  const output = () => readAppended(files.engineLog, offset);
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
  throw new Error(`The engine did not report its address within two minutes. It may still be starting; its log is ${files.engineLog}. Stop it with minions stop.`);
}

/**
 * Windows has no graceful signal for a detached process, so the engine CLI's `stop` is used on every platform: a
 * loopback request carrying a key derived from the owner file's secret. Nothing else is stopped or removed.
 */
export function stopEngine({ port, engineEnv }, { quiet = false } = {}) {
  return run('engine stop', [engineMain, 'stop', '--url', `http://127.0.0.1:${port}`], { env: engineEnv, quiet });
}
