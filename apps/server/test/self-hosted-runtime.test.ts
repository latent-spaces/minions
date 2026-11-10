import { createServer } from 'node:net';
import express from 'express';
import { expect, test } from 'vitest';
import { standaloneStopSignals, startSelfHostedRuntime } from '../src/self-hosted-runtime.js';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test('shutdown releases held HTTP work and waits for the worker before closing its shared store once', async () => {
  const app = express(), entered = gate(), release = gate(), workerStopped = gate();
  const events: string[] = [];
  app.get('/held', async (_req, res) => { entered.resolve(); await release.promise; res.end('done'); });
  const runtime = await startSelfHostedRuntime({ app, host: '127.0.0.1', port: 0,
    startWorker: () => ({ stop: async () => { events.push('worker-stop'); await workerStopped.promise; },
      queue: { drained: async () => { events.push('worker-drained'); } } }),
    drain: () => { events.push('http-drain'); release.resolve(); },
    closeStore: () => { events.push('store-close'); },
  });
  try {
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const request = fetch(`http://127.0.0.1:${address.port}/held`).then(response => response.text());
    await entered.promise;
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    expect(await request).toBe('done');
    expect(events).toEqual(['http-drain', 'worker-stop']);
    workerStopped.resolve();
    await closing;
    expect(events).toEqual(['http-drain', 'worker-stop', 'worker-drained', 'store-close']);
    await runtime.close();
    expect(events.filter(event => event === 'store-close')).toHaveLength(1);
  } finally { workerStopped.resolve(); await runtime.close(); }
});

test('a refused API bind closes the store without starting a delivery worker', async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  let started = false, closed = 0;
  try {
    await expect(startSelfHostedRuntime({ app: express(), host: '127.0.0.1', port: address.port,
      startWorker: () => { started = true; throw new Error('must not start'); },
      drain: () => {}, closeStore: () => { closed++; },
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(started).toBe(false);
    expect(closed).toBe(1);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

test('worker startup failure closes the API listener and store', async () => {
  let closed = 0;
  await expect(startSelfHostedRuntime({ app: express(), host: '127.0.0.1', port: 0,
    startWorker: () => { throw new Error('worker failed'); }, drain: () => {}, closeStore: () => { closed++; },
  })).rejects.toThrow('worker failed');
  expect(closed).toBe(1);
});

test('an open event stream is disconnected after the grace so the store can close', async () => {
  const app = express();
  app.get('/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: synthetic\n\n');
  });
  let closed = false;
  const runtime = await startSelfHostedRuntime({ app, host: '127.0.0.1', port: 0, httpGraceMs: 20,
    startWorker: () => ({ stop: async () => {}, queue: { drained: async () => {} } }),
    drain: () => {}, closeStore: () => { closed = true; },
  });
  const address = runtime.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  const response = await fetch(`http://127.0.0.1:${address.port}/events`);
  const reader = response.body!.getReader();
  try {
    expect((await reader.read()).done).toBe(false);
    const next = reader.read().catch(error => error);
    await runtime.close();
    expect(closed).toBe(true);
    expect(await next).toBeInstanceOf(Error);
  } finally { await reader.cancel().catch(() => {}); await runtime.close(); }
});

test('Windows also stops gracefully on Ctrl+Break and a closed console; POSIX leaves SIGHUP to nohup unless supervised', () => {
  for (const supervised of [false, true]) expect(standaloneStopSignals('win32', supervised)).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  for (const platform of ['darwin', 'linux'] as const) {
    expect(standaloneStopSignals(platform)).toEqual(['SIGINT', 'SIGTERM']);
    expect(standaloneStopSignals(platform, true)).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  }
});
