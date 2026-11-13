import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { expect, test } from 'vitest';
import { engineStopKey, engineStopRoute } from '../src/self-hosted-stop.js';

async function serve(key: string) {
  let stops = 0;
  const app = express();
  app.use('/stop', engineStopRoute({ key, requestStop: () => { stops++; } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stop`;
  return { url, stops: () => stops, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the stop key is derived from the owner file secret and differs between owner files', () => {
  const secret = randomBytes(32).toString('hex');
  expect(engineStopKey(secret)).toBe(engineStopKey(secret));
  expect(engineStopKey(secret)).not.toBe(engineStopKey(randomBytes(32).toString('hex')));
  expect(engineStopKey(secret)).not.toContain(secret);
});

test('only the stop command with this owner file\'s key stops the engine; no web page can', async () => {
  const key = engineStopKey(randomBytes(32).toString('hex'));
  const engine = await serve(key);
  try {
    const refused: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${key}x` },
      { authorization: `Bearer ${key}`, origin: 'http://127.0.0.1:8789' }, { authorization: `Bearer ${key}`, origin: 'https://example.com' }];
    for (const headers of refused) {
      expect((await fetch(engine.url, { method: 'POST', headers })).status).toBe(403);
    }
    expect(engine.stops()).toBe(0);
    const accepted = await fetch(engine.url, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
    expect(accepted.status).toBe(202);
    await expect.poll(engine.stops).toBe(1);
  } finally { await engine.close(); }
});
