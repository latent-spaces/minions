import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PAGES_LIMIT, WALK_PAGE_SPACING_MS, readAllPages, walkDue } from '../src/all-pages';

// 47 rows served 20 per page, like the server's /agents and /members.
const rows = Array.from({ length: 47 }, (_, i) => ({ id: `a${i}` }));
function server() {
  const calls: (string | null)[] = [];
  const readPage = async (cursor: string | null) => {
    calls.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    return { items: rows.slice(start, start + 20), next: start + 20 < rows.length ? String(start + 20) : null };
  };
  return { calls, readPage };
}

test('walks every page beyond the first 20 rows', async () => {
  const { calls, readPage } = server();
  const walk = await readAllPages(readPage, () => false, ALL_PAGES_LIMIT, () => 7);
  assert.deepEqual(walk, { items: rows, complete: true, pages: 3, startedAt: 7 });
  assert.deepEqual(calls, [null, '20', '40']);
});

test('stops reading as soon as it is cancelled', async () => {
  const { calls, readPage } = server();
  let stopped = false;
  const walk = readAllPages(async cursor => { const page = await readPage(cursor); stopped = true; return page; }, () => stopped);
  assert.equal(await walk, null);
  assert.equal(calls.length, 1);
});

test('failures reach the caller, and the walk is bounded', async () => {
  await assert.rejects(readAllPages(async () => { throw new Error('403'); }, () => false), /403/);
  let calls = 0;
  const endless = async () => { calls++; return { items: [{ id: `x${calls}` }], next: 'more' }; };
  const walk = await readAllPages(endless, () => false);
  assert.equal(calls, ALL_PAGES_LIMIT);
  // The bound keeps every row read instead of reverting to the first page.
  assert.equal(walk?.complete, false);
  assert.equal(walk?.items.length, ALL_PAGES_LIMIT);
});


test('an empty final page is a complete empty list, including at the page bound', async () => {
  assert.deepEqual((await readAllPages(async () => ({ items: [], next: null }), () => false))?.items, []);
  assert.deepEqual(await readAllPages(async () => ({ items: ['last'], next: null }), () => false, 1, () => 0), { items: ['last'], complete: true, pages: 1, startedAt: 0 });
  assert.deepEqual(await readAllPages(async () => ({ items: ['partial'], next: 'more' }), () => false, 1, () => 0), { items: ['partial'], complete: false, pages: 1, startedAt: 0 });
});

test('walks that fit one refresh keep the cadence; long walks are paced by pages read', () => {
  const refreshMs = 30_000;
  assert.equal(walkDue(null, 0, refreshMs), true);
  // Up to five pages (100 rows) every tick may walk again, exactly as before.
  assert.equal(walkDue({ pages: 5, startedAt: 0 }, 1, refreshMs), true);
  // 50 pages (agents + members at the bound) would be 100 requests a minute at the 30s tick.
  assert.equal(walkDue({ pages: 25, startedAt: 0 }, refreshMs, refreshMs), false);
  assert.equal(walkDue({ pages: 25, startedAt: 0 }, 25 * WALK_PAGE_SPACING_MS, refreshMs), true);
});

test('a paced walk averages at most ten requests a minute at every directory size', () => {
  const refreshMs = 30_000, horizon = 60 * 60_000;
  for (const rows of [20, 100, 101, 500, 5_000]) {
    const pages = Math.min(Math.ceil(rows / 20), ALL_PAGES_LIMIT);
    let last: { pages: number; startedAt: number } | null = null, requests = 0;
    for (let now = 0; now < horizon; now += refreshMs) if (walkDue(last, now, refreshMs)) { last = { pages, startedAt: now }; requests += pages; }
    const perMinute = requests / 60;
    if (pages * WALK_PAGE_SPACING_MS <= refreshMs) assert.equal(perMinute, pages * 2, `${rows} rows keep the 30s cadence`);
    else assert.ok(perMinute <= 10, `${rows} rows: ${perMinute}/min`);
  }
});
