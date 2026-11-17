import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, mkdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { withOperationLock } from '../operation-lock.mjs';
import { writePrivate } from '../state.mjs';
import { validateTarget } from './contracts.mjs';

const FILE = 'runtime-endpoint.json';
const MAX_BYTES = 8192;
const fail = () => new Error('Private runtime endpoint is unavailable or invalid. Start the selected shared runtime; no fallback was used.');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function owned(stat) {
  return process.platform === 'win32' || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
}
function directory(home, create = false) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw fail();
  if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw fail();
  return home;
}
function validate(value) {
  if (!exact(value, ['version', 'url', 'token', 'identity', 'principal']) || value.version !== 1
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || !exact(value.identity, ['version', 'incarnation', 'pid', 'transport', 'cloudReady'])
    || value.identity.version !== 2 || !uuid(value.identity.incarnation) || !Number.isSafeInteger(value.identity.pid) || value.identity.pid < 1
    || value.identity.transport !== 'streamable-http' || value.identity.cloudReady !== false
    || !exact(value.principal, ['site', 'ownerId'])) throw fail();
  let endpoint;
  try { endpoint = new URL(value.url); validateTarget({ ...value.principal, projectId: 'endpoint', agentId: 'endpoint' }); }
  catch { throw fail(); }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/mcp'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.href !== value.url) throw fail();
  return value;
}
/** Only the trusted gateway writes this record. A descriptor is discovery, never proof that its process is ready. */
export function readRuntimeEndpoint(home) {
  let fd;
  try {
    directory(home);
    const path = join(home, FILE), named = lstatSync(path);
    if (named.isSymbolicLink()) throw fail();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_BYTES || named.dev !== stat.dev || named.ino !== stat.ino) throw fail();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, count;
    do { count = readSync(fd, bytes, size, bytes.length - size); size += count; } while (count && size < bytes.length);
    if (size > MAX_BYTES) throw fail();
    return validate(JSON.parse(bytes.toString('utf8', 0, size)));
  } catch { throw fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export async function publishRuntimeEndpoint({ home, url, token, identity, principal }) {
  directory(home, true);
  const value = validate(structuredClone({ version: 1, url, token, identity, principal }));
  return withOperationLock(home, async () => {
    let existing;
    try { lstatSync(join(home, FILE)); existing = readRuntimeEndpoint(home); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(value)) return existing;
      // The same crash that leaves service-owner.json leaves this record, naming the same possibly reused PID.
      if (alive(existing.identity.pid)) throw new Error(`Process ${existing.identity.pid} is recorded as the runtime of ${join(home, FILE)} and is still running. If it is not a Minions service (check it in your system's process list), a crash left this record: remove it and start again. No process or credentials were changed.`);
    }
    writePrivate(join(home, FILE), value);
    return value;
  });
}
export async function removeRuntimeEndpoint({ home, incarnation }) {
  if (!uuid(incarnation)) throw fail();
  directory(home);
  return withOperationLock(home, async () => {
    try { lstatSync(join(home, FILE)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const existing = readRuntimeEndpoint(home);
    if (existing.identity.incarnation !== incarnation) return false;
    unlinkSync(join(home, FILE));
    return true;
  });
}
