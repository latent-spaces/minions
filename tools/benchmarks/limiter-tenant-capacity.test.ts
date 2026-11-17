import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowLimitStore } from '../../apps/server/src/request-state.js';
import { START, admitGroup, mixedTenants, sessions, touchSession } from './limiter-tenant-capacity.js';

test('hot-first and small-first arrival give different tenants the same bounded shared capacity', () => {
  const hot = mixedTenants('flagship-first'), small = mixedTenants('small-first');
  assert.equal(hot.stats.keys, 20_000); assert.equal(small.stats.keys, 20_000);
  assert.deepEqual(hot.flagship, { keys: 15_000, completeSessions: 5000, partialSessions: 0, refusedKeys: 0 });
  assert.deepEqual(hot.small, { keys: 5000, completeSessions: 1666, partialSessions: 1, refusedKeys: 10_000 });
  assert.deepEqual(small.small, hot.flagship); assert.deepEqual(small.flagship, hot.small);
  assert.equal(hot.stats.largestNamespaceKeys, 5000);
  assert.equal(hot.stats.refusedNewKeys, 10_000);
});

test('four namespaces may fill the store; the quarter ceiling does not reserve room for a fifth route', () => {
  const store = new WindowLimitStore();
  for (const name of ['v2-wait:flagship', 'v2-tools:flagship', 'v2-control:flagship', 'viewer:flagship']) {
    const take = store.limiter(() => name, 60, 60_000);
    for (let a = 0; a < 5000; a++) assert.equal(take(`identity${a}`, START), 0);
  }
  assert.equal(store.stats().largestNamespaceKeys, 5000);
  assert.equal(store.stats().keys, 20_000);
  assert.equal(store.limiter(() => 'owner-person', 60, 60_000)('new-owner', START), 60_000);
});

test('active existing keys retain the full store across retries; idle expiry eventually admits a new tenant', () => {
  const store = new WindowLimitStore(), hot = sessions(1, 5000, 'hot'), small = sessions(1000, 5, 'small');
  admitGroup(store, hot); admitGroup(store, small);
  // These are precisely the sessions whose complete or partial keys fitted at time START.
  const admittedSmall = small.slice(0, 1667);
  const newcomer = store.limiter(() => 'viewer:new-tenant', 60, 60_000);
  for (let tick = 1; tick <= 6; tick++) {
    const at = START + tick * 20_000;
    for (const session of [...hot, ...admittedSmall]) touchSession(store, session, at);
    assert.equal(newcomer('viewer', at), 60_000);
    assert.equal(store.size, 20_000);
  }
  assert.equal(newcomer('viewer', START + 180_000), 0); // All old keys idle for exactly60s.
  assert.ok(store.size < 20_000); // Bounded incremental cleanup, not an eager full sweep.
});

test('even identity-rate refusals refresh touchedAt and can keep capacity occupied', () => {
  const store = new WindowLimitStore(4, 1), take = store.limiter(() => 'hot', 1, 60_000);
  for (const key of ['a', 'b', 'c', 'd']) assert.equal(take(key, START), 0);
  for (let tick = 1; tick <= 11; tick++) {
    const at = START + tick * 5000;
    for (const key of ['a', 'b', 'c', 'd']) {
      assert.equal(take(key, at), 60_000 - tick * 5000);
    }
    assert.equal(store.limiter(() => 'other', 1, 60_000)('new', at), 60_000);
  }
  assert.equal(store.size, 4);
  // No accepted hot request occurred after START; rate-refused attempts still pinned their keys.
  const other = store.limiter(() => 'other', 1, 60_000);
  assert.equal(other('new', START + 60_000), 60_000);
  assert.equal(other('new', START + 115_000), 0);
});

test('terminal capacity is isolated from ordinary traffic but remains first-arrival across projects', () => {
  const ordinary = new WindowLimitStore(), terminal = new WindowLimitStore(5000, 1);
  admitGroup(ordinary, sessions(1, 5000, 'hot')); admitGroup(ordinary, sessions(1000, 5, 'small'));
  const stop = terminal.limiter(() => 'v2-stop:flagship', 6, 60_000);
  for (let a = 0; a < 5000; a++) assert.equal(stop(`agent${a}`, START), 0);
  assert.equal(ordinary.size, 20_000); assert.equal(terminal.size, 5000);
  assert.equal(terminal.limiter(() => 'v2-stop:other-project', 6, 60_000)('new-agent', START), 60_000);
  assert.equal(stop('agent0', START + 1000), 0); // Existing identity still has its own remaining budget.
});
