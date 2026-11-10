import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationEntries } from '../../apps/server/src/projects/steering.js';
import { profiles, inProject } from '../../apps/server/src/firestore.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() { const s = portServer(); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve)); const value = (s.address() as { port: number }).port; await new Promise<void>(resolve => s.close(() => resolve())); return value; }

test('actual Conversations filter authors at desktop and phone widths', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-author-filter-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({project:{name:'Synthetic Home feed',startsAt:Date.now()-60000},profiles:[{name:'Demo author',email:'author@example.test'},{name:'Other person',email:'other@example.test'}],agents:[{person:0,name:'Demo Fox'},{person:1,name:'Other Owl'}]});
  await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:100});
  await inProject(TEST_PROJECT, async () => {
    for (let n = 0; n < 3; n++) {
      const id = ['root', 'mine', 'other'][n];
      await conversationEntries().doc(id).set({ id, threadId: 'root', kind: 'agent_message',
        agentId: fixture.agents[n === 1 ? 0 : 1].agentId, agentName: n === 1 ? 'Demo Fox' : 'Other Owl',
        body: ['Other root message', 'My checkpoint message', 'Other reply message'][n],
        createdAt: 100 + n, protocol: 2, audience: 'project', to: ['project'],
      });
    }
  });
  const api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), ADMIN_EMAILS: 'admin@example.test' } });
  let apiOutput = ''; api.stdout?.on('data', data => { apiOutput += String(data); }); api.stderr?.on('data', data => { apiOutput += String(data); });
  const { createServer } = require('vite'), { chromium } = require('playwright');
  const web = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}`, '/community': `http://127.0.0.1:${apiPort}`, '/p': `http://127.0.0.1:${apiPort}` } } });
  let browser: any, diagnostic: any;
  try {
    for (let n = 0; ; n++) {
      if (api.exitCode !== null) throw new Error(apiOutput);
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/feedback/admin`)).status === 401) break; } catch {}
      if (n > 100) throw new Error(apiOutput || 'API did not start'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    await web.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route('**/*',(route:any)=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    const page=await context.newPage(); diagnostic=page;
    const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${webPort}/viewer/?project=${TEST_PROJECT}`);
    await signInBrowser(page, await idTokenFor('author@example.test'));
    const tabs = page.getByRole('navigation', { name: 'Project sections', exact: true });
    await tabs.getByRole('link', { name: 'Conversations', exact: true }).click();
    const conversations = page.locator('.conversations');
    await conversations.getByRole('button', { name: 'Show conversation: Other root message', exact: true }).waitFor();
    const mine = conversations.getByRole('button', { name: 'Me + my agents', exact: true });
    await mine.focus(); await page.keyboard.press('Enter');
    const card = conversations.getByRole('button', { name: 'Show conversation: My checkpoint message', exact: true });
    await card.waitFor(); await card.click();
    await conversations.locator('.conversation-thread').getByText('My checkpoint message', { exact: true }).waitFor();
    expect(await conversations.locator('.conversation-thread').getByText('Other reply message', { exact: true }).count()).toBe(0);
    expect(await conversations.locator('.conversation-thread').getByText('Other root message', { exact: true }).count()).toBe(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await mine.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ animations: 'disabled', path: join(directory, `conversations-${width}.png`) });
    }
    await conversations.getByRole('button', { name: 'All', exact: true }).click();
    await conversations.getByRole('button', { name: 'Show conversation: Other root message', exact: true }).waitFor();
    await inProject(TEST_PROJECT, async () => {
      const own = await conversationEntries().where('agentId', '==', fixture.agents[0].agentId).get();
      await Promise.all(own.docs.map(doc => doc.ref.delete()));
    });
    await mine.click();
    await conversations.getByText('No conversations from you or your agents yet', { exact: true }).waitFor();
    expect(errors).toEqual([]);
    console.info(`Author filter desktop/mobile screenshots: ${directory}`);
  } catch (error) {
    if (diagnostic) { await diagnostic.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await diagnostic.locator('body').innerText().catch(() => ''), apiOutput.slice(-1500)); }
    throw error;
  } finally {
    await browser?.close(); await web.close(); api.kill('SIGTERM');
    await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); });
  }
}, 120_000);
