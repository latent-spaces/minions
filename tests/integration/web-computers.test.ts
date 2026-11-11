import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, profiles, inProject } from '../../apps/server/src/firestore.js';
import { hashToken, newToken } from '../../apps/server/src/auth.js';
import { connectOwnAgent } from '../../apps/server/src/owner/agents.js';
import { computerConnections } from '../../apps/server/src/owner/computer-access.js';
import { agentByToken } from '../../apps/server/src/store/profiles.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor, testSubject } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() {
  const server = portServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}

test('actual My computers page is linked from the menu, confirms revocation and handles mobile, errors and empty connections', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-computers-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({ profiles: [{ name: 'Computer owner', email: 'computer-owner@example.test' }] });
  const profileId = fixture.personIds[0];
  await profiles.doc(profileId).update({ onboardingCompletedAt: 100 });
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff', at = Date.now(), token = newToken();
  await computerConnections.doc(id).set({ requestId: id, profileId, firebaseUid: testSubject('computer-owner@example.test'), authenticatedAt: at,
    pollingSecretHash: hashToken(newToken()), candidateTokenHash: hashToken(newToken()), clientName: 'Synthetic work laptop',
    createdAt: at, expiresAt: at + 600_000, approvedAt: at, revokedAt: null, connectionExpiresAt: at + 86400_000 });
  // Expired approvals fill the first server page; the live connection must remain reachable.
  const history = db.batch(), approvedComputer = (await computerConnections.doc(id).get()).data()!;
  for (let n = 0; n < 51; n++) {
    const olderId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    history.set(computerConnections.doc(olderId), { ...approvedComputer, requestId: olderId, connectionExpiresAt: at - 1 });
  }
  await history.commit();
  const agent = await inProject(TEST_PROJECT, () => connectOwnAgent(profileId, { name: 'synthetic-worker', candidateTokenHash: hashToken(token), clientName: 'Synthetic', folder: 'C:\\Synthetic folder' }, Date.now, id));
  const api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), ADMIN_EMAILS: 'admin@example.test' } });
  let output = ''; api.stdout?.on('data', value => { output += String(value); }); api.stderr?.on('data', value => { output += String(value); });
  const { createServer } = require('vite'), { chromium } = require('playwright');
  const web = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: Object.fromEntries(['/api', '/community', '/p'].map(path => [path, `http://127.0.0.1:${apiPort}`])) } });
  let browser: any, page: any;
  try {
    for (let n = 0; ; n++) {
      if (api.exitCode !== null) throw new Error(output);
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/feedback/admin`)).status === 401) break; } catch {}
      if (n > 100) throw new Error(output || 'API did not start'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    await web.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route: any) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    page = await context.newPage(); const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${webPort}/viewer/?view=computers`);
    await signInBrowser(page, await idTokenFor('computer-owner@example.test'));
    await page.getByRole('heading', { name: 'My computers', exact: true }).waitFor();
    await page.getByText('Synthetic work laptop', { exact: true }).waitFor();
    // There is no top bar or account menu (owner, 11 November 2026): My computers is linked at the foot of the menu,
    // and the connector no longer updates itself, so this page shows no update status.
    expect(await page.locator('.k42-top-bar, .k42-account-menu').count()).toBe(0);
    expect(await page.getByText(/Update status|Update when idle/).count()).toBe(0);
    expect(await page.getByRole('link', { name: 'My computers', exact: true }).count()).toBe(1);
    expect(await page.getByRole('link', { name: 'My agents', exact: true }).count()).toBe(0);
    await page.getByRole('link', { name: 'My computers', exact: true }).click();
    await page.screenshot({ animations: 'disabled', path: join(directory, 'desktop.png') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ animations: 'disabled', path: join(directory, `mobile-${width}.png`) });
    }
    const revoke = page.getByRole('button', { name: 'Revoke access for Synthetic work laptop', exact: true });
    await revoke.click(); const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Revoke access for Synthetic work laptop?' }).waitFor();
    expect(await dialog.innerText()).toContain('all agents connected through it');
    expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate((button: Element) => button === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape'); expect((await computerConnections.doc(id).get()).data()!.revokedAt).toBeNull();
    await page.route('**/api/owner/computers?*', (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic unavailable' }) }));
    await page.reload(); await page.getByRole('alert').filter({ hasText: 'Could not refresh' }).waitFor();
    await page.unroute('**/api/owner/computers?*'); await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByText('Synthetic work laptop', { exact: true }).waitFor();
    await revoke.click(); await page.getByRole('dialog').getByRole('button', { name: 'Revoke access', exact: true }).click();
    await page.getByText('No connected computers.', { exact: true }).waitFor();
    expect((await db.doc(`projects/${TEST_PROJECT}/agents/${agent.agentId}`).get()).data()!.revokedAt).not.toBeNull();
    expect(await inProject(TEST_PROJECT, () => agentByToken(token))).toBeNull();
    await page.screenshot({ animations: 'disabled', path: join(directory, 'empty.png') });
    expect(errors).toEqual([]);
    console.info(`Actual My computers: desktop, 390px, 320px, keyboard, real revocation, retry and empty state: ${directory}`);
  } catch (error) {
    if (page) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => ''), output.slice(-1000)); }
    throw error;
  } finally {
    if (browser) for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'wait' });
    await browser?.close(); await web.close(); api.kill('SIGTERM');
    await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); });
  }
}, 120_000);
