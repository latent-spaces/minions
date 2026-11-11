// Actual local app and API, disposable SQLite, synthetic tasks, no models.
import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inProject, profiles } from '../../apps/server/src/firestore.js';
import { mutateNativeTask, nativeTasks } from '../../apps/server/src/projects/native-tasks.js';
import type { ProgressActor } from '../../apps/server/src/projects/progress-authority.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() { const s = portServer(); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve)); const value = (s.address() as { port: number }).port; await new Promise<void>(resolve => s.close(() => resolve())); return value; }

test('the actual task list keeps exact subtask rings across pagination, filters, collapse and child changes', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-subtask-counts-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({ project: { name: 'Synthetic subtask counts', startsAt: Date.now() - 60000 },
    profiles: [{ name: 'Demo owner', email: 'owner-counts@example.test', role: 'owner' }], agents: [{ person: 0, name: 'Demo Fox' }] });
  await profiles.doc(fixture.personIds[0]).update({ onboardingCompletedAt: 100 });
  const actor: ProgressActor = { kind: 'person', person: { id: fixture.personIds[0], ...(await profiles.doc(fixture.personIds[0]).get()).data()! } };
  const mutate = (input: Record<string, unknown>) => inProject(TEST_PROJECT, () => mutateNativeTask(actor, { clientRequestId: randomUUID(), ...input }));
  const template = (await mutate({ operation: 'create', title: 'Seed' })).task;
  const rootId = 'task_000_parent';
  await inProject(TEST_PROJECT, async () => {
    await nativeTasks().doc(rootId).set({ ...template, id: rootId, title: 'Synthetic counted parent' });
    // A root on the first page, 120 accepted children on later pages, plus a pending proposal.
    for (let i = 0; i < 120; i++) {
      const id = `task_100_child_${String(i).padStart(3, '0')}`;
      await nativeTasks().doc(id).set({ ...template, id, title: `Synthetic child ${i}`, parentId: rootId,
        status: i < 30 ? 'done' : i < 60 ? 'canceled' : 'backlog', assignedAgentId: fixture.agents[0].agentId });
    }
    await nativeTasks().doc('task_proposed').set({ ...template, id: 'task_proposed', title: 'Synthetic proposal', parentId: rootId, proposed: true });
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
    await web.listen(); browser = await chromium.launch({ headless: true, args: ['--single-process'], ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route: any) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const page = await context.newPage(); diagnostic = page;
    const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${webPort}/viewer/?project=${TEST_PROJECT}&section=tasks`);
    await signInBrowser(page, await idTokenFor('owner-counts@example.test'));
    const tasks = page.getByRole('region', { name: /^Tasks/ });
    const viewSwitch = tasks.getByRole('group', { name: 'Tasks view', exact: true });
    await viewSwitch.waitFor();
    await tasks.getByRole('button', { name: 'Synthetic counted parent', exact: true }).waitFor();
    const row = tasks.locator('table tbody tr').filter({ has: page.getByRole('button', { name: 'Synthetic counted parent', exact: true }) });
    const ring = row.locator('.k42-subtask-ring');
    const title = '60 of 120 subtasks done or canceled';
    await expect.poll(() => ring.getAttribute('title')).toBe(title);
    expect(await tasks.locator('table tbody tr').count()).toBe(50);
    await tasks.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect.poll(() => tasks.locator('table tbody tr').count()).toBe(100);
    expect(await ring.getAttribute('title')).toBe(title);
    await row.getByRole('button', { name: 'Hide subtasks of Synthetic counted parent' }).click();
    expect(await ring.getAttribute('title')).toBe(title);
    await row.getByRole('button', { name: 'Show subtasks of Synthetic counted parent' }).click();
    // Both filters remove all accepted child rows; neither changes the parent's exact ring.
    await tasks.getByRole('combobox', { name: 'State', exact: true }).selectOption('backlog');
    await expect.poll(() => ring.getAttribute('title')).toBe(title);
    await tasks.getByRole('combobox', { name: 'Assigned agent', exact: true }).selectOption('unassigned');
    await expect.poll(() => tasks.locator('table tbody tr').count()).toBe(3);
    expect(await ring.getAttribute('title')).toBe(title);
    await tasks.getByRole('searchbox', { name: 'Search tasks', exact: true }).fill('Synthetic counted parent');
    await tasks.getByRole('searchbox', { name: 'Search tasks', exact: true }).press('Enter');
    await expect.poll(() => tasks.locator('table tbody tr').count()).toBe(1);
    expect(await ring.getAttribute('title')).toBe(title);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'filtered-exact-counts.png') });
    // The parent revision stays the same when a child closes. A refreshed list still updates the count.
    await mutate({ operation: 'update', taskId: 'task_100_child_060', expectedRevision: template.revision, status: 'done' });
    await tasks.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
    await expect.poll(() => ring.getAttribute('title')).toBe('61 of 120 subtasks done or canceled');
    await tasks.getByRole('button', { name: 'Synthetic counted parent', exact: true }).click();
    const article = page.getByRole('article', { name: 'Synthetic counted parent', exact: true });
    await article.waitFor();
    await expect.poll(() => article.locator('.k42-subtask-ring').getAttribute('title')).toBe('61 of 120 subtasks done or canceled');
    expect(await article.locator('.k42-task-subtasks li').count()).toBe(100);
    expect(await article.getByText('All subtasks are done or canceled.', { exact: false }).count()).toBe(0);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'task-page-exact-counts.png') });
    expect(errors).toEqual([]);
    console.info(`Verified exact task rings with the actual local API and app: ${directory}`);
  } catch (e) { if (diagnostic) { await diagnostic.screenshot({ animations: 'disabled', path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await diagnostic.locator('body').innerText().catch(() => 'No UI'), apiOutput.slice(-1500)); } throw e; }
  finally { if (browser) for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'wait' }); await browser?.close(); await web.close(); api.kill('SIGTERM'); await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); }); }
}, 120_000);
