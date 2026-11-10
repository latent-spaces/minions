import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLoopbackOnlyNetwork, isLoopbackHost } from './loopback-only-network.mjs';

// The guard must refuse these before any packet leaves, so the tests need no outside network.
const OUTSIDE = 'https://firestore.googleapis.com/v1/projects/demo-x/databases/(default)/documents/a/b';

async function withGuard(t, run) {
  const guard = installLoopbackOnlyNetwork();
  t.after(() => guard.uninstall());
  return run(guard);
}
async function loopbackServer(t, host = '127.0.0.1') {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('only loopback names and addresses count as local', () => {
  for (const host of [undefined, '', 'localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.255.0.9', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, String(host));
  }
  for (const host of ['0.0.0.0', '10.0.0.1', '128.0.0.1', '8.8.8.8', '::', 'firestore.googleapis.com', 'metadata.google.internal',
    '169.254.169.254', 'localhost.evil.test', '127.0.0.1.nip.io']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('loopback HTTP keeps working through fetch and http while the guard is installed', async t => {
  const port = await loopbackServer(t);
  await withGuard(t, async guard => {
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'ok');
    const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }).on('end', () => resolve(text));
    }).on('error', reject));
    assert.equal(body, 'ok');
    assert.deepEqual(guard.refused, []);
  });
});

test('fetch to a Google API host is refused and recorded', async t => {
  await withGuard(t, async guard => {
    await assert.rejects(fetch(OUTSIDE), error => /Loopback-only/.test(String(error.cause?.message ?? error.message)));
    assert.ok(guard.refused.some(entry => entry.includes('firestore.googleapis.com')), JSON.stringify(guard.refused));
  });
});

test('raw TCP to an IP literal is refused without DNS, and its error reaches the socket', async t => {
  await withGuard(t, async guard => {
    const error = await new Promise(resolve => net.connect(53, '8.8.8.8').once('error', resolve).once('connect', () => resolve(null)));
    assert.equal(error?.code, 'ERR_LOOPBACK_ONLY');
    assert.deepEqual(guard.refused, ['8.8.8.8:53']);
  });
});

test('DNS lookups of outside names are refused in callback and promise forms; localhost still resolves', async t => {
  await withGuard(t, async guard => {
    const error = await new Promise(resolve => dns.lookup('metadata.google.internal', resolve));
    assert.equal(error?.code, 'ERR_LOOPBACK_ONLY');
    await assert.rejects(dns.promises.lookup('oauth2.googleapis.com'), { code: 'ERR_LOOPBACK_ONLY' });
    const local = await dns.promises.lookup('localhost');
    assert.ok(isLoopbackHost(local.address), local.address);
    assert.deepEqual(guard.refused, ['dns:metadata.google.internal', 'dns:oauth2.googleapis.com']);
  });
});

test('direct DNS queries (resolve*, reverse, Resolver) are refused in every form, even for localhost', async t => {
  await withGuard(t, async guard => {
    const callbackError = await new Promise(resolve => dns.resolve4('example.com', resolve));
    assert.equal(callbackError?.code, 'ERR_LOOPBACK_ONLY');
    const viaResolver = await new Promise(resolve => new dns.Resolver().resolveTxt('example.com', resolve));
    assert.equal(viaResolver?.code, 'ERR_LOOPBACK_ONLY');
    await assert.rejects(dns.promises.resolve('localhost'), { code: 'ERR_LOOPBACK_ONLY' });
    await assert.rejects(new dns.promises.Resolver().resolve6('example.com'), { code: 'ERR_LOOPBACK_ONLY' });
    await assert.rejects(dns.promises.reverse('8.8.8.8'), { code: 'ERR_LOOPBACK_ONLY' });
    assert.deepEqual(guard.refused, ['dns-resolve4:example.com', 'dns-resolveTxt:example.com', 'dns-resolve:localhost',
      'dns-resolve6:example.com', 'dns-reverse:8.8.8.8']);
  });
});

test('localhost names resolve through the system and only loopback answers are accepted', async t => {
  await withGuard(t, async guard => {
    const all = await dns.promises.lookup('localhost', { all: true });
    assert.ok(all.length > 0 && all.every(entry => isLoopbackHost(entry.address)), JSON.stringify(all));
    const one = await new Promise((resolve, reject) => dns.lookup('localhost', (error, address) => (error ? reject(error) : resolve(address))));
    assert.ok(isLoopbackHost(one), one);
    assert.deepEqual(guard.refused, []);
  });
});

test('UDP to an outside address is refused; loopback UDP still works', async t => {
  const receiver = dgram.createSocket('udp4');
  await new Promise(resolve => receiver.bind(0, '127.0.0.1', resolve));
  t.after(() => receiver.close());
  await withGuard(t, async guard => {
    const sender = dgram.createSocket('udp4');
    t.after(() => sender.close());
    const outside = await new Promise(resolve => sender.send('x', 53, '8.8.8.8', resolve));
    assert.equal(outside?.code, 'ERR_LOOPBACK_ONLY');
    const arrived = new Promise(resolve => receiver.once('message', message => resolve(String(message))));
    await new Promise((resolve, reject) => sender.send('ping', receiver.address().port, '127.0.0.1', error => (error ? reject(error) : resolve())));
    assert.equal(await arrived, 'ping');
    const connected = dgram.createSocket('udp4');
    t.after(() => connected.close());
    const connectError = await new Promise(resolve => connected.connect(53, '8.8.8.8', resolve));
    assert.equal(connectError?.code, 'ERR_LOOPBACK_ONLY');
    assert.deepEqual(guard.refused, ['udp:8.8.8.8', 'udp:8.8.8.8:53']);
  });
});

test('HTTP/2, which gRPC uses, cannot reach an outside host', async t => {
  await withGuard(t, async guard => {
    const session = http2.connect('https://firestore.googleapis.com');
    const error = await new Promise(resolve => session.once('error', resolve).once('connect', () => resolve(null)));
    session.destroy();
    assert.equal(error?.code, 'ERR_LOOPBACK_ONLY');
    assert.ok(guard.refused.some(entry => entry.startsWith('firestore.googleapis.com')), JSON.stringify(guard.refused));
  });
});

// A child process, because the SDK keeps retrying an unavailable channel after the attempt we wait for.
const firestoreProbe = `
import { installLoopbackOnlyNetwork } from ${JSON.stringify(new URL('./loopback-only-network.mjs', import.meta.url).href)};
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const guard = installLoopbackOnlyNetwork();
const db = getFirestore(initializeApp({ projectId: 'demo-loopback-guard' }));
let outcome = 'pending';
db.doc('guard/probe').get().then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
for (let waited = 0; !guard.refused.length && waited < 15000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
process.stdout.write(JSON.stringify({ refused: guard.refused, outcome }));
process.exit(0);
`;
test('a Firestore client with no emulator cannot reach Google while guarded', async () => {
  const env = { ...process.env };
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) delete env[key];
  const child = spawn(process.execPath, ['--input-type=module', '-e', firestoreProbe], { env, cwd: fileURLToPath(new URL('.', import.meta.url)) });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, stderr);
  const { refused, outcome } = JSON.parse(stdout);
  assert.ok(refused.some(entry => /googleapis\.com|google\.internal|169\.254\.169\.254/.test(entry)), stdout);
  assert.notEqual(outcome, 'resolved');
});

// gRPC tunnels through a configured proxy with HTTP CONNECT; a loopback proxy would otherwise
// be an allowed local hop to any outside host.
test('proxy settings are switched off while guarded and restored exactly afterwards', t => {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'GRPC_PROXY', 'grpc_proxy', 'ALL_PROXY', 'NO_PROXY', 'no_grpc_proxy', 'HTTP_PROXY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { HTTPS_PROXY: 'http://127.0.0.1:3128', grpc_proxy: 'http://localhost:3128', NO_PROXY: 'example.test' });
  const guard = installLoopbackOnlyNetwork();
  try {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'GRPC_PROXY', 'grpc_proxy', 'ALL_PROXY', 'HTTP_PROXY']) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.NO_PROXY, '*');
    assert.equal(process.env.no_grpc_proxy, '*');
  } finally { guard.uninstall(); }
  assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:3128');
  assert.equal(process.env.grpc_proxy, 'http://localhost:3128');
  assert.equal(process.env.NO_PROXY, 'example.test');
  for (const key of ['https_proxy', 'GRPC_PROXY', 'ALL_PROXY', 'no_grpc_proxy', 'HTTP_PROXY']) assert.equal(process.env[key], undefined, key);
});

// The preload guards a whole child process (the standalone engine CLI) and reports through a file.
const preload = new URL('./loopback-only-network-preload.mjs', import.meta.url).href;
async function guardedChild(t, script, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mlswarm-guard-preload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'refused.json');
  const child = spawn(process.execPath, ['--import', preload, '--input-type=module', '-e', script],
    { env: { ...process.env, MLSWARM_TEST_NETWORK_LOG: log, ...env } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  return { code, stderr, refused: await readFile(log, 'utf8').then(JSON.parse, () => null) };
}

test('the preload guards a child process from its first line and writes its refusal log on exit', async t => {
  const quiet = await guardedChild(t, `await fetch('http://127.0.0.1:9/').catch(() => {});`);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.deepEqual(quiet.refused, []);
  const leaky = await guardedChild(t, `await fetch('https://oauth2.googleapis.com/token').catch(() => {}); process.exit(3);`);
  assert.equal(leaky.code, 3);
  assert.ok(leaky.refused.some(entry => entry.includes('oauth2.googleapis.com')), JSON.stringify(leaky.refused));
});

test('the preload refuses to run without an absolute refusal log path', async t => {
  const missing = await guardedChild(t, 'process.exit(0);', { MLSWARM_TEST_NETWORK_LOG: 'relative.json' });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /MLSWARM_TEST_NETWORK_LOG/);
  assert.equal(missing.refused, null);
});

test('uninstall restores the original functions and only one guard installs at a time', t => {
  const snapshot = () => [net.Socket.prototype.connect, dns.lookup, dns.promises.lookup, dns.resolve4, dns.reverse,
    dns.Resolver.prototype.resolveTxt, dns.promises.resolve, dns.promises.Resolver.prototype.resolve6,
    dgram.Socket.prototype.send, dgram.Socket.prototype.connect];
  const before = snapshot();
  const guard = installLoopbackOnlyNetwork();
  t.after(() => guard.uninstall());
  assert.throws(() => installLoopbackOnlyNetwork(), /already installed/);
  snapshot().forEach((value, index) => assert.notEqual(value, before[index], `patched ${index}`));
  guard.uninstall();
  assert.deepEqual(snapshot(), before);
  installLoopbackOnlyNetwork().uninstall();
});
