import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bellBadge, bellLabel, defaultBellTab, shortAge } from '../src/ui/notifications-bell';

test('the bell opens on Needs you only while something waits for an answer', () => {
  assert.equal(defaultBellTab(2), 'needs-you');
  assert.equal(defaultBellTab(0), 'updates');
});

test('the badge drops to nothing once everything is read and nothing needs you', () => {
  assert.equal(bellBadge(0, false), null);
  assert.equal(bellLabel(0, false), 'Notifications, nothing new');
  assert.equal(bellBadge(3, false), '3');
});


test('an empty filtered page with a continuation does not claim the inbox is empty', () => {
  assert.equal(bellBadge(0, true), null);
  assert.equal(bellLabel(0, true), 'Notifications, more updates available');
});

test('row ages are compact and a clock running behind reads as now', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  assert.equal(shortAge(now + 5_000, now), 'now');
  assert.equal(shortAge(now - 5 * 60_000, now), '5m');
  assert.equal(shortAge(now - 3 * 3_600_000, now), '3h');
  assert.equal(shortAge(now - 2 * 86_400_000, now), '2d');
  assert.match(shortAge(now - 10 * 86_400_000, now), /22/);
});
