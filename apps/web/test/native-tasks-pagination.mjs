// Component regression, synthetic transport only. Pass a local Vite native-tasks.html URL.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const url = new URL(process.argv[2]);
url.searchParams.set('pagination', '1');
const browser = await chromium.launch({ args: ['--single-process'] });
try {
  const page = await browser.newPage();
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await page.waitForFunction(() => window.taskPagination.pending().length === 1);
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('done');
  await page.getByRole('button', { name: 'Agree the task completion policy', exact: true }).waitFor();
  // The new filter's first page is ready while the old filter's page is still held.
  const more = page.getByRole('button', { name: 'Show more', exact: true });
  await more.waitFor({ timeout: 3000 });
  assert.equal(await more.isEnabled(), true, 'a stale pending page must not disable the new filter');
  await more.click();
  await page.waitForFunction(() => window.taskPagination.pending().length === 2);
  assert.deepEqual(await page.evaluate(() => window.taskPagination.pending()), ['all', 'done']);
  await page.evaluate(() => window.taskPagination.finish(0));
  // Let the old promise's then/finally and React update settle before checking the newer request.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const loading = page.getByRole('button', { name: 'Loading…', exact: true });
  assert.equal(await loading.isDisabled(), true, 'stale completion must not release the new request');
  assert.equal(await page.getByRole('button', { name: 'Delayed all page', exact: true }).count(), 0);
  await page.evaluate(() => window.taskPagination.finish(1));
  await page.getByRole('button', { name: 'Delayed done page', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Loading…', exact: true }).count(), 0);
  console.log('PASS: filter change releases stale loading state; stale completion preserves the newer request.');
} finally { await browser.close(); }
