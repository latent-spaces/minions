import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProjectOutput, uploadProjectOutput } from '../src/project-output.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'k42-static-output-')), output = join(root, 'built output');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(output, 'assets'), { recursive: true });
  await writeFile(join(output, 'index.html'), '<script src="./assets/game.js"></script>');
  await writeFile(join(output, 'assets/game.js'), 'window.gameStarted=true;');
  const control = { url: `https://karma.example/p/${'a'.repeat(64)}`, token: 'synthetic-private-agent-token', runId: 'synthetic-current-run', closed: false, abort: new AbortController() };
  return { root, output, control };
}
test('portable clean folder with spaces yields one canonical bounded inventory', async t => {
  const f = await fixture(t), build = await inspectProjectOutput(f.root, f.output);
  assert.deepEqual(build.artifact.manifest.files.map(file => file.path), ['assets/game.js', 'index.html']);
  assert.ok(build.artifact.bytes > 0); assert.match(build.artifact.digest, /^[a-f0-9]{64}$/);
  assert.equal('bytes' in build, false, 'the whole build is not retained in memory');
});
test('outside folders, hidden secrets, symlinks and hardlinks are refused', async t => {
  const f = await fixture(t);
  await assert.rejects(inspectProjectOutput(f.output, f.root), /inside/);
  await writeFile(join(f.output, '.env'), 'synthetic-secret');
  await assert.rejects(inspectProjectOutput(f.root, f.output), /path/); await rm(join(f.output, '.env'));
  await symlink(join(f.output, 'index.html'), join(f.output, 'linked.html'));
  await assert.rejects(inspectProjectOutput(f.root, f.output), /symbolic|junction/); await rm(join(f.output, 'linked.html'));
  await link(join(f.output, 'index.html'), join(f.output, 'hardlink.html'));
  await assert.rejects(inspectProjectOutput(f.root, f.output), /unlinked/);
});
test('approval-mode upload stages exact bytes and never requests publication', async t => {
  const f = await fixture(t), calls = [], candidateId = 'b'.repeat(64);
  const artifact = (await inspectProjectOutput(f.root, f.output)).artifact;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, `Bearer ${f.control.token}`);
    assert.equal(options.headers['x-pilot-run'], f.control.runId);
    if (url.endsWith('/status')) return Response.json({ digest: artifact.digest, uploaded: [] });
    if (options.method === 'GET') return Response.json({ configured: true, policy: { enabled: true, revision: 1, mode: 'approval' } });
    if (url.endsWith('/candidates')) return Response.json({ candidateId, state: 'uploading' });
    if (url.endsWith('/seal')) return Response.json({ state: 'ready' });
    return Response.json({ uploaded: true });
  };
  const result = await uploadProjectOutput(f.control, { directoryPath: f.output, clientRequestId: 'same-request' }, f.root, { fetchImpl });
  assert.equal(result.state, 'awaiting_approval'); assert.equal(calls.some(call => call.url.endsWith('/publications')), false);
  assert.equal(calls.filter(call => call.url.includes('/files/')).length, 2);
  const prepare = JSON.parse(calls.find(call => call.url.endsWith('/candidates')).options.body);
  assert.equal(prepare.clientRequestId, 'same-request'); assert.equal(JSON.stringify(prepare).includes(f.output), false);
});
test('automatic mode requests activation only after sealing, preserving the original request identity', async t => {
  const f = await fixture(t), calls = [], candidateId = 'b'.repeat(64);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return Response.json({ configured: true, policy: { enabled: true, revision: 4, mode: 'automatic' } });
    if (url.endsWith('/candidates')) return Response.json({ candidateId, state: 'ready' });
    if (url.endsWith('/publications')) return Response.json({ id: 'c'.repeat(64), state: 'uncertain' });
    throw new Error('Unexpected upload after already sealed candidate');
  };
  const result = await uploadProjectOutput(f.control, { directoryPath: f.output, clientRequestId: 'stable' }, f.root, { fetchImpl });
  assert.equal(result.state, 'uncertain');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { clientRequestId: 'stable-publish', candidateId, policyRevision: 4 });
});
test('bytes changed after reservation are refused before transmission', async t => {
  const f = await fixture(t), sent = [];
  const artifact = (await inspectProjectOutput(f.root, f.output)).artifact;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/status')) return Response.json({ digest: artifact.digest, uploaded: [] });
    if (options.method === 'GET') return Response.json({ configured: true, policy: { enabled: true, revision: 1, mode: 'approval' } });
    if (url.endsWith('/candidates')) {
      await writeFile(join(f.output, 'assets/game.js'), 'private changed bytes');
      return Response.json({ candidateId: 'b'.repeat(64), state: 'uploading' });
    }
    sent.push(url); return Response.json({ uploaded: true });
  };
  await assert.rejects(uploadProjectOutput(f.control, { directoryPath: f.output, clientRequestId: 'stable' }, f.root, { fetchImpl }), /changed after reservation/);
  assert.equal(sent.length, 0);
});
test('stopped or expired connection cannot inspect files or make network calls', async t => {
  const f = await fixture(t); f.control.closed = true;
  await assert.rejects(uploadProjectOutput(f.control, { directoryPath: f.output, clientRequestId: 'stable' }, f.root, { fetchImpl: () => assert.fail('network call') }), /unavailable/);
});
test('resumed uploads skip the exact already-received inventory', async t => {
  const f = await fixture(t), artifact = (await inspectProjectOutput(f.root, f.output)).artifact, sent = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/status')) return Response.json({ digest: artifact.digest, uploaded: [0] });
    if (options.method === 'GET') return Response.json({ configured: true, policy: { enabled: true, revision: 1, mode: 'approval' } });
    if (url.endsWith('/candidates')) return Response.json({ candidateId: 'b'.repeat(64), state: 'uploading' });
    if (url.endsWith('/seal')) return Response.json({ state: 'ready' });
    sent.push(url); return Response.json({ uploaded: true });
  };
  await uploadProjectOutput(f.control, { directoryPath: f.output, clientRequestId: 'resumed' }, f.root, { fetchImpl });
  assert.equal(sent.length, 1); assert.match(sent[0], /\/files\/1$/);
});
test('Stop aborts capacity backoff without sending another request', async t => {
  const f = await fixture(t); let calls = 0;
  const fetchImpl = async () => {
    calls++; setTimeout(() => f.control.abort.abort(), 10);
    return Response.json({ message: 'busy' }, { status: 429, headers: { 'Retry-After': '60' } });
  };
  await assert.rejects(uploadProjectOutput(f.control, { directoryPath: f.output, clientRequestId: 'bounded' }, f.root, { fetchImpl }), /abort/i);
  assert.equal(calls, 1);
});
