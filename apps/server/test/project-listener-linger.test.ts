// Model-free: a fake subscription stands in for Firestore; no emulator is used. Fake timers drive the linger.
// A listener open is one billed read (the initial snapshot) that SDK operation counts never see.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createSharedWatches, PROJECT_LISTENER_LINGER_MS, PROJECT_LISTENERS_MAX_LINGERING } from '../src/projects/project-control.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function fakeSource(lingerMs: number, maxLingering = Infinity) {
  const live = new Map<string, { next: (value: number | undefined) => void; fail: (error: unknown) => void }>();
  let opened = 0, stopped = 0;
  const watches = createSharedWatches<number>((key, next, fail) => {
    opened++; live.set(key, { next, fail });
    return () => { stopped++; live.delete(key); };
  }, lingerMs, maxLingering);
  return { watches, live, counts: () => ({ opened, stopped, listeners: watches.stats().listeners }) };
}

test('a re-hold within the linger joins the same listener and sees its latest value; it stops after the linger', async () => {
  const source = fakeSource(30_000), seen: (number | undefined)[] = [];
  const leave = source.watches.join('p', value => seen.push(value));
  source.live.get('p')!.next(3);
  leave();
  // No waiter, but the subscription stays open and keeps its value current.
  expect(source.counts()).toEqual({ opened: 1, stopped: 0, listeners: 1 });
  expect(source.watches.stats().heldRequests).toBe(0);
  source.live.get('p')!.next(4);
  vi.advanceTimersByTime(29_000);
  const again = source.watches.join('p', value => seen.push(value));
  await Promise.resolve();
  expect(seen).toEqual([3, 4]);  // the re-hold receives the latest at once, as a fresh listener's first snapshot would
  expect(source.counts()).toEqual({ opened: 1, stopped: 0, listeners: 1 });
  // The earlier linger was cancelled by the join: it does not stop the listener under a live waiter.
  vi.advanceTimersByTime(30_000);
  expect(source.counts()).toEqual({ opened: 1, stopped: 0, listeners: 1 });
  again();
  vi.advanceTimersByTime(29_999);
  expect(source.counts().stopped).toBe(0);
  vi.advanceTimersByTime(1);
  expect(source.counts()).toEqual({ opened: 1, stopped: 1, listeners: 0 });
  source.watches.join('p', () => {})();
  expect(source.counts().opened).toBe(2);
});

test('an error while lingering stops the listener at once; the next waiter opens a new one', () => {
  const source = fakeSource(30_000);
  source.watches.join('p', () => {})();
  source.live.get('p')!.fail(Object.assign(new Error('synthetic'), { code: 'unavailable' }));
  expect(source.counts()).toEqual({ opened: 1, stopped: 1, listeners: 0 });
  expect(source.watches.stats()).toMatchObject({ listenerErrors: 1, lingering: 0 });
  vi.advanceTimersByTime(30_000);
  expect(source.counts().stopped).toBe(1);  // the cleared linger does not stop it twice
  source.watches.join('p', () => {});
  expect(source.counts()).toEqual({ opened: 2, stopped: 1, listeners: 1 });
});

test('at most maxLingering listeners linger; past the cap the last waiter stops it at once', () => {
  const source = fakeSource(30_000, 2);
  for (const key of ['a', 'b', 'c']) source.watches.join(key, () => {})();
  expect(source.counts()).toEqual({ opened: 3, stopped: 1, listeners: 2 });
  expect(source.watches.stats().lingering).toBe(2);
  // A re-hold on a lingering key frees its slot; the next leave may linger again.
  const back = source.watches.join('a', () => {});
  expect(source.watches.stats().lingering).toBe(1);
  source.watches.join('d', () => {})();
  expect(source.watches.stats().lingering).toBe(2);
  back();
  expect(source.counts()).toMatchObject({ stopped: 2 });  // cap reached: 'a' stops at once
  vi.advanceTimersByTime(30_000);
  expect(source.counts()).toEqual({ opened: 4, stopped: 4, listeners: 0 });
  expect(source.watches.stats().lingering).toBe(0);
});

test('the project watch caps lingering listeners at one Firestore client (100 Listen streams)', () => {
  expect(PROJECT_LISTENERS_MAX_LINGERING).toBe(100);
});

test('without a linger the last waiter stops the listener at once, as before', () => {
  const source = fakeSource(0);
  source.watches.join('p', () => {})();
  expect(source.counts()).toEqual({ opened: 1, stopped: 1, listeners: 0 });
});

// Routing study: H holders per project hold for the 25 s timeout, then re-hold 200 ms later on an instance chosen at
// random (today's Cloud Run routing, an assumption) or by project (affinity). Counts listener opens per hold.
function study({ instances, holdersPerProject, lingerMs, affinity }: { instances: number; holdersPerProject: number; lingerMs: number; affinity: boolean }) {
  let seed = 42;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const sources = Array.from({ length: instances }, () => fakeSource(lingerMs));
  const projects = 60, holdMs = 25_000, gapMs = 200, durationMs = 20 * 60_000;
  type Hold = { at: number; project: number; leave?: () => void };
  const events: Hold[] = [];
  for (let project = 0; project < projects; project++) {
    for (let h = 0; h < holdersPerProject; h++) events.push({ at: Math.floor(random() * holdMs), project });
  }
  let now = 0, holds = 0;
  while (events.length) {
    events.sort((a, b) => a.at - b.at);
    const hold = events.shift()!;
    vi.advanceTimersByTime(hold.at - now); now = hold.at;
    if (hold.leave) { hold.leave(); if (now + gapMs < durationMs) events.push({ at: now + gapMs, project: hold.project }); continue; }
    const instance = affinity ? hold.project % instances : Math.floor(random() * instances);
    holds++;
    events.push({ at: now + holdMs, project: hold.project, leave: sources[instance].watches.join(String(hold.project), () => {}) });
  }
  const opened = sources.reduce((sum, source) => sum + source.counts().opened, 0);
  return Math.round(opened / holds * 1000) / 1000;
}

test('listener opens per hold: a linger removes them on one or two instances, and with project affinity', () => {
  const table: Record<string, Record<string, number>> = {};
  for (const instances of [1, 2, 17]) {
    for (const holdersPerProject of [1, 4]) {
      const row = `I=${instances} h=${holdersPerProject}`;
      table[row] = {
        random: study({ instances, holdersPerProject, lingerMs: 0, affinity: false }),
        randomLinger: study({ instances, holdersPerProject, lingerMs: PROJECT_LISTENER_LINGER_MS, affinity: false }),
        affinityLinger: study({ instances, holdersPerProject, lingerMs: PROJECT_LISTENER_LINGER_MS, affinity: true }),
      };
    }
  }
  console.log(JSON.stringify({ listenerOpensPerHold: table }));
  // One holder: every hold opens a listener today, whatever the instance count.
  for (const instances of [1, 2, 17]) expect(table[`I=${instances} h=1`].random).toBe(1);
  // With the linger, a single instance (today's deployment) and affinity open only the first listener per project.
  expect(table['I=1 h=1'].randomLinger).toBeLessThan(0.05);
  expect(table['I=17 h=1'].affinityLinger).toBeLessThan(0.05);
  // Two instances (the control service's planned maximum): most re-holds find a lingering listener.
  expect(table['I=2 h=1'].randomLinger).toBeLessThan(0.35);
  // Random routing over many instances keeps most of the opens: a linger alone does not fix it there.
  expect(table['I=17 h=1'].randomLinger).toBeGreaterThan(0.8);
  // Sharing already helps busy projects on few instances; the linger never adds opens.
  for (const row of Object.values(table)) expect(row.randomLinger).toBeLessThanOrEqual(row.random);
});
