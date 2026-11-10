import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionUser } from '../src/session-identity';
import { ApiError, authorizedRequest } from '../src/authorized-request';

test('owner start transport delivers selected profile header and original payload over HTTP', async () => {
  let delivered: { url?: string; method?: string; profile?: string; authorization?: string; body?: unknown } = {};
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    delivered = { url: req.url, method: req.method, profile: req.headers['x-mlswarm-profile-id'] as string, authorization: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ request: { state: 'pending' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const user = { uid: 'github-owner', getIdToken: async () => 'synthetic-token' } as unknown as SessionUser;
    const payload = { id: 'original-uuid', execution: { provider: 'codex', model: null }, approved: true };
    const result = await authorizedRequest(user, `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/owner`, '/web-agent-starts', payload, 'selected-profile', () => user.uid);
    assert.deepEqual(result, { request: { state: 'pending' } });
    assert.deepEqual(delivered, { url: '/api/owner/web-agent-starts', method: 'POST', profile: 'selected-profile', authorization: 'Bearer synthetic-token', body: payload });
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('a changed account fences the request before and after token resolution', async () => {
  let tokenCalls = 0;
  let uid = 'other-owner';
  const user = { uid: 'original-owner', getIdToken: async () => { tokenCalls++; uid = 'other-owner'; return 'synthetic'; } } as unknown as SessionUser;
  await assert.rejects(authorizedRequest(user, 'http://127.0.0.1:1/api/owner', '/web-agent-starts', {}, 'selected-profile', () => uid), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(tokenCalls, 0);
  uid = user.uid;
  await assert.rejects(authorizedRequest(user, 'http://127.0.0.1:1/api/owner', '/web-agent-starts', {}, 'selected-profile', () => uid), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(tokenCalls, 1);
});

test('all authenticated API reads and writes refuse a previous account before requesting its token', async t => {
  let tokenCalls = 0;
  const user = { uid: 'original-owner', getIdToken: async () => { tokenCalls++; return 'synthetic'; } } as unknown as SessionUser;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  for (const base of ['/community', '/api/platform', '/api/owner', '/p/project/api/join', '/api/feedback', '/api/projects']) {
    for (const body of [undefined, {}]) {
      await assert.rejects(authorizedRequest(user, base, '/test', body, undefined, () => 'other-owner'),
        (error: unknown) => error instanceof ApiError && error.status === 401);
    }
  }
  assert.equal(tokenCalls, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('account changes during token retrieval or response decoding fence unscoped reads and writes', async t => {
  for (const phase of ['token', 'response'] as const) {
    for (const body of [undefined, { name: 'Original account draft' }]) {
      let uid: string | undefined = 'original-owner';
      const user = { uid, getIdToken: async () => {
        if (phase === 'token') uid = undefined;
        return 'synthetic';
      } } as unknown as SessionUser;
      const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => { uid = 'other-owner'; return { name: 'Original account private data' }; },
      } as Response));
      await assert.rejects(authorizedRequest(user, '/community', '/my-profile', body, undefined, () => uid),
        (error: unknown) => error instanceof ApiError && error.status === 401);
      assert.equal(fetchMock.mock.callCount(), phase === 'token' ? 0 : 1);
      fetchMock.mock.restore();
    }
  }
});

test('same-account and callback-free sign-in requests remain available; selected profiles fail closed', async t => {
  const user = { uid: 'original-owner', getIdToken: async () => 'synthetic' } as unknown as SessionUser;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ accepted: true })));
  assert.deepEqual(await authorizedRequest(user, '/community', '/me', undefined, undefined, () => user.uid), { accepted: true });
  assert.deepEqual(await authorizedRequest(user, '/api/auth/github', '', { access_token: 'synthetic' }), { accepted: true });
  await assert.rejects(authorizedRequest(user, '/api/owner', '/test', {}, 'selected-profile'),
    (error: unknown) => error instanceof ApiError && error.status === 401);
});

test('project viewer reads coalesce in flight and wait out a refusal per project, without extra requests', async t => {
  const user = { uid: 'viewer', getIdToken: async () => 'synthetic' } as unknown as SessionUser;
  const calls: string[] = [];
  let refuse = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    await new Promise(resolve => setTimeout(resolve, 5));
    return refuse && url.startsWith('/p/busy/')
      ? new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many requests.' }), { status: 429, headers: { 'retry-after': '30' } })
      : new Response(JSON.stringify({ members: [], next: null }));
  });
  // The header, task labels and map each ask for the first members page on the same tick.
  await Promise.all([1, 2, 3].map(() => authorizedRequest(user, '/p/busy/api/view', '/members')));
  assert.deepEqual(calls, ['/p/busy/api/view/members']);
  refuse = true;
  await assert.rejects(authorizedRequest(user, '/p/busy/api/view', '/overview'), (error: unknown) => error instanceof ApiError && error.status === 429);
  // Every other poller for that project waits for the server's retry time instead of being refused again.
  await assert.rejects(authorizedRequest(user, '/p/busy/api/view', '/agents'),
    (error: unknown) => error instanceof ApiError && error.status === 429 && (error.retryAfterMs ?? 0) > 29_000);
  assert.equal(calls.length, 2);
  // Another project's budget is separate.
  await authorizedRequest(user, '/p/quiet/api/view', '/members');
  assert.equal(calls.length, 3);
});

test('a refusal seen in another tab holds the same person and project here, and nothing else', async t => {
  const user = { uid: 'tabbed-viewer', getIdToken: async () => 'synthetic' } as unknown as SessionUser;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true })));
  const otherTab = new BroadcastChannel('mlswarm-read-holds');
  otherTab.postMessage({ uid: 'tabbed-viewer', base: '/p/shared/api/view', until: Date.now() + 30_000 });
  otherTab.postMessage({ uid: 'tabbed-viewer', base: '/p/forged/api/view', until: 'soon' });
  otherTab.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(authorizedRequest(user, '/p/shared/api/view', '/overview'), (error: unknown) => error instanceof ApiError && error.status === 429);
  assert.equal(fetchMock.mock.callCount(), 0);
  // Another person, another project and malformed messages are unaffected.
  const other = { uid: 'someone-else', getIdToken: async () => 'synthetic' } as unknown as SessionUser;
  await authorizedRequest(other, '/p/shared/api/view', '/overview');
  await authorizedRequest(user, '/p/other/api/view', '/overview');
  await authorizedRequest(user, '/p/forged/api/view', '/overview');
  assert.equal(fetchMock.mock.callCount(), 3);
});

test('a presence request can time out while a server stops responding', async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const user = { uid: 'browser', getIdToken: async () => 'synthetic-token' } as unknown as SessionUser;
    await assert.rejects(authorizedRequest(user, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, '/web-presence',
      { profileIds: [] }, 'browser-profile', () => user.uid, AbortSignal.timeout(100)), { name: 'TimeoutError' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a write that times out is reported as unconfirmed and safe to retry', async t => {
  const user = { uid: 'owner', getIdToken: async () => 'synthetic' } as unknown as SessionUser;
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  await assert.rejects(authorizedRequest(user, '/api/owner', '/web-agent-starts', { id: 'request' }),
    (error: unknown) => error instanceof ApiError && error.status === 504 && error.code === 'not_confirmed');
  assert.ok(signal, 'writes carry a timeout signal');
});

test('a write whose reply is cut off by the timeout is unconfirmed, not a success', async t => {
  const user = { uid: 'owner', getIdToken: async () => 'synthetic' } as unknown as SessionUser;
  const timer = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => timer.signal);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => { timer.abort(new DOMException('The operation timed out.', 'TimeoutError')); throw new DOMException('The operation was aborted.', 'AbortError'); } }));
  await assert.rejects(authorizedRequest(user, '/api/owner', '/web-agent-starts', { id: 'request' }),
    (error: unknown) => error instanceof ApiError && error.status === 504 && error.code === 'not_confirmed');
});

test('a read whose reply is cut off by the timeout fails instead of answering nothing', async t => {
  const user = { uid: 'owner', getIdToken: async () => 'synthetic' } as unknown as SessionUser;
  const timer = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => timer.signal);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => { timer.abort(new DOMException('The operation timed out.', 'TimeoutError')); throw new DOMException('The operation was aborted.', 'AbortError'); } }));
  await assert.rejects(authorizedRequest(user, '/api/owner', '/needs-you'), { name: 'AbortError' });
});
