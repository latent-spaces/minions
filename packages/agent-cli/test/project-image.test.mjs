import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadProjectImage, PROJECT_IMAGE_TOOL } from '../src/project-image.mjs';
import { ProjectOperations } from '../runtime/project-operations.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-image-')), folder = join(root, 'repo');
  await mkdir(folder); const filePath = join(folder, 'capture.png'); await writeFile(filePath, PNG);
  const calls = []; let mode = 'ok';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks); calls.push({ path: req.url, headers: req.headers, body });
    if (req.url === '/v2/mcp') {
      const rpc = JSON.parse(body); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [] } })); return;
    }
    if (mode === 'drop') { req.socket.destroy(); return; }
    if (mode === 'redirect') { res.writeHead(307, { location: '/redirect-target' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    if (mode === 'rate') { res.writeHead(429, { 'retry-after': '7' }); res.end(JSON.stringify({ error: 'rate_limited', message: 'secret-server-detail' })); return; }
    const receipt = { uploadId: 'a'.repeat(64), mimeType: req.headers['content-type'], width: 1, height: 1, byteSize: body.length, replayed: mode === 'replay', secret: 'never-return-this' };
    if (mode === 'huge') receipt.width = 5000;
    res.end(mode === 'invalid' ? 'not json: secret' : JSON.stringify(receipt));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = { url: `http://127.0.0.1:${server.address().port}`, token: 'private-token', runId: 'current-run', abort: new AbortController() };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, folder, filePath, calls, control, mode: value => { mode = value; } };
}

test('local image upload sends binary with the exact binding/run and returns only the ready receipt', async t => {
  const f = await fixture(t), input = { filePath: f.filePath, clientRequestId: 'capture_1' };
  const receipt = await uploadProjectImage(f.control, input, f.folder);
  assert.equal(receipt.uploadId, 'a'.repeat(64)); assert.equal(receipt.mimeType, 'image/png');
  assert.equal(receipt.secret, undefined); assert.equal(JSON.stringify(receipt).includes(f.filePath), false);
  assert.equal(f.calls[0].path, '/v2/progress/uploads/capture_1');
  assert.equal(f.calls[0].headers.authorization, 'Bearer private-token'); assert.equal(f.calls[0].headers['x-pilot-run'], 'current-run');
  assert.deepEqual(f.calls[0].body, PNG);
  f.mode('replay'); assert.equal((await uploadProjectImage(f.control, input, f.folder)).replayed, true);
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
});

test('invalid paths, escaped symlinks, special/oversized files and nonimages never leave the computer', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.png'); await writeFile(outside, PNG);
  const escaped = join(f.folder, 'escape.png'); await symlink(outside, escaped);
  const text = join(f.folder, 'fake.png'); await writeFile(text, 'private text');
  const oversized = join(f.folder, 'large.png'), tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1); PNG.copy(tooLarge); await writeFile(oversized, tooLarge);
  for (const filePath of ['relative.png', outside, escaped, f.folder, text, oversized, join(f.folder, 'missing.png')]) {
    await assert.rejects(uploadProjectImage(f.control, { filePath, clientRequestId: 'image' }, f.folder));
  }
  for (const input of [{ filePath: f.filePath, clientRequestId: '../other' }, { filePath: f.filePath, clientRequestId: 'a', token: 'no' }])
    await assert.rejects(uploadProjectImage(f.control, input, f.folder));
  for (const change of [{ runId: '' }, { closed: true }, { fatal: 'unauthorized' }])
    await assert.rejects(uploadProjectImage({ ...f.control, ...change }, { filePath: f.filePath, clientRequestId: 'a' }, f.folder));
  assert.equal(f.calls.length, 0);
});

test('uncertain uploads retain retry identity; redirects and untrusted reply fields are not followed or exposed', async t => {
  const f = await fixture(t), input = { filePath: f.filePath, clientRequestId: 'same_request' };
  for (const mode of ['drop', 'redirect', 'invalid', 'huge']) {
    f.mode(mode); const receipt = await uploadProjectImage(f.control, input, f.folder);
    assert.equal(receipt.error, 'upload_unconfirmed'); assert.equal(receipt.uploadId, undefined);
    assert.ok(!JSON.stringify(receipt).includes('secret'));
  }
  assert.ok(f.calls.every(call => call.path === '/v2/progress/uploads/same_request'));
  f.mode('rate'); const refused = await uploadProjectImage(f.control, input, f.folder);
  assert.equal(refused.error, 'rate_limited'); assert.equal(refused.retryAfterSeconds, 7);
  assert.ok(!JSON.stringify(refused).includes('secret-server-detail'));
  f.mode('replay'); assert.equal((await uploadProjectImage(f.control, input, f.folder)).replayed, true);
});

test('worker MCP advertises upload and uses its own approved folder, independently of the main-chat folder', async t => {
  const f = await fixture(t), workerFolder = join(f.root, 'worker'); await mkdir(workerFolder);
  const workerImage = join(workerFolder, 'screen.png'); await writeFile(workerImage, PNG);
  const bridge = new ProjectOperations(f.control, join(f.root, 'sends.json'), { folder: f.folder });
  t.after(() => bridge.close());
  const connection = await bridge.listen({ folder: workerFolder });
  const call = async (method, params = {}) => (await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  assert.ok((await call('tools/list')).result.tools.some(tool => tool.name === PROJECT_IMAGE_TOOL.name));
  const upload = filePath => call('tools/call', { name: PROJECT_IMAGE_TOOL.name, arguments: { filePath, clientRequestId: 'worker-capture' } });
  assert.equal((await upload(workerImage)).result.isError, undefined);
  assert.equal((await upload(f.filePath)).result.isError, true);
  const direct = await bridge.call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: PROJECT_IMAGE_TOOL.name, arguments: { filePath: f.filePath, clientRequestId: 'chat-capture' } } });
  assert.equal(direct.result.isError, undefined);
  assert.equal((await bridge.listen({ folder: f.folder })).url, connection.url);
  assert.equal((await upload(workerImage)).result.isError, true);
});
