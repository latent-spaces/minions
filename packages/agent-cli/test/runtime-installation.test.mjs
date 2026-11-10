import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureInstallation, readInstallation, installationHeaderHelper, runInstalledService, statusInstalledService, stopInstalledService, startDetachedService } from '../src/service/installation.mjs';
import { readRuntimeEndpoint } from '../src/service/endpoint-file.mjs';
const exec = promisify(execFile), site = 'http://127.0.0.1:8787';
const fixture = fileURLToPath(new URL('./fixtures/runtime-installed-service.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanups = new Map();
function cleanup(home, task) { cleanups.get(home).push(task); }
async function folder(t) {
  const home = await mkdtemp(join(tmpdir(), 'mlswarm installation with spaces-'));
  cleanups.set(home, []);
  t.after(async () => {
    try { for (const task of cleanups.get(home).reverse()) await task(); }
    finally { cleanups.delete(home); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  return home;
}
function composition(site) {
  return { principal: { site, ownerId: 'synthetic-owner' }, controllers: { health: async () => ({ ready: true }) },
    application: { listTools: () => [], callTool: async () => { throw new Error('No models.'); } }, close: async () => {} };
}

test('stable private installation and host-only header helper survive package and service changes', async t => {
  const home = await folder(t), first = await ensureInstallation({ home, site });
  assert.deepEqual(await ensureInstallation({ home, site }), first);
  assert.ok(first.port > 0); assert.equal(first.token.length, 64);
  if (process.platform !== 'win32') assert.equal((await stat(join(home, 'installation.json'))).mode & 0o777, 0o600);
  const helper = installationHeaderHelper(home);
  if (process.platform !== 'win32') assert.equal((await stat(helper)).mode & 0o777, 0o700);
  const output = await exec(process.execPath, [helper]);
  assert.deepEqual(JSON.parse(output.stdout), { Authorization: `Bearer ${first.token}` });
  assert.equal(output.stderr, '');
  await assert.rejects(ensureInstallation({ home, site: 'http://127.0.0.1:5174' }), /different website/);
  assert.deepEqual(readInstallation(home), first);
  if (process.platform === 'win32') return; // POSIX modes and file symlinks are not Windows privacy guarantees.
  await chmod(join(home, 'installation.json'), 0o644);
  await assert.rejects(exec(process.execPath, [helper]), /private service credential/);
  await chmod(join(home, 'installation.json'), 0o600);
  const external = join(home, 'outside.json'); await writeFile(external, JSON.stringify(first), { mode: 0o600 });
  await unlink(join(home, 'installation.json')); await symlink(external, join(home, 'installation.json'));
  assert.throws(() => readInstallation(home), /Unsafe installation/);
  await assert.rejects(exec(process.execPath, [helper]), /private service credential/);
});

test('one authenticated lifecycle endpoint preserves stable port and token across restart', async t => {
  const home = await folder(t);
  assert.deepEqual(await statusInstalledService({ home }), { running: false, installed: false });
  let closed = 0;
  const compose = async ({ site }) => ({ ...composition(site), close: async () => { await delay(100); closed++; } });
  const first = await runInstalledService({ home, site, compose });
  cleanup(home, () => first.close());
  const config = readInstallation(home), status = await statusInstalledService({ home });
  assert.equal(status.running, true); assert.equal(status.url, first.url);
  assert.equal(JSON.stringify(status).includes(config.token), false);
  assert.equal(readRuntimeEndpoint(home).token, config.token);
  await assert.rejects(runInstalledService({ home, site, compose }), /live process owns/);
  const base = `http://127.0.0.1:${config.port}`;
  assert.equal((await fetch(`${base}/service/stop`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/service/status`, { headers: { Authorization: `Bearer ${config.token}`, Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await fetch(`${base}/service/stop`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'X-Mlswarm-Incarnation': status.incarnation }, body: 'payload' })).status, 400);
  const stopped = await stopInstalledService({ home });
  assert.equal(stopped.stopped, true); await first.closed; assert.equal(closed, 1);
  const second = await runInstalledService({ home, site, compose }); cleanup(home, () => second.close());
  assert.equal(second.url, first.url); assert.notEqual(second.identity.incarnation, first.identity.incarnation);
  assert.equal((await fetch(`${base}/service/stop`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'X-Mlswarm-Incarnation': first.identity.incarnation } })).status, 409);
  assert.equal((await statusInstalledService({ home })).incarnation, second.identity.incarnation);
  assert.deepEqual(readInstallation(home), config);
  await second.close();
});

test('detached packaged entry survives its launcher, stops by auth and recovers a confirmed dead owner', async t => {
  const home = await folder(t);
  const started = await startDetachedService({ home, site, entryPoint: fixture });
  cleanup(home, async () => { await stopInstalledService({ home }); });
  assert.equal(started.running, true); assert.notEqual(started.pid, process.pid);
  assert.deepEqual(await startDetachedService({ home, site, entryPoint: fixture }), started);
  const config = readInstallation(home);
  // Kill only this test-created, authenticated fixture. Startup never signals it.
  process.kill(started.pid, 'SIGKILL');
  let dead = false;
  for (let i = 0; i < 100; i++) { if (!(await statusInstalledService({ home })).running) { dead = true; break; } await delay(20); }
  assert.equal(dead, true);
  // Allow the child-process exit event to reap its PID before dead-lock recovery.
  await delay(50);
  // Ordinary accumulated diagnostics must not prevent a safe service restart.
  await writeFile(join(home, 'service.log'), 'synthetic log\n'.repeat(2000), {mode: 0o600});
  const recovered = await startDetachedService({ home, site, entryPoint: fixture });
  assert.equal(recovered.running, true); assert.notEqual(recovered.incarnation, started.incarnation);
  assert.deepEqual(readInstallation(home), config);
  assert.equal((await stopInstalledService({ home })).stopped, true);
});

test('unhealthy storage is reported without preventing authenticated service stop', async t => {
  const home=await folder(t);
  const service=await runInstalledService({home,site,compose:async()=>({...composition(site),controllers:{health:async()=>{throw Error('Synthetic storage fault');}}})});
  cleanup(home, ()=>service.close());
  const status=await statusInstalledService({home});
  assert.equal(status.running,true);assert.equal(status.ready,false);
  assert.equal((await stopInstalledService({home})).stopped,true);
});
