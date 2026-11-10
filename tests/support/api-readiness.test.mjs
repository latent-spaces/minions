import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeApiRefusal } from './api-readiness.mjs';

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); });
const stop = server => new Promise(resolve => server.close(resolve));
test('each readiness attempt closes its connection and sees the replacement listener', async () => {
  let connections = 0;
  const old = createServer((_req, res) => res.writeHead(401).end('{"error":"unauthorized","generation":1}'));
  old.on('connection', () => connections++);
  const port = await listen(old), url = `http://127.0.0.1:${port}/api/projects`;
  try {
    for (let i = 0; i < 2; i++) assert.match((await probeApiRefusal(url)).body, /generation":1/);
    assert.equal(connections, 2);
  } finally { await stop(old); }
  const replacement = createServer((_req, res) => res.writeHead(401).end('{"error":"unauthorized","generation":2}'));
  await listen(replacement, port);
  try { const result = await probeApiRefusal(url); assert.equal(result.status, 401); assert.match(result.body, /generation":2/); }
  finally { await stop(replacement); }
});
test('wrong responses remain visible and stalled headers/body are bounded', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/wrong') res.writeHead(503).end('not ready');
    else if (req.url === '/body') { res.writeHead(401); res.flushHeaders(); }
  });
  const port = await listen(server), url = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await probeApiRefusal(`${url}/wrong`), { status: 503, body: 'not ready' });
    for (const path of ['/headers', '/body']) await assert.rejects(probeApiRefusal(url + path, 100), /timed out/);
  } finally { server.closeAllConnections(); await stop(server); }
});
