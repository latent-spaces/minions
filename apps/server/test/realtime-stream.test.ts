import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, expect, test, vi } from 'vitest';
import { openRealtimeStream, type RealtimeTopic, type RealtimeWatch } from '../src/realtime-stream.js';

afterEach(() => vi.useRealTimers());
function fixture(authorize = async () => {}) {
  vi.useFakeTimers();
  const response = Object.assign(new EventEmitter(), { set: vi.fn(), flushHeaders: vi.fn(), write: vi.fn((_value: string) => true), end: vi.fn() });
  const callbacks = new Map<RealtimeTopic, { next: () => void; fail: () => void }>(), stops: ReturnType<typeof vi.fn>[] = [];
  const watch: RealtimeWatch = (topic, next, fail) => { callbacks.set(topic, { next, fail }); const stop = vi.fn(); stops.push(stop); return stop; };
  const close = openRealtimeStream(response as unknown as Response, ['conversations', 'agents'], authorize, watch,
    { batchMs: 100, heartbeatMs: 1000, lifetimeMs: 4000 });
  return { response, callbacks, stops, close };
}
test('initial/reconnect invalidation and bursts coalesce into one permission-checked frame', async () => {
  const authorize = vi.fn(async () => {}), f = fixture(authorize);
  f.callbacks.get('agents')!.next(); f.callbacks.get('agents')!.next();
  await vi.advanceTimersByTimeAsync(100);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(f.response.write.mock.calls[0][0]).toBe('data: {"topics":["conversations","agents"]}\n\n');
  f.callbacks.get('agents')!.next(); await vi.advanceTimersByTimeAsync(100);
  expect(f.response.write.mock.calls[1][0]).toBe('data: {"topics":["agents"]}\n\n'); f.close();
});
test('a change during authorization is retained for the next batch', async () => {
  let release!: () => void;
  const authorize = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
  const f = fixture(authorize); await vi.advanceTimersByTimeAsync(100);
  f.callbacks.get('agents')!.next(); await vi.advanceTimersByTimeAsync(100);
  release(); await vi.advanceTimersByTimeAsync(100);
  expect(f.response.write).toHaveBeenCalledTimes(2); f.close();
});
test('revocation or listener failure closes without sending private invalidations', async () => {
  const denied = fixture(async () => { throw Error('removed'); });
  await vi.advanceTimersByTimeAsync(100);
  expect(denied.response.write).not.toHaveBeenCalled(); expect(denied.response.end).toHaveBeenCalledOnce();
  expect(denied.stops.every(stop => stop.mock.calls.length === 1)).toBe(true);
  const failed = fixture(); failed.callbacks.get('agents')!.fail(); await vi.advanceTimersByTimeAsync(200);
  expect(failed.response.write).not.toHaveBeenCalled(); expect(failed.response.end).toHaveBeenCalledOnce();
});
test('disconnect, backpressure and lifetime release all subscriptions exactly once', async () => {
  for (const cause of ['disconnect', 'backpressure', 'lifetime']) {
    const f = fixture();
    if (cause === 'disconnect') f.response.emit('close');
    if (cause === 'backpressure') f.response.write.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(4100); f.close();
    expect(f.response.end).toHaveBeenCalledOnce(); expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true);
  }
});
