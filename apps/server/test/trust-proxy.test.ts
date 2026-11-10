import express from 'express';
import { expect, test } from 'vitest';
import { trustProxySetting } from '../src/trust-proxy.js';

test('unset or off keeps Express trusting no proxy', () => {
  for (const raw of [undefined, '', '  ', 'false', '0']) expect(trustProxySetting(raw)).toBeUndefined();
});

test('accepts a hop count or a list of subnets', () => {
  expect(trustProxySetting(' 2 ')).toBe(2);
  expect(trustProxySetting('loopback, 10.0.0.0/8,169.254.0.0/16, fd00::/8, ::1')).toEqual(['loopback', '10.0.0.0/8', '169.254.0.0/16', 'fd00::/8', '::1']);
});

test('refuses trust-everything and malformed values at startup', () => {
  for (const raw of ['true', 'TRUE', '01', '-1', '100', '1 2', '10.0.0/8', '300.0.0.1', '10.0.0.0/33', 'loopback,', 'localhost', 'aaaa', '*',
    ':', ':::1', '1:2', 'fd00::/129', 'fd00::/8/8', '10.0.0.0/08']) {
    expect(() => trustProxySetting(raw), raw).toThrow(/TRUST_PROXY/);
  }
});

async function clientAddress(raw: string | undefined, forwardedFor: string) {
  const app = express(), setting = trustProxySetting(raw);
  if (setting !== undefined) app.set('trust proxy', setting);
  app.get('/', (req, res) => { res.json(req.ip); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address() as { port: number };
    return await (await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': forwardedFor } })).json();
  } finally { server.close(); }
}

test('req.ip is the address the trusted proxy appended, never one the caller chose', async () => {
  const forwarded = '203.0.113.9, 198.51.100.7';
  expect(await clientAddress(undefined, forwarded)).toMatch(/127\.0\.0\.1$/);
  expect(await clientAddress('1', forwarded)).toBe('198.51.100.7');
  expect(await clientAddress('loopback', forwarded)).toBe('198.51.100.7');
});
