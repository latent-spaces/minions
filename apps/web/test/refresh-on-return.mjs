// Actual app + local Auth/API; synthetic observations are intercepted in this browser only.
// Usage: node apps/web/test/refresh-on-return.mjs 'http://127.0.0.1:5197/viewer/?project=<local-project-id>'
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const url = new URL(process.argv[2]);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.protocol, 'http:');
assert.match(url.searchParams.get('project') ?? '', /^[a-f0-9]{64}$/);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  let revision = 0;
  const reads = { overview: 0, workers: 0, current: 0 };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/view/overview', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const data = await response.json();
    reads.overview++;
    await route.fulfill({ response, json: { ...data, repositorySummary: {
      status: 'observed', repository: data.project.repoUrl, open: 7 + revision, merged: revision,
      lastSyncAt: Date.now(), syncFailed: false,
    } } });
  });
  await page.route('**/my-workers', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const data = await response.json(), now = Date.now();
    reads.workers++;
    await route.fulfill({ response, json: { ...data, queued: [], agents: [{
      agentId: 'synthetic-refresh-agent', agentName: 'Synthetic refresh agent',
      settings: { involvement: 'on_own' }, lastRun: null,
      worker: { available: true, agentId: 'synthetic-refresh-agent', serverTime: now, session: {
        missionId: 'synthetic-mission', runId: 'synthetic-run', generation: 1,
        startedAt: now, deadlineAt: now + 3600000, lastContactAt: now, remainingSlots: 1,
        phase: revision % 2 ? 'waiting' : 'working',
      } },
    }] } });
  });
  // The persistent viewer API may predate /current; exercise the current web consumer
  // with explicit synthetic answers without restarting or changing that service.
  await page.route('**/communication/agents/current**', async route => {
    reads.current++;
    await route.fulfill({ json: { rows: [], cursor: `synthetic-${reads.current}`, more: false,
      notReady: false, complete: true, needsYou: [], needsYouComplete: true,
      serverTime: Date.now(), pause: null } });
  });
  await page.goto(url.href);
  await page.getByRole('button', { name: 'Local Co-founder', exact: true }).click();
  await page.getByRole('link', { name: /7 open pull requests/ }).waitFor();
  await page.waitForFunction(() => document.body.innerText.includes('Synthetic refresh agent') && document.querySelector('[data-status-rounds]'));
  const agentLink = page.getByRole('link').filter({ hasText: 'Synthetic refresh agent' }).first();
  await agentLink.filter({ hasText: 'Working' }).waitFor();
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  for (const event of ['focus', 'online', 'pageshow']) {
    const before = { ...reads };
    revision++;
    await page.evaluate(name => window.dispatchEvent(new Event(name)), event);
    await page.getByRole('link', { name: new RegExp(`${7 + revision} open pull requests`) }).waitFor({ timeout: 5000 });
    await agentLink.filter({ hasText: revision % 2 ? 'Idle' : 'Working' }).waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('[data-status-rounds]')?.getAttribute('data-status-rounds')?.includes('current:'));
    // Allow the map's independent async request to finish before inspecting all counters.
    await page.waitForTimeout(100);
    for (const key of Object.keys(reads)) assert.ok(reads[key] > before[key], `${event} revalidates ${key}`);
    console.log(`${event}: PR count and agent status updated; map revalidated`);
  }
  assert.equal(navigations, 0, 'updates must not reload or navigate the page');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
