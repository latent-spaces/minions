import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as reservePort } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { disposableTarget } from '../support/disposable-session.mjs';
import { signInBrowser } from '../support/browser-session.js';
import { idTokenFor } from '../../apps/server/test/helpers.js';
import { agents, inProject, profiles } from '../../apps/server/src/firestore.js';
import { seed, TEST_PROJECT, loadAgent, seedCurrentStateReady } from '../../apps/server/test/helpers.js';
import { sendMessageV2 } from '../../apps/server/src/v2/messages.js';

disposableTarget();
const folder = process.argv[2]; if (!folder) throw new Error('Run node tests/manual/agent-removal-app.mjs.');
// This disposable server uses current-state readers, so install the same readiness fixture as the automated tests.
await seedCurrentStateReady();
const root = fileURLToPath(new URL('../../', import.meta.url));
async function port() { const server = reservePort(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value; }
const webPort = await port(), apiPort = await port(), origin = `http://127.0.0.1:${webPort}`;
Object.assign(process.env, { KARMA_LOCAL_API_URL: `http://127.0.0.1:${apiPort}` });
const f = await seed({ profiles: [{ name: 'Operator · synthetic', email: 'remove-owner@example.test' }, { name: 'Peer · synthetic', email: 'remove-peer@example.test' }], agents: [
  { person: 0, name: 'Misconfigured-synthetic' }, { person: 0, name: 'Dead-synthetic' }, { person: 1, name: 'Healthy-synthetic' },
] });
const host = { id: f.personIds[0], email: 'remove-owner@example.test' }, project = { id: TEST_PROJECT };
await profiles.doc(host.id).update({ onboardingCompletedAt: Date.now() });
await inProject(project.id, async () => {
  await sendMessageV2(await loadAgent(f.agents[0].agentId), { to: [f.agents[2].agentId], body: 'Synthetic handoff: preserve this contribution after removal.', clientId: 'history' }, Date.now);
});
let api: ReturnType<typeof spawn> | undefined, web: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [];
async function signIn(page: Page, email: string) {
  await signInBrowser(page, await idTokenFor(email));
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true, animations: 'disabled' });
}
try {
  api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort) } });
  for (let attempt = 0; ; attempt++) {
    if (api.exitCode !== null) throw new Error('Local API exited.');
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/needs-you`)).status === 401) break; } catch {}
    if (attempt > 100) throw new Error('Local API did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  web = await createServer({ root: join(root, 'apps/web'), cacheDir: join(folder, 'vite-cache'), configFile: join(root, 'apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: webPort, strictPort: true, fs: { allow: [root] } } }); await web.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MINIONS_TEST_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  context.setDefaultTimeout(20_000);
  await context.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const owner = await context.newPage(); owner.on('pageerror', error => errors.push(error.message));
  await owner.goto(`${origin}/`); await signIn(owner, host.email);
  const navigate = async (href: string) => owner.evaluate(href => { history.pushState({}, '', href); window.dispatchEvent(new PopStateEvent('popstate')); }, href);
  const url = (section: string, extra = '') => `${origin}/?project=${project.id}&section=${section}${extra}`;
  const retired = f.agents[0].agentId, dead = f.agents[1].agentId, peer = f.agents[2].agentId;
  await navigate(url('agents'));
  const remove = owner.getByRole('button', { name: 'Remove Misconfigured-synthetic', exact: true });
  await remove.waitFor(); await remove.click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Remove agent', exact: true }).waitFor();
  await screenshot(owner, 'remove-desktop-confirmation');
  await owner.keyboard.press('Escape');
  assert.equal((await inProject(project.id, () => agents().doc(retired).get())).data()!.revokedAt, null);
  await remove.click();
  await dialog.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await remove.waitFor({ state: 'detached' });
  assert.equal(await owner.locator('.toast-confetti').count(), 0);
  await navigate(url('agents'));
  await owner.locator('a.k42-directory-card:visible').filter({ hasText: 'Healthy-synthetic' }).waitFor();
  assert.equal(await owner.getByText('Misconfigured-synthetic', { exact: true }).filter({ visible: true }).count(), 0);
  await navigate(url('agents', `&agent=${peer}`));
  await owner.getByRole('heading', { name: 'Healthy-synthetic', exact: true }).waitFor();
  assert.equal(await owner.getByRole('button', { name: /^Remove / }).count(), 0);
  await owner.setViewportSize({ width: 390, height: 844 });
  await navigate(url('agents', `&agent=${dead}`));
  await owner.getByRole('button', { name: 'Remove Dead-synthetic', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove agent', exact: true }).waitFor();
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(owner, 'remove-mobile-confirmation');
  await dialog.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await owner.getByText('You have no agents here yet', { exact: true }).waitFor();
  await screenshot(owner, 'removed-mobile-empty');
  await navigate(url('overview'));
  await owner.locator(`[data-map-id="${peer}"]`).waitFor();
  await owner.locator(`[data-map-id="${retired}"], [data-map-id="${dead}"]`).waitFor({ state: 'detached' });
  await owner.setViewportSize({ width: 1440, height: 1000 });
  await screenshot(owner, 'removed-live-map-desktop');
  await navigate(url('conversations'));
  await owner.getByText('Synthetic handoff: preserve this contribution after removal.', { exact: true }).waitFor();
  assert.ok((await inProject(project.id, () => agents().doc(retired).get())).data()!.revokedAt !== null);
  assert.deepEqual(errors, []);
  console.info(JSON.stringify({ result: 'passed', checks: ['cancel preserves access', 'remove from list', 'remove from mobile detail', 'no peer removal control', 'active directory excludes removed', 'history cannot resurrect map nodes', 'conversation preserved'], screenshots: folder }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { console.error((await page.locator('body').innerText()).slice(-10000)); await screenshot(page, 'failure'); }
  throw error;
} finally {
  await browser?.close(); await web?.close();
  if (api && api.exitCode === null) { api.kill('SIGTERM'); await new Promise<void>(resolve => api!.once('exit', () => resolve())); }
}
