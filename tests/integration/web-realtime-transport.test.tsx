import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SessionUser } from '../../apps/web/src/session-identity';

const account = vi.hoisted(() => ({ currentUser: { uid: 'alice' } as { uid: string } | null }));
vi.mock('../../apps/web/src/api', () => ({ session: { currentUid: () => account.currentUser?.uid } }));
import { subscribeRealtime } from '../../apps/web/src/realtime';

const close: (() => void)[] = [];
let visibility: DocumentVisibilityState;
let documentEvents: EventTarget;
const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
const user = { uid: 'alice', getIdToken: async () => 'private-token' } as SessionUser;
const encode = (topics: string[]) => new TextEncoder().encode(`data: ${JSON.stringify({ topics })}\n\n`);

beforeEach(() => {
  vi.useFakeTimers(); account.currentUser = { uid: 'alice' }; visibility = 'visible'; streams.length = 0;
  documentEvents = new EventTarget(); Object.defineProperty(documentEvents, 'visibilityState', { get: () => visibility });
  vi.stubGlobal('document', documentEvents);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      streams.push(controller);
      options.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }));
});
afterEach(async () => {
  for (const stop of close.splice(0)) stop();
  await vi.advanceTimersByTimeAsync(0); vi.unstubAllGlobals(); vi.useRealTimers();
});
const subscribe = (receive = vi.fn(), project = 'project') => { const stop = subscribeRealtime(user, project, receive); close.push(stop); return { stop, receive }; };

test('subscribers share a stream, credentials stay in headers, and the last subscriber releases it', async () => {
  const a = subscribe(), b = subscribe(); await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0]).toMatchObject(['/api/realtime?project_id=project&topics=conversations,agents,needs-you,teams', { headers: { authorization: 'Bearer private-token' } }]);
  streams[0].enqueue(encode(['agents'])); await vi.advanceTimersByTimeAsync(0);
  expect(a.receive).toHaveBeenCalledWith(['agents']); expect(b.receive).toHaveBeenCalledWith(['agents']);
  a.stop(); streams[0].enqueue(encode(['conversations'])); await vi.advanceTimersByTimeAsync(5000);
  expect(a.receive).toHaveBeenCalledTimes(1); expect(b.receive).toHaveBeenCalledTimes(2);
  b.stop(); await vi.advanceTimersByTimeAsync(60000); expect(fetch).toHaveBeenCalledTimes(1);
});
test('hidden tabs disconnect; returning opens a fresh stream and catches up', async () => {
  const own = subscribe(); await vi.advanceTimersByTimeAsync(0);
  visibility = 'hidden'; documentEvents.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(30000);
  expect(fetch).toHaveBeenCalledTimes(1);
  visibility = 'visible'; documentEvents.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  streams[1].enqueue(encode(['conversations', 'agents', 'needs-you'])); await vi.advanceTimersByTimeAsync(0);
  expect(own.receive).toHaveBeenCalledWith(['conversations', 'agents', 'needs-you']);
});
test('EOF reconnects, a silent socket times out, and changing accounts fences pending events', async () => {
  const own = subscribe(); await vi.advanceTimersByTimeAsync(0);
  streams[0].close(); await vi.advanceTimersByTimeAsync(1500); expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(33000); expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(3);
  streams.at(-1)!.enqueue(encode(['needs-you'])); account.currentUser = { uid: 'bob' };
  await vi.advanceTimersByTimeAsync(10000); expect(own.receive).not.toHaveBeenCalled();
});

test('rate limiting holds reconnects for Retry-After', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  subscribe(); await vi.advanceTimersByTimeAsync(59000); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); expect(fetch).toHaveBeenCalledTimes(2);
});
