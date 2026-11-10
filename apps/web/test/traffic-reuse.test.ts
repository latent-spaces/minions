import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reuseTraffic, TRAFFIC_REUSE_MS, type TrafficRead } from '../src/ui/communication-map/read-traffic';

const row = (id: string, createdAt: number) => ({ id, agentId: 'a', to: ['b'], audience: 'direct', createdAt });
const at = 10_000_000;
const last: TrafficRead = { at, mark: `${at - 1_000}:m3`, rows: [row('m3', at - 1_000), row('m2', at - 200_000), row('m1', at - 299_000)] };

test('a newer frame with the same newest shared message keeps the rows still inside its five-minute window', () => {
  assert.deepEqual(reuseTraffic(last, at + 5_000, last.mark)?.map(r => r.id), ['m3', 'm2']);
  assert.deepEqual(reuseTraffic(last, at, last.mark)?.map(r => r.id), ['m3', 'm2', 'm1']);
});

test('a new message, a frame without a mark, an older frame or a stale read asks for a fresh read', () => {
  assert.equal(reuseTraffic(last, at + 5_000, `${at + 4_000}:m4`), null);
  assert.equal(reuseTraffic(last, at + 5_000, undefined), null);
  assert.equal(reuseTraffic(last, at - 5_000, last.mark), null);
  assert.equal(reuseTraffic(last, at + TRAFFIC_REUSE_MS, last.mark), null);
  assert.equal(reuseTraffic(null, at, null), null);
});

test('an empty window stays empty without reading while nothing is sent', () => {
  assert.deepEqual(reuseTraffic({ at, mark: null, rows: [] }, at + 5_000, null), []);
});
