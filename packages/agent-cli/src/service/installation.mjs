// One private installation owns the loopback endpoint across repositories and
// control clients. A descriptor or PID alone never authorizes process control.
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, unlinkSync, chmodSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { defaultSiteStateHome } from '../site-state.mjs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { ensureHome, readPrivate, writePrivate } from '../state.mjs';
import { ownerOrigin } from '../owner-client.mjs';
import { withOperationLock } from '../operation-lock.mjs';
import { startRuntimeService } from './mcp-service.mjs';

const INSTALLATION = 'installation.json', OWNER = 'service-owner.json';
// Kept beside the private installation so moving or rebuilding the connector does not break either
// host's authorization command. Its stdout is intentionally only for the host.
const HEADERS_HELPER = `import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const home=dirname(fileURLToPath(import.meta.url));
const owned=s=>!process.getuid||s.uid===process.getuid();
const privateMode=s=>process.platform==='win32'||!(s.mode&0o077);
try{
 const dir=lstatSync(home);if(!dir.isDirectory()||dir.isSymbolicLink()||!owned(dir)||!privateMode(dir))throw Error();
 const path=join(home,'installation.json'),named=lstatSync(path);if(named.isSymbolicLink())throw Error();
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let value;
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>8192||!owned(s)||!privateMode(s)||s.dev!==named.dev||s.ino!==named.ino)throw Error();value=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 if(value.version!==1||!/^[a-f0-9]{64}$/.test(value.token))throw Error();
 process.stdout.write(JSON.stringify({Authorization:'Bearer '+value.token}));
}catch{process.stderr.write('Minions private service credential is unavailable. Run setup.\\n');process.exitCode=1;}
`;
const fail = message => new Error(message);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export function installationHome() {
  const home = process.env.MINIONS_SERVICE_HOME ?? defaultSiteStateHome('service');
  if (!isAbsolute(home)) throw fail('MINIONS_SERVICE_HOME must be an absolute private directory.');
  return home;
}
function privateHome(home) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw fail('The installation directory must be absolute.');
  ensureHome(home);
  const stat = lstatSync(home);
  if (process.getuid && stat.uid !== process.getuid()) throw fail('The installation directory must belong to the current user.');
}
function ownedFile(path, maxBytes = 8192) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && stat.mode & 0o077)) throw fail('Unsafe installation record; no file or process was changed.');
  return stat;
}
export function readInstallation(home = installationHome()) {
  privateHome(home); ownedFile(join(home, INSTALLATION));
  const value = readPrivate(join(home, INSTALLATION), true);
  if (!value || Object.keys(value).sort().join(',') !== 'port,site,token,version' || value.version !== 1 || ownerOrigin(value.site) !== value.site
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw fail('Invalid installation record; no settings were reset.');
  return value;
}
export function installationHeaderHelper(home = installationHome()) {
  privateHome(home);
  const path = join(home, 'headers.mjs');
  try { ownedFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writePrivate(path, HEADERS_HELPER); chmodSync(path, 0o700);
  return path;
}
async function choosePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}
export async function ensureInstallation({ home = installationHome(), site } = {}) {
  privateHome(home);
  return withOperationLock(home, async () => {
    installationHeaderHelper(home);
    try {
      const existing = readInstallation(home);
      if (site !== undefined && ownerOrigin(site) !== existing.site) throw fail('This installation belongs to a different website. Stop and deliberately reconfigure it; no fallback or credential reset was used.');
      return existing;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const value = { version: 1, site: ownerOrigin(site), port: await choosePort(), token: randomBytes(32).toString('hex') };
    writePrivate(join(home, INSTALLATION), value);
    return value;
  });
}
async function claimOwnership(home) {
  const path = join(home, OWNER), value = { version: 1, pid: process.pid, nonce: randomUUID() };
  const record = await withOperationLock(home, () => {
    try {
      ownedFile(path); const previous = readPrivate(path, true);
      if (!previous || Object.keys(previous).sort().join(',') !== 'nonce,pid,version' || previous.version !== 1 || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.nonce !== 'string') throw fail('Unknown installation ownership; inspect the saved record. No process was stopped.');
      if (alive(previous.pid)) throw fail('Another live process owns this installation. Use service status; no process was stopped.');
      unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    writePrivate(path, value); return lstatSync(path);
  });
  return async () => withOperationLock(home, () => {
    try {
      const current = ownedFile(path), saved = readPrivate(path, true);
      if (current.dev === record.dev && current.ino === record.ino && saved.nonce === value.nonce) unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
}
async function control(config, path, method = 'GET', incarnation) {
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method, redirect: 'error', credentials: 'omit',
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json', ...(incarnation ? { 'X-Minions-Incarnation': incarnation } : {}) }, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw fail('The saved service endpoint did not authenticate. No process was signalled.');
  if (Number(response.headers.get('content-length')) > 8192) throw fail('Invalid service response.');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > 8192) throw fail('Invalid service response.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function statusInstalledService({ home = installationHome() } = {}) {
  let config;
  try { config = readInstallation(home); } catch (error) { if (error.code === 'ENOENT') return { running: false, installed: false }; throw error; }
  let value;
  try { value = await control(config, '/service/status'); }
  catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(error.cause?.code)) return { running: false, installed: true, site: config.site };
    throw error;
  }
  if (value.running !== true || value.version !== 2 || value.transport !== 'streamable-http' || value.principal?.site !== config.site
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9-]{36}$/.test(value.incarnation ?? '')) throw fail('The saved endpoint returned an invalid service identity.');
  return { running: true, installed: true, site: config.site, url: `http://127.0.0.1:${config.port}/mcp`, pid: value.pid, incarnation: value.incarnation, transport: value.transport, ready: value.ready, packageVersion: value.packageVersion, ownerId: value.principal.ownerId,
    // A service from before --after-turns reports no draining field and has no drain endpoint.
    finishesTurns: typeof value.draining === 'boolean',
    ...(value.draining === true ? { draining: true, turnsInProgress: Number.isSafeInteger(value.turnsInProgress) ? value.turnsInProgress : null } : {}) };
}
// afterTurns: each turn in progress finishes and no new one starts, then the service stops by itself. Workers keep
// their missions and continue when the service starts again, so an update stops no agent. Waiting gives up after
// timeoutMs, leaving the service to stop once its turns end.
export async function stopInstalledService({ home = installationHome(), afterTurns = false, timeoutMs = afterTurns ? 3600000 : 15000, pollMs = afterTurns ? 500 : 50 } = {}) {
  const before = await statusInstalledService({ home });
  if (!before.running) return { stopped: true, alreadyStopped: true };
  if (afterTurns && !before.finishesTurns) throw fail('The connector running now is older than --after-turns and cannot let turns finish first. Nothing was stopped. Update it this once with service-stop, which ends the turns in progress, ideally while no agent is mid-turn. Later updates can use --after-turns.');
  ownedFile(join(home, OWNER));
  const holder = readPrivate(join(home, OWNER), true);
  if (holder.pid !== before.pid || typeof holder.nonce !== 'string') throw fail('The service ownership record differs from the authenticated process. No stop was requested.');
  const response = await control(readInstallation(home), afterTurns ? '/service/drain' : '/service/stop', 'POST', before.incarnation);
  if (response.stopping !== true || response.incarnation !== before.incarnation || afterTurns && response.afterTurns !== true) throw fail('The service changed during stop. Inspect status; no PID was signalled.');
  const until = Date.now() + timeoutMs;
  let state;
  do {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    state = await statusInstalledService({ home });
    if (!state.running) {
      try {
        ownedFile(join(home, OWNER));
        const current = readPrivate(join(home, OWNER), true);
        if (current.nonce !== holder.nonce) throw fail('A different service owns the installation. It was not stopped.');
      } catch (error) {
        if (error.code === 'ENOENT') return { stopped: true, ...(afterTurns ? { afterTurns: true } : {}), incarnation: before.incarnation };
        throw error;
      }
      continue; // Listener closed is not yet confirmed controller/guard cleanup.
    }
    if (state.incarnation !== before.incarnation) throw fail('A different service is running. It was not stopped.');
  } while (Date.now() < until);
  if (afterTurns && state?.draining) throw fail(`The service is still finishing ${state.turnsInProgress ?? 'its'} turn(s) and starts no new one; it stops by itself once they end. Run service-stop --after-turns again to keep waiting, or service-stop to end those turns now.`);
  throw fail('Service shutdown is not confirmed. Inspect status; no process was force-killed.');
}
export async function runInstalledService({ home = installationHome(), site, compose } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw fail('The shared Minions service requires Node.js 24 or newer.');
  if (typeof compose !== 'function') throw new TypeError('A trusted application composition is required.');
  const installation = await ensureInstallation({ home, site });
  const release = await claimOwnership(home);
  let composed, service, closing, draining, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const close = () => closing ??= (async () => {
    try { await service?.close(); } finally { try { await composed?.close?.(); } finally { await release(); resolveClosed(); } }
  })();
  // The service keeps serving the turns in progress, including their project tools, until they end.
  const drain = () => draining ??= (async () => { try { await composed?.controllers?.drain?.(); } finally { await close(); } })();
  const drainStatus = () => ({ draining: draining !== undefined, turnsInProgress: composed?.controllers?.drainStatus?.().turnsInProgress ?? 0 });
  try {
    composed = await compose({ home, site: installation.site, installation, getService: () => service });
    if (composed.principal?.site !== installation.site) throw fail('The approved account belongs to a different website.');
    service = await startRuntimeService({ ...composed, home, port: installation.port, token: installation.token, lifecycle: { stop: close, drain, drainStatus } });
    return { url: service.url, identity: service.identity, close, closed };
  } catch (error) { await close(); throw error; }
}
export async function startDetachedService({ home = installationHome(), site, entryPoint, args = [], timeoutMs = 20000 } = {}) {
  const installation = await ensureInstallation({ home, site });
  const previous = await statusInstalledService({ home });
  if (previous.running) return previous;
  if (typeof entryPoint !== 'string' || !isAbsolute(entryPoint) || !Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new TypeError('A packaged service entry point is required.');
  const path = join(home, 'service.log');
  // Logs grow normally; only structured installation records have the size bound.
  try { ownedFile(path, Infinity); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entryPoint, ...args], { detached: true, cwd: home, stdio: ['ignore', fd, fd],
      env: { ...process.env, MINIONS_SERVICE_HOME: home, MINIONS_SITE_URL: installation.site } });
  } finally { closeSync(fd); }
  let spawnError; child.on('error', error => { spawnError = error; }); child.unref();
  const until = Date.now() + timeoutMs;
  do {
    if (spawnError) throw fail(`The service could not start: ${spawnError.message}`);
    await new Promise(resolve => setTimeout(resolve, 75));
    const state = await statusInstalledService({ home });
    if (state.running && state.ready !== false) return state;
    if (child.exitCode !== null || child.signalCode !== null) throw fail(`The service exited before readiness. Inspect ${path}; no fallback was used.`);
  } while (Date.now() < until);
  throw fail(`Service readiness is not confirmed. Inspect ${path} and service status; no process was force-killed.`);
}
