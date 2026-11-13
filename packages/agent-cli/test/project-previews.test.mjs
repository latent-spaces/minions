import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectPreviews, PREVIEW_TOOL } from '../src/service/project-previews.mjs';
import { createWorkerOperations } from '../src/service/worker-operations.mjs';

async function folders(t) {
  const root = await mkdtemp(join(tmpdir(), 'mlswarm-previews-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), work = join(root, 'work'), outside = join(root, 'outside');
  await mkdir(home, { mode: 0o700 }); await mkdir(join(work, 'game', 'levels'), { recursive: true }); await mkdir(join(work, '.git')); await mkdir(outside);
  await writeFile(join(work, 'game', 'index.html'), '<canvas></canvas><script src="game.js"></script>');
  await writeFile(join(work, 'game', 'game.js'), 'draw();');
  await writeFile(join(work, 'game', 'levels', 'index.html'), 'levels');
  await writeFile(join(work, 'game', '.env'), 'SECRET=1');
  await writeFile(join(work, '.git', 'config'), 'secret');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  return { root, home, work, outside };
}
// Raw requests, so the path and Host header reach the server exactly as written.
const get = (url, { path, method = 'GET', host } = {}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const req = request({ hostname: target.hostname, port: target.port, path: path ?? target.pathname, method, headers: host ? { Host: host } : {} }, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject); req.end();
});

test('the service serves files inside the chosen folder on loopback, and nothing else', async t => {
  const f = await folders(t);
  const previews = createProjectPreviews({ home: f.home });
  t.after(() => previews.close());
  const { url } = await previews.serve({ projectId: 'p1', agentId: 'a1', folder: f.work, root: 'game' });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
  assert.equal(previews.servedUrl('p1'), url);
  const page = await get(url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await get(url, { path: '/game.js' })).body, 'draw();');
  // Edits show on the next reload.
  await writeFile(join(f.work, 'game', 'game.js'), 'drawFaster();');
  assert.equal((await get(url, { path: '/game.js' })).body, 'drawFaster();');
  assert.equal((await get(url, { path: '/levels' })).status, 301);
  assert.equal((await get(url, { path: '/levels/' })).body, 'levels');
  for (const path of ['/.env', '/%2eenv', '/../.git/config', '/%2e%2e/.git/config', '/..%2f.git%2fconfig', '/..%5c.git%5cconfig', '/../outside/secret.txt', '/game.js::$DATA', '/game.js.', '/CON', '/missing.js'])
    assert.equal((await get(url, { path })).status, 404, path);
  assert.equal((await get(url, { method: 'POST' })).status, 405);
  assert.equal((await get(url, { host: 'attacker.example:80' })).status, 421);
  assert.equal((await get(url, { host: `localhost:${new URL(url).port}` })).status, 200);
});

test('a link that leaves the folder is not followed', { skip: process.platform === 'win32' && 'symbolic links need extra rights on Windows' }, async t => {
  const f = await folders(t);
  await symlink(join(f.outside, 'secret.txt'), join(f.work, 'game', 'leak.txt'));
  const previews = createProjectPreviews({ home: f.home });
  t.after(() => previews.close());
  const { url } = await previews.serve({ projectId: 'p1', agentId: 'a1', folder: f.work, root: 'game' });
  assert.equal((await get(url, { path: '/leak.txt' })).status, 404);
});

test('folders outside the working folder, dot folders and missing pages are refused', async t => {
  const f = await folders(t);
  const previews = createProjectPreviews({ home: f.home });
  t.after(() => previews.close());
  for (const root of ['..', '../outside', '.git', 'game/../..', 'C:/Windows', 'game\\..\\..'])
    await assert.rejects(previews.serve({ projectId: 'p1', agentId: 'a1', folder: f.work, root }), { code: 'bad_input' }, root);
  await assert.rejects(previews.serve({ projectId: 'p1', agentId: 'a1', folder: f.work, root: 'game', page: 'missing.html' }), { code: 'bad_input' });
  assert.equal(previews.servedUrl('p1'), null);
});

test('a preview survives a service restart on the same port, and stopping it forgets it', async t => {
  const f = await folders(t);
  const first = createProjectPreviews({ home: f.home });
  const { url } = await first.serve({ projectId: 'p1', agentId: 'a1', folder: f.work, root: 'game' });
  await first.close();
  await assert.rejects(get(url));
  const second = createProjectPreviews({ home: f.home });
  t.after(() => second.close());
  await second.restore({ folderFor: ({ projectId, agentId }) => projectId === 'p1' && agentId === 'a1' ? f.work : undefined });
  assert.equal(second.servedUrl('p1'), url);
  assert.equal((await get(url)).status, 200);
  // Serving again keeps the port.
  assert.equal((await second.serve({ projectId: 'p1', agentId: 'a1', folder: f.work, root: 'game' })).url, url);
  await second.stop('p1');
  await assert.rejects(get(url));
  const third = createProjectPreviews({ home: f.home });
  t.after(() => third.close());
  await third.restore({ folderFor: () => f.work });
  assert.equal(third.servedUrl('p1'), null);
});

test('a background agent serves its preview through the service, and a different link stops it', async t => {
  const f = await folders(t);
  const previews = createProjectPreviews({ home: f.home });
  t.after(() => previews.close());
  const stateDir = join(f.root, 'state'); await mkdir(stateDir, { mode: 0o700 });
  const target = { site: 'http://127.0.0.1:8787', ownerId: 'owner', projectId: 'project', agentId: 'agent' };
  const caller = { kind: 'worker', target, missionId: randomUUID(), generation: 1 };
  const mission = { target, missionId: caller.missionId, generation: 1, state: 'running', currentTurnId: randomUUID(), deadlineAt: Date.now() + 60000 };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const rpc = JSON.parse(options.body); calls.push(rpc);
    if (rpc.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'get_project' }, { name: 'set_project_preview' }] } });
    const value = rpc.params.name === 'get_project'
      ? { project: { started: true, paused: false, completedAt: null }, you: { agentId: 'agent', participation: { identity: { projectId: 'project', agentId: 'agent', profileId: 'owner' } } } }
      : { previewUrl: rpc.params.arguments.url || null };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
  };
  const ops = createWorkerOperations({ store: { getMission: async () => structuredClone(mission) }, resolveBinding: async () => ({ url: 'http://127.0.0.1:8787/p/project', token: 'test-secret', folder: f.work, stateDir }), fetchImpl, previews });
  t.after(() => ops.release(caller));
  assert.ok((await ops.listTools(caller)).some(tool => tool.name === PREVIEW_TOOL.name));
  await ops.callTool(caller, 'get_project', {});
  const reply = await ops.callTool(caller, PREVIEW_TOOL.name, { folder: 'game' });
  const served = previews.servedUrl('project');
  assert.match(served, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
  assert.deepEqual(calls.at(-1).params, { name: 'set_project_preview', arguments: { url: served } });
  assert.equal(JSON.parse(reply.content[0].text).previewUrl, served);
  assert.equal((await get(served)).status, 200);
  await ops.callTool(caller, 'set_project_preview', { url: 'https://example.com/game' });
  assert.equal(previews.servedUrl('project'), null);
  await assert.rejects(get(served));
  // Without set_project_preview offered by the project, the service offers no preview either.
  const without = createWorkerOperations({ store: { getMission: async () => structuredClone(mission) }, resolveBinding: async () => ({ url: 'http://127.0.0.1:8787/p/project', token: 'test-secret', folder: f.work, stateDir }),
    fetchImpl: async (url, options) => { const rpc = JSON.parse(options.body); return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'get_project' }] } }); }, previews });
  t.after(() => without.release(caller));
  assert.ok(!(await without.listTools(caller)).some(tool => tool.name === PREVIEW_TOOL.name));
});
