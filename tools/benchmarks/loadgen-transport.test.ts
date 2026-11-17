import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { createTransportCauses, transportCause } from './loadgen-transport.js';

const wrapped = (cause: object, message = 'fetch failed') => Object.assign(new TypeError(message), { cause });

test('a system error keeps its code and syscall', () => {
  assert.equal(transportCause(wrapped(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' })), 'request'), 'request:ECONNRESET/read');
});

test('an undici socket error nested in the cause chain is named', () => {
  const socket = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
  assert.equal(transportCause(wrapped(socket, 'terminated'), 'body'), 'body:UND_ERR_SOCKET');
  const deeper = Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET', cause: Object.assign(new Error('y'), { code: 'EPIPE', syscall: 'write' }) });
  assert.equal(transportCause(wrapped(deeper), 'request'), 'request:EPIPE/write');
});

test('unsafe or missing codes never echo messages', () => {
  assert.equal(transportCause(wrapped({ code: 'Bearer secret token' }), 'request'), 'request:TypeError');
  assert.equal(transportCause('boom', 'request'), 'request:unknown');
});

test('a refused local connection is classified from a real fetch', async () => {
  const server: Server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  const error = await fetch(`http://127.0.0.1:${port}/`).then(() => null, (e: unknown) => e);
  assert.equal(transportCause(error, 'request'), 'request:ECONNREFUSED/connect');
});

test('a connection the server drops mid-request is classified', async () => {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const error = await fetch(`http://127.0.0.1:${port}/`).then(() => null, (e: unknown) => e);
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.match(transportCause(error, 'request'), /^request:(UND_ERR_SOCKET|ECONNRESET\/read)$/);
});

test('causes are counted per operation', () => {
  const causes = createTransportCauses();
  causes.record('project_control', 'request:ECONNRESET/read');
  causes.record('project_control', 'request:ECONNRESET/read');
  causes.record('control_post', 'body:UND_ERR_SOCKET');
  assert.deepEqual(causes.summary(), { 'control_post body:UND_ERR_SOCKET': 1, 'project_control request:ECONNRESET/read': 2 });
});

