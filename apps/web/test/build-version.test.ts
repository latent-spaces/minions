import { test } from 'node:test';
import assert from 'node:assert/strict';
(globalThis as { __MINIONS_BUILD__?: string }).__MINIONS_BUILD__ = 'b1';
const { newerBuildServed } = await import('../src/build-version');

const served = (body: unknown, ok = true) => async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 });

test('an open tab learns a newer build is served', async () => {
  assert.equal(await newerBuildServed('b1', served({ build: 'b2' })), true);
  assert.equal(await newerBuildServed('b1', served({ build: 'b1' })), false);
});

test('a missing or unreadable version file says nothing', async () => {
  assert.equal(await newerBuildServed('b1', served({ build: 'b2' }, false)), false);
  assert.equal(await newerBuildServed('b1', served({})), false);
  assert.equal(await newerBuildServed('b1', async () => { throw new Error('offline'); }), false);
});
