import { expect, test, vi } from 'vitest';
import { boundedRealtimeChecks } from '../src/realtime-checks.js';

test('slow authorization serializes checks and coalesces pending keys', async () => {
  let release!: (visible: boolean) => void;
  const check = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; })).mockResolvedValue(false);
  const notify = vi.fn(), fail = vi.fn(), queue = boundedRealtimeChecks<{ id: string; version: number }>(item => item.id, check, notify, fail);
  queue.add([{ id: 'a', version: 1 }]);
  for (let version = 1; version <= 1000; version++) queue.add([{ id: 'b', version }]);
  expect(check).toHaveBeenCalledTimes(1); release(true);
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  expect(check.mock.calls[1][0]).toEqual([{ id: 'b', version: 1000 }]); expect(notify).toHaveBeenCalledOnce(); expect(fail).not.toHaveBeenCalled(); queue.close();
});
test('overflow closes a bounded queue and suppresses a late in-flight answer', async () => {
  let release!: (visible: boolean) => void;
  const notify = vi.fn(), fail = vi.fn(), check = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
  const queue = boundedRealtimeChecks<string>(item => item, check, notify, fail, 2);
  queue.add(['a']); queue.add(['b', 'c', 'd']); expect(fail).toHaveBeenCalledOnce();
  release(true); await Promise.resolve(); queue.add(['e']);
  expect(check).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
});
test('unsubscribe suppresses late checks and authorization failures end once', async () => {
  let release!: (visible: boolean) => void;
  const notify = vi.fn(), fail = vi.fn(), queue = boundedRealtimeChecks<string>(item => item, () => new Promise<boolean>(resolve => { release = resolve; }), notify, fail);
  queue.add(['a']); queue.close(); release(true); await Promise.resolve(); expect(notify).not.toHaveBeenCalled();
  const broken = boundedRealtimeChecks<string>(item => item, async () => { throw Error('unavailable'); }, notify, fail);
  broken.add(['a']); await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce()); broken.add(['b']); expect(fail).toHaveBeenCalledOnce();
});
