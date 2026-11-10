// Model-free: a fake subscription stands in for Firestore; no emulator is used.
import { expect, test } from 'vitest';
import { inProject } from '../src/firestore.js';
import { createSharedWatches, heldProjectControl, waitForProjectControl } from '../src/projects/project-control.js';
import type { ProjectRecord } from '../src/projects/records.js';

const PROJECT = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const record = (revision: number, paused = false) =>
  ({ revision, execution: { started: true, paused, completedAt: null } }) as unknown as ProjectRecord;
function fakeSource() {
  const live = new Map<string, { next: (value: ProjectRecord | undefined) => void; fail: (error: unknown) => void }>();
  const docs = new Map<string, ProjectRecord | undefined>();
  let opened = 0, stopped = 0;
  const watches = createSharedWatches<ProjectRecord>((key, next, fail) => {
    opened++; live.set(key, { next, fail });
    // Like onSnapshot, a new listener first receives the current document.
    if (docs.has(key)) queueMicrotask(() => { if (live.get(key)?.next === next) next(docs.get(key)); });
    return () => { stopped++; live.delete(key); };
  });
  const set = (key: string, value: ProjectRecord | undefined) => { docs.set(key, value); live.get(key)?.next(value); };
  return { watches, live, set, counts: () => ({ opened, stopped, active: watches.stats().listeners }) };
}
const wait = (source: ReturnType<typeof fakeSource>, project: string, after: number | undefined, signal: AbortSignal, timeoutMs = 1000) =>
  inProject(project, () => waitForProjectControl(after, signal, timeoutMs, source.watches));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('many held waiters on one project share one subscription and all wake on one change', async () => {
  const source = fakeSource(), signal = new AbortController().signal;
  const first = wait(source, PROJECT, undefined, signal);
  source.set(PROJECT, record(4));
  expect(await first).toMatchObject({ revision: 4, paused: false });
  const held = Array.from({ length: 5000 }, () => wait(source, PROJECT, 5, signal));
  // A joiner whose revision differs from the latest answers at once, like a fresh snapshot.
  await expect(Promise.all(held)).resolves.toHaveLength(5000);
  const unchanged = Array.from({ length: 5000 }, () => wait(source, PROJECT, 4, signal));
  await tick();
  expect(source.counts()).toEqual({ opened: 3, stopped: 2, active: 1 }); // one per batch, not per waiter
  // Every held request is visible as load even though it shares one listener.
  expect(source.watches.stats()).toEqual({ heldRequests: 5000, listeners: 1, lingering: 0, listenersOpened: 3, listenerErrors: 0 });
  source.set(PROJECT, record(5, true));
  const woke = await Promise.all(unchanged);
  expect(woke.every(value => value.revision === 5 && value.paused)).toBe(true);
  expect(source.counts()).toEqual({ opened: 3, stopped: 3, active: 0 });
  expect(source.watches.stats()).toMatchObject({ heldRequests: 0, listeners: 0 });
});

test('projects keep separate subscriptions; timeouts and disconnects release the last waiter', async () => {
  const source = fakeSource(), abort = new AbortController();
  const a = wait(source, PROJECT, 1, abort.signal, 20), b = wait(source, OTHER, 1, abort.signal, 1000);
  source.set(PROJECT, record(1)); source.set(OTHER, record(1));
  expect(source.counts().active).toBe(2);
  expect(await a).toMatchObject({ revision: 1 });
  expect(source.counts()).toMatchObject({ active: 1, stopped: 1 });
  abort.abort();
  await expect(b).rejects.toMatchObject({ code: 'bad_input' });
  expect(source.counts()).toEqual({ opened: 2, stopped: 2, active: 0 });
});

test('a subscription error rejects every current waiter and the next waiter reopens', async () => {
  const source = fakeSource(), signal = new AbortController().signal;
  const held = [wait(source, PROJECT, 1, signal), wait(source, PROJECT, 1, signal)];
  source.live.get(PROJECT)!.fail(Object.assign(new Error('synthetic'), { code: 'unavailable' }));
  for (const each of held) await expect(each).rejects.toMatchObject({ code: 'unavailable' });
  expect(source.counts()).toEqual({ opened: 1, stopped: 1, active: 0 });
  expect(source.watches.stats()).toEqual({ heldRequests: 0, listeners: 0, lingering: 0, listenersOpened: 1, listenerErrors: 1 });
  const again = wait(source, PROJECT, undefined, signal);
  source.set(PROJECT, record(2));
  expect(await again).toMatchObject({ revision: 2 });
  expect(source.counts()).toEqual({ opened: 2, stopped: 2, active: 0 });
});

test('a missing project document refuses as before', async () => {
  const source = fakeSource(), signal = new AbortController().signal;
  const held = wait(source, PROJECT, 3, signal);
  source.set(PROJECT, undefined);
  await expect(held).rejects.toMatchObject({ code: 'not_found' });
});

test('a lagging snapshot older than the caller\'s revision keeps holding until a newer one arrives', async () => {
  const source = fakeSource(), signal = new AbortController().signal;
  const first = wait(source, PROJECT, undefined, signal);
  source.set(PROJECT, record(6));
  expect(await first).toMatchObject({ revision: 6 });
  // Another instance already answered 7; this process's listener still holds 6.
  let settled = false;
  const held = wait(source, PROJECT, 7, signal).then(value => { settled = true; return value; });
  await tick();
  expect(settled).toBe(false);
  source.set(PROJECT, record(7));  // catching up to the caller's revision is still no change for it
  await tick();
  expect(settled).toBe(false);
  source.set(PROJECT, record(8, true));
  expect(await held).toMatchObject({ revision: 8, paused: true });
  // Unchanged until the timeout: the latest snapshot is returned as before.
  await expect(wait(source, PROJECT, 9, signal, 20)).resolves.toMatchObject({ revision: 8 });
});

test('a held request checks the run again only when it delivers a different revision', async () => {
  const source = fakeSource(), signal = new AbortController().signal;
  let checks = 0, revoked = false;
  const checkRun = async () => { checks++; if (revoked) throw Object.assign(new Error('superseded'), { code: 'run_superseded' }); };
  const held = (after: number | undefined, timeoutMs = 1000) =>
    inProject(PROJECT, () => heldProjectControl(after, signal, checkRun, timeoutMs, source.watches));
  const first = held(undefined);
  source.set(PROJECT, record(3));
  expect(await first).toMatchObject({ revision: 3 });
  expect(checks).toBe(2);  // a first answer delivers state: checked before and after
  checks = 0;
  // Revoked during a quiet hold: the unchanged timeout tells it nothing new and skips the second check.
  const quiet = held(3, 20);
  await tick(); revoked = true;
  expect(await quiet).toMatchObject({ revision: 3 });
  expect(checks).toBe(1);
  // New state is never delivered to a revoked run.
  revoked = false; checks = 0;
  const changed = held(3);
  await tick(); revoked = true;
  source.set(PROJECT, record(4, true));
  await expect(changed).rejects.toMatchObject({ code: 'run_superseded' });
  expect(checks).toBe(2);
  // The next open refuses at once.
  await expect(held(4)).rejects.toMatchObject({ code: 'run_superseded' });
  // A lower revision than the caller's (a lagging listener at the timeout) is new state too: checked again.
  revoked = false; checks = 0;
  expect(await held(9, 20)).toMatchObject({ revision: 4 });
  expect(checks).toBe(2);
});

test('shutdown answers every held request with its current state; later holds are brief', async () => {
  // Run last in this file: draining is process-wide, as it is for a server that received SIGTERM.
  const { drainProjectControl } = await import('../src/projects/project-control.js');
  const source = fakeSource(), signal = new AbortController().signal;
  source.set(PROJECT, record(7)); source.set(OTHER, record(3, true));
  const held = [...Array.from({ length: 50 }, () => wait(source, PROJECT, 7, signal, 60_000)), wait(source, OTHER, 3, signal, 60_000)];
  await tick();
  expect(source.watches.stats().heldRequests).toBe(51);
  const began = Date.now(), at: number[] = [];
  drainProjectControl(300);
  // Unchanged answers, not refusals: the connector re-holds them without its failure back-off. They arrive spread
  // over the window rather than all at once.
  const answers = await Promise.all(held.map(answer => answer.then(value => { at.push(Date.now()); return value; })));
  expect(Date.now() - began).toBeLessThan(800);
  expect(Math.max(...at) - Math.min(...at)).toBeGreaterThan(50);
  expect(answers.slice(0, 50).every(answer => answer.revision === 7 && !answer.paused)).toBe(true);
  expect(answers[50]).toMatchObject({ revision: 3, paused: true });
  expect(source.counts()).toMatchObject({ active: 0 });
  // A hold that opens while draining still wakes on a change, but otherwise answers within about a second.
  const late = wait(source, PROJECT, 7, signal, 60_000);
  await expect(late).resolves.toMatchObject({ revision: 7 });
  expect(Date.now() - began).toBeLessThan(1_500);
});
