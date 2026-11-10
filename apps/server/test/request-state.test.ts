import { expect, test } from 'vitest';
import { RecentlyUsed, sharedRead, WindowLimitStore } from '../src/request-state.js';

test('a window admits max calls, then reports the wait until the oldest expires', () => {
  const limit = new WindowLimitStore(10).limiter(() => 'route', 2, 1000);
  expect(limit('a', 0)).toBe(0);
  expect(limit('a', 100)).toBe(0);
  expect(limit('a', 200)).toBe(800);
  expect(limit('a', 1000)).toBe(0);
  expect(limit('b', 200)).toBe(0);
});

test('one namespace flooded with new keys cannot lock out new identities elsewhere', () => {
  const store = new WindowLimitStore(100);
  const signedOut = store.limiter(() => 'by-address', 60, 60_000), people = store.limiter(() => 'by-person', 60, 60_000);
  for (let i = 0; i < 1000; i++) signedOut(`address-${i}`, i);
  expect(store.size).toBe(25);
  // The flooded namespace refuses only its own new keys; keys it already holds keep their quota.
  expect(signedOut('address-new', 1000)).toBe(60_000);
  expect(signedOut('address-0', 1000)).toBe(0);
  expect(people('person-1', 1000)).toBe(0);
});

test('expired keys free their namespace allowance', () => {
  const store = new WindowLimitStore(8);
  const limit = store.limiter(() => 'route', 1, 1000);
  expect(limit('a', 0)).toBe(0);
  expect(limit('b', 0)).toBe(0);
  expect(limit('c', 0)).toBe(60_000);
  expect(limit('c', 60_000)).toBe(0);
  expect(store.size).toBe(1);
});

test('the overall bound still holds across namespaces', () => {
  const store = new WindowLimitStore(4, 1);
  for (const name of ['a', 'b', 'c', 'd']) store.limiter(() => name, 1, 1000)('key', 0);
  expect(store.limiter(() => 'e', 1, 1000)('key', 0)).toBe(60_000);
  expect(() => new WindowLimitStore(4, 0)).toThrow();
});

test('stats count new identities refused by a full bound without changing admission', () => {
  const store = new WindowLimitStore(8);
  const limit = store.limiter(() => 'route', 1, 1000);
  limit('a', 0); limit('b', 0);
  expect(limit('c', 0)).toBe(60_000);
  expect(limit('a', 0)).toBe(1000);
  expect(store.stats()).toEqual({ keys: 2, maxKeys: 8, namespaces: 1, largestNamespaceKeys: 2, maxNamespaceKeys: 2, refusedNewKeys: 1 });
});

test('default per-process bounds: one 5,000-agent project fills its control namespace exactly', () => {
  // Mirrors v2-control:<project> and v2-wait:<project>: every connected worker holds one key in each.
  const store = new WindowLimitStore();
  const control = store.limiter(() => 'v2-control:big', 60, 60_000), waits = store.limiter(() => 'v2-wait:big', 1, 10_000);
  for (let i = 0; i < 5000; i++) { expect(control(`agent-${i}`, 0)).toBe(0); expect(waits(`agent-${i}`, 0)).toBe(0); }
  expect(store.stats()).toMatchObject({ keys: 10_000, largestNamespaceKeys: 5000, maxNamespaceKeys: 5000, refusedNewKeys: 0 });
  // A replacement or additional worker in the same minute is refused for the full window.
  expect(control('agent-5000', 1)).toBe(60_000);
  expect(store.stats().refusedNewKeys).toBe(1);
  // Equal 5,000 sessions as 1,000 projects of 5 never meet a namespace bound, only the global one.
  const spread = new WindowLimitStore();
  for (let p = 0; p < 1000; p++) for (let a = 0; a < 5; a++) {
    spread.limiter(() => `v2-control:p${p}`, 60, 60_000)(`agent-${a}`, 0);
    spread.limiter(() => `v2-wait:p${p}`, 1, 10_000)(`agent-${a}`, 0);
  }
  expect(spread.stats()).toMatchObject({ keys: 10_000, largestNamespaceKeys: 5, refusedNewKeys: 0 });
});

test('recently used values survive many newer entries; the least recently used is evicted', () => {
  const cache = new RecentlyUsed<string>(3);
  let built = 0;
  const get = (key: string) => cache.get(key, () => { built++; return key; });
  get('hot'); get('b'); get('c');
  get('hot'); get('d');
  expect(built).toBe(4);
  get('hot');
  expect(built).toBe(4);
  get('b');
  expect(built).toBe(5);
  expect(cache.size).toBe(3);
  expect(() => new RecentlyUsed(0)).toThrow();
});

test('a busy project keeps its router while 100+ other projects churn through', () => {
  const cache = new RecentlyUsed<number>(100);
  let rebuilds = 0;
  for (let i = 0; i < 1000; i++) {
    cache.get('busy', () => ++rebuilds);
    cache.get(`cold-${i}`, () => 0);
  }
  expect(rebuilds).toBe(1);
});

test('a shared read coalesces concurrent viewers, expires on time and retries failures', async () => {
  let at = 0, scans = 0, fail = false;
  const read = sharedRead(async () => { scans++; if (fail) throw new Error('down'); return scans; }, () => at, 10_000);
  expect(await Promise.all([read(), read(), read()])).toEqual([1, 1, 1]);
  at = 9_999; expect(await read()).toBe(1);
  at = 10_000; fail = true;
  await expect(read()).rejects.toThrow('down');
  fail = false; expect(await read()).toBe(3);
  expect(scans).toBe(3);
});

// Production sizing (20,000 keys, 25% per namespace) at the boundaries TEAM-PLAN gate 2 names. A connected session
// holds one key in each of v2-wait, v2-control and v2-tools for its project (steady-state-unit-work counts this).
test('one project at 4,999 / 5,000 / 5,001 agents: the 5,001st new identity is refused for 60 s', () => {
  const store = new WindowLimitStore();
  const control = store.limiter(() => 'v2-control:flagship', 60, 60_000);
  for (let i = 0; i < 4_999; i++) expect(control(`agent-${i}`, 0)).toBe(0);
  expect(store.stats().largestNamespaceKeys).toBe(4_999);
  expect(control('agent-4999', 0)).toBe(0);
  expect(store.stats().largestNamespaceKeys).toBe(5_000);
  // Agent 5,001 (or a replacement identity) waits a full window; agents already admitted keep working.
  expect(control('agent-5000', 1)).toBe(60_000);
  expect(control('agent-0', 1)).toBe(0);
  expect(store.stats().refusedNewKeys).toBe(1);
});

test('the whole store at three keys per session admits 6,666 sessions across projects, not 8,700', () => {
  const store = new WindowLimitStore();
  // 1,000 small projects, each its own three namespaces, as 1,000×n shapes.
  const limiters = new Map<string, ReturnType<WindowLimitStore['limiter']>>();
  const key = (route: string, project: number) => {
    const name = `${route}:${project}`;
    if (!limiters.has(name)) limiters.set(name, store.limiter(() => name, 60, 60_000));
    return limiters.get(name)!;
  };
  const connect = (session: number) => ['v2-wait', 'v2-control', 'v2-tools'].map(route => key(route, session % 1000)(`agent-${session}`, 0));
  for (let s = 0; s < 6_666; s++) expect(connect(s)).toEqual([0, 0, 0]);
  expect(store.stats().keys).toBe(19_998);
  // Session 6,667 gets its first two keys, then the store is full: its third request is refused.
  expect(connect(6_666)).toEqual([0, 0, 60_000]);
  expect(connect(6_667)).toEqual([60_000, 60_000, 60_000]);
  expect(store.stats().keys).toBe(20_000);
});
