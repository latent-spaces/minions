import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { serveFolder } = createRequire(import.meta.url)('../src/shot.cjs');
// node:http lets a test set the Host header and send raw request paths, which fetch does not.
const get = (port, path, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});

test('the screenshot server serves its folder and refuses bad paths and other hosts without stopping', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-shot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'page.html'), '<p>ok</p>');
  const port = await serveFolder(root);
  assert.equal(await get(port, '/page.html'), 200);
  assert.equal(await get(port, '/%E0%A4%A'), 400);
  assert.equal(await get(port, '/page.html%00'), 400);
  assert.equal(await get(port, '/..%2f..%2fetc%2fpasswd'), 403);
  assert.equal(await get(port, '/page.html', 'attacker.example:80'), 403);
  // Still serving after every refusal.
  assert.equal(await get(port, '/page.html'), 200);
});
