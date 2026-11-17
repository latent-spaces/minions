import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureInstallation, statusInstalledService } from '../src/service/installation.mjs';

// The port is chosen once and saved. When another program later listens there, say so instead of
// reporting a failed sign-in.
test('service status names another program on the saved port, and keeps the sign-in refusal for the service', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'service');
  await mkdir(home, { mode: 0o700 });
  const { port } = await ensureInstallation({ home, site: 'http://127.0.0.1:18787' });
  let reply = (_req, res) => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<h1>Not found</h1>'); };
  const server = http.createServer((req, res) => reply(req, res));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(statusInstalledService({ home }), new RegExp(`Another program answers on the service's port ${port}`));
  reply = (_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify({ error: 'unauthorized' })); };
  await assert.rejects(statusInstalledService({ home }), /did not authenticate/);
});
