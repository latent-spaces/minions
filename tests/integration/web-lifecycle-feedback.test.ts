import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profiles, db } from '../../apps/server/src/firestore.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() {
  const server = portServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}

test('actual lifecycle feedback follows success, stays optional, retries privately and honors the saved opt-out', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-lifecycle-feedback-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({ profiles: [{ name: 'Pause reviewer', email: 'pause-reviewer@example.test', role: 'owner' }], agents: [] });
  await profiles.doc(fixture.personIds[0]).update({ onboardingCompletedAt: 100 });
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', (route: any) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    page = await context.newPage(); const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=control-center&tab=status`);
    await signInBrowser(page, await idTokenFor('pause-reviewer@example.test'));
    const controls = page.locator('.project-controls-card');
    async function act(name: string) {
      await controls.getByRole('button', { name, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    }
    await controls.getByRole('button', { name: 'Pause project', exact: true }).waitFor({ timeout: 25000 });
    await act('Pause project');
    const prompt = page.getByRole('complementary', { name: 'Optional pause feedback' });
    await prompt.waitFor();
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'desktop-pause.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'mobile-pause.png') });
    await prompt.getByRole('button', { name: 'Give feedback', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Taking a break', { exact: true }).focus();
    await page.keyboard.press('Space');
    let lost = false;
    await page.route('**/api/feedback/reports', async (route: any) => {
      const response = await route.fetch();
      if (!lost) { lost = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic lost response' }) }); }
      else await route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: 'Send feedback', exact: true }).click();
    await dialog.getByText('Synthetic lost response', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Retry same feedback', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Feedback sent' }).waitFor();
    const reports = await db.collection('feedbackReports').get();
    expect(reports.size).toBe(1);
    expect(reports.docs[0].data()).toMatchObject({ body: 'After pausing a project: Taking a break', page: null, hasScreenshot: false });
    expect(reports.docs[0].data()).not.toHaveProperty('projectId');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.unroute('**/api/feedback/reports');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await act('Resume project');
    await controls.getByRole('button', { name: 'Pause project', exact: true }).waitFor();
    // Refused/unconfirmed lifecycle changes do not open a survey.
    await page.route('**/api/projects/*/control', async (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic control failure' }) }));
    await act('Close project');
    await page.getByRole('button', { name: 'Retry close project', exact: true }).waitFor();
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page.unroute('**/api/projects/*/control');
    await page.getByRole('button', { name: 'Retry close project', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'How did this project go?' }).waitFor();
    expect(new URL(page.url()).searchParams.get('view')).toBe('projects');
    expect(await dialog.getByRole('radio').count()).toBe(4);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'desktop-close.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'mobile-close.png') });
    // Opt-out is independent of submission and does not submit the enclosing feedback form.
    await dialog.getByRole('button', { name: 'Don’t ask me again', exact: true }).click();
    await dialog.getByRole('button', { name: 'Feedback prompts turned off', exact: true }).waitFor();
    expect((await db.collection('feedbackReports').get()).size).toBe(1);
    await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
    // The profile page left the local app; the saved preference is checked in Firestore and by the next lifecycle change.
    expect((await profiles.doc(fixture.personIds[0]).get()).data()?.feedbackPreferences?.promptsEnabled).toBe(false);
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=control-center&tab=status`);
    await controls.getByRole('button', { name: 'Reopen project', exact: true }).waitFor({ timeout: 25000 });
    await act('Reopen project');
    await controls.getByRole('button', { name: 'Resume project', exact: true }).waitFor();
    await act('Close project');
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('projects');
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(errors).toEqual([]);
    console.info(`Lifecycle feedback actual app desktop/mobile, keyboard-native choices, retry, failed action, navigation and saved opt-out: ${directory}`);
  } catch (error) {
    if (page) { await page.screenshot({ animations: 'disabled', path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => ''), output.slice(-1000)); }
    throw error;
  } finally {
    if (browser) for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'wait' });
    await browser?.close(); await web.close(); api.kill('SIGTERM');
    await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); });
  }
}, 120_000);
