import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshOnReturn } from '../src/refresh-on-return';

function surfaces() {
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const browser = new EventTarget();
  return { page, browser, watch: (refresh: () => void) => refreshOnReturn(refresh, page as unknown as Document, browser) };
}

test('returning from GitHub to a still-visible window revalidates without a visibility change', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { browser, watch } = surfaces();
  let reads = 0;
  const stop = watch(() => reads++);
  assert.equal(reads, 0);
  browser.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(1);
  assert.equal(reads, 1);
  stop();
});

test('visibility, focus, reconnect and restored-page events coalesce, and later returns still refresh', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { page, browser, watch } = surfaces();
  let reads = 0;
  const stop = watch(() => reads++);
  page.dispatchEvent(new Event('visibilitychange'));
  for (const name of ['focus', 'online', 'pageshow']) browser.dispatchEvent(new Event(name));
  t.mock.timers.tick(1);
  assert.equal(reads, 1);
  for (const name of ['focus', 'online', 'pageshow']) {
    browser.dispatchEvent(new Event(name));
    t.mock.timers.tick(1);
  }
  assert.equal(reads, 4);
  stop();
});

test('hidden pages do not refresh, including when hidden after an event was queued', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { page, browser, watch } = surfaces();
  let reads = 0;
  const stop = watch(() => reads++);
  browser.dispatchEvent(new Event('focus'));
  page.visibilityState = 'hidden';
  t.mock.timers.tick(1);
  browser.dispatchEvent(new Event('online'));
  page.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(1);
  assert.equal(reads, 0);
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(1);
  assert.equal(reads, 1);
  stop();
});

test('cleanup cancels queued work and removes all listeners before another account or project mounts', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { page, browser, watch } = surfaces();
  let oldReads = 0, currentReads = 0;
  const stop = watch(() => oldReads++);
  browser.dispatchEvent(new Event('focus'));
  stop();
  const stopCurrent = watch(() => currentReads++);
  page.dispatchEvent(new Event('visibilitychange'));
  for (const name of ['focus', 'online', 'pageshow']) browser.dispatchEvent(new Event(name));
  t.mock.timers.tick(1);
  assert.equal(oldReads, 0);
  assert.equal(currentReads, 1);
  stopCurrent();
});
