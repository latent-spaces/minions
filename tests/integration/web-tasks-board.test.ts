// The actual Tasks tab in the local app: the existing list stays the default, the Board view shows one column per status with
// title/agent/state cards, the choice survives a reload, a dropped card sends the real status change, and refusals leave the
// task unchanged. An ordinary member can drag only tasks whose status they may change; the State filter does not apply to the board. Disposable Auth/Firestore and API; no models.
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

test('actual Tasks tab offers the list and a status board, remembers the choice and moves cards through the real status change', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-tasks-board-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({ project: { name: 'Synthetic board', startsAt: Date.now() - 60000 }, profiles: [{ name: 'Demo owner', email: 'owner-board@example.test', role: 'owner' }, { name: 'Demo member', email: 'member-board@example.test' }],
    agents: [{ person: 0, name: 'Demo Fox' }, { person: 0, name: 'Demo Owl' }, { person: 1, name: 'Demo Kit' }] });
  for (const id of fixture.personIds) await profiles.doc(id).update({ onboardingCompletedAt: 100 });
  const actor: ProgressActor = { kind: 'person', person: { id: fixture.personIds[0], ...(await profiles.doc(fixture.personIds[0]).get()).data()! } as never };
  const [fox, owl, kit] = fixture.agents.map(a => a.agentId);
  const mutate = (input: Record<string, unknown>) => inProject(TEST_PROJECT, () => mutateNativeTask(actor, { clientRequestId: randomUUID(), ...input }));
  const create = async (title: string) => (await mutate({ operation: 'create', title })).task;
  const open = await create('Write the retirement inventory');
  const started = await create('Store native tasks with atomic claims');
  const assigned = await mutate({ operation: 'assign', taskId: started.id, expectedRevision: started.revision, assignedAgentId: fox });
  await mutate({ operation: 'update', taskId: started.id, expectedRevision: assigned.task.revision, status: 'in_progress' });
  const finished = await create('Agree the task completion policy');
  const finishedAssigned = await mutate({ operation: 'assign', taskId: finished.id, expectedRevision: finished.revision, assignedAgentId: owl });
  await mutate({ operation: 'update', taskId: finished.id, expectedRevision: finishedAssigned.task.revision, status: 'done' });
  const dropped = await create('Old idea nobody picked up');
  await mutate({ operation: 'update', taskId: dropped.id, expectedRevision: dropped.revision, status: 'canceled' });
  const ready = await create('Draft the launch note');
  await mutate({ operation: 'assign', taskId: ready.id, expectedRevision: ready.revision, assignedAgentId: owl });
  const kitTask = await create('Kit checks the sign-in copy');
  await mutate({ operation: 'assign', taskId: kitTask.id, expectedRevision: kitTask.revision, assignedAgentId: kit });
  const stored = (id: string) => inProject(TEST_PROJECT, async () => (await nativeTasks().doc(id).get()).data()!);

  const api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), ADMIN_EMAILS: 'admin@example.test' } });
  let apiOutput = ''; api.stdout?.on('data', data => { apiOutput += String(data); }); api.stderr?.on('data', data => { apiOutput += String(data); });
  const { createServer } = require('vite'), { chromium } = require('playwright');
  const web = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: Object.fromEntries(['/api', '/community', '/p', '/s'].map(path => [`^${path}(?:/|$)`, `http://127.0.0.1:${apiPort}`])) } });
  let browser: any, diagnostic: any;
  try {
    for (let n = 0; ; n++) {
      if (api.exitCode !== null) throw new Error(apiOutput);
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/needs-you`)).status === 401) break; } catch {}
      if (n > 100) throw new Error(apiOutput || 'API did not start'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    await web.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route: any) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const page = await context.newPage(); diagnostic = page;
    const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=tasks`);
    await signInBrowser(page, await idTokenFor('owner-board@example.test'));
    const tasks = page.getByRole('region', { name: /^Tasks/ });
    const viewSwitch = tasks.getByRole('group', { name: 'Tasks view', exact: true });
    await viewSwitch.waitFor();
    await tasks.getByRole('button', { name: 'Write the retirement inventory', exact: true }).waitFor();
    // The current table stays the default view; nothing about it changed.
    expect(await viewSwitch.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await tasks.locator('table.k42-tasks-table').count()).toBe(1);
    expect(await tasks.locator('.k42-tasks-board').count()).toBe(0);
    expect(await tasks.locator('table thead th').evaluateAll((nodes: Element[]) => nodes.map(node => { const copy = node.cloneNode(true) as Element; copy.querySelectorAll('select').forEach(select => select.remove()); return copy.textContent?.trim(); }))).toEqual(['Task', 'Owner', 'Agents', 'Status', 'Updated']);
    // A State filter chosen in the list does not apply to the board: its columns are the states.
    await tasks.getByRole('combobox', { name: 'State', exact: true }).selectOption('done');
    await tasks.locator('table tbody tr').filter({ hasText: 'Agree the task completion policy' }).waitFor();
    await expect.poll(() => tasks.locator('table tbody tr').count()).toBe(1);

    await viewSwitch.getByRole('button', { name: 'Board', exact: true }).click();
    const board = tasks.getByRole('list', { name: 'Tasks by status', exact: true });
    await board.waitFor();
    expect(await tasks.locator('table.k42-tasks-table').count()).toBe(0);
    expect(await tasks.getByRole('combobox', { name: 'State', exact: true }).count()).toBe(0);
    await tasks.getByText('Drag a card to another column, or open it to change its status.', { exact: true }).waitFor();
    await board.locator('.k42-tasks-column[aria-label="In progress"] .k42-tasks-card').waitFor();
    // Columns are the existing statuses in their order; cards carry title, assigned agent and state only.
    expect(await board.locator('.k42-tasks-column').evaluateAll((nodes: Element[]) => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['Backlog', 'In progress', 'Done', 'Canceled']);
    const column = (name: string) => board.locator(`.k42-tasks-column[aria-label="${name}"]`);
    expect(await column('Backlog').locator('.k42-tasks-card-title').allInnerTexts()).toEqual(expect.arrayContaining(['Write the retirement inventory', 'Draft the launch note', 'Kit checks the sign-in copy']));
    expect(await column('In progress').locator('.k42-tasks-card-title').allInnerTexts()).toEqual(['Store native tasks with atomic claims']);
    expect(await column('Done').locator('.k42-tasks-card-title').allInnerTexts()).toEqual(['Agree the task completion policy']);
    expect(await column('Canceled').locator('.k42-tasks-card-title').allInnerTexts()).toEqual(['Old idea nobody picked up']);
    const startedCard = column('In progress').locator('.k42-tasks-card');
    await startedCard.getByRole('button', { name: 'Demo Fox', exact: true }).waitFor();
    expect(await startedCard.locator('.k42-task-status').innerText()).toBe('In progress');
    expect(await startedCard.locator('.k42-task-description, .k42-task-comments, time').count()).toBe(0);
    const openCard = column('Backlog').locator('.k42-tasks-card', { hasText: 'Write the retirement inventory' });
    expect(await openCard.locator('.k42-task-unassigned').innerText()).toBe('Unassigned');
    expect(await column('Backlog').locator('.k42-tasks-count').innerText()).toBe('3');
    await page.screenshot({ animations: 'disabled', path: join(directory, 'board-1440.png') });

    // The choice is remembered on this browser across a reload, and List returns the table.
    await page.reload();
    await tasks.getByRole('list', { name: 'Tasks by status', exact: true }).waitFor();
    expect(await page.evaluate(() => localStorage.getItem('k42.tasksView'))).toBe('board');
    expect(await viewSwitch.getByRole('button', { name: 'Board', exact: true }).getAttribute('aria-pressed')).toBe('true');
    await column('In progress').locator('.k42-tasks-card').waitFor();

    // Dropping an assigned Backlog card on In progress sends the task page's status change; the server records it.
    const readyCard = column('Backlog').locator('.k42-tasks-card', { hasText: 'Draft the launch note' });
    expect(await readyCard.getAttribute('draggable')).toBe('true');
    // Holding a card over its own column is a harmless no-op: that column looks neutral, not refused.
    const readyBox = (await readyCard.boundingBox())!, backlogBox = (await column('Backlog').locator('.k42-tasks-column-head').boundingBox())!;
    await page.mouse.move(readyBox.x + 20, readyBox.y + 10); await page.mouse.down();
    await page.mouse.move(backlogBox.x + 30, backlogBox.y + 10, { steps: 5 });
    await expect.poll(() => readyCard.getAttribute('class')).toContain('is-dragging');
    expect(await column('Backlog').getAttribute('class')).not.toMatch(/is-refused|is-over/);
    await page.mouse.up();
    await expect.poll(() => readyCard.getAttribute('class')).not.toContain('is-dragging');
    expect((await stored(ready.id)).status).toBe('backlog');
    await readyCard.dragTo(column('In progress'));
    await column('In progress').locator('.k42-tasks-card', { hasText: 'Draft the launch note' }).waitFor();
    expect((await stored(ready.id)).status).toBe('in_progress');
    // An unassigned card cannot start: the app refuses before any request and the task stays in Backlog.
    await openCard.dragTo(column('Done'));
    await tasks.getByRole('status').filter({ hasText: 'Assign an agent before starting or completing this task.' }).waitFor();
    expect((await stored(open.id)).status).toBe('backlog');
    expect((await column('Backlog').locator('.k42-tasks-card-title').allInnerTexts()).sort()).toEqual(['Kit checks the sign-in copy', 'Write the retirement inventory']);
    // A canceled card may only reopen to Backlog.
    await column('Canceled').locator('.k42-tasks-card').dragTo(column('Backlog'));
    await column('Backlog').locator('.k42-tasks-card', { hasText: 'Old idea nobody picked up' }).waitFor();
    expect((await stored(dropped.id)).status).toBe('backlog');
    // Opening a card goes to the task page; Back returns to the board.
    await column('Done').getByRole('button', { name: 'Agree the task completion policy', exact: true }).click();
    await page.getByRole('heading', { name: 'Agree the task completion policy', exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.get('task')).toBe(finished.id);
    await page.getByRole('button', { name: 'Back to Tasks', exact: true }).click();
    await board.waitFor();
    expect(new URL(page.url()).searchParams.get('task')).toBeNull();

    // Phone width: the board scrolls sideways; the page does not.
    await page.setViewportSize({ width: 390, height: 844 });
    await board.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await board.evaluate((node: Element) => node.scrollWidth > node.clientWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'board-390.png') });
    await viewSwitch.getByRole('button', { name: 'List', exact: true }).click();
    await tasks.locator('table.k42-tasks-table').waitFor();
    expect(await page.evaluate(() => localStorage.getItem('k42.tasksView'))).toBe('list');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: join(directory, 'list-390.png') });

    // An ordinary member may move only a task whose status they may change: here the one assigned to their own agent.
    const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await memberContext.route('**/*', (route: any) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await memberContext.addInitScript(() => localStorage.setItem('k42.tasksView', 'board'));
    const member = await memberContext.newPage(); diagnostic = member;
    member.on('pageerror', (e: Error) => errors.push(e.message));
    const mutations: string[] = []; member.on('request', (request: any) => { if (request.method() === 'POST' && /tasks/.test(request.url())) mutations.push(request.url()); });
    await member.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=tasks`);
    await signInBrowser(member, await idTokenFor('member-board@example.test'));
    const memberBoard = member.getByRole('region', { name: /^Tasks/ }).getByRole('list', { name: 'Tasks by status', exact: true });
    await memberBoard.waitFor();
    const memberColumn = (name: string) => memberBoard.locator(`.k42-tasks-column[aria-label="${name}"]`);
    const kitCard = memberColumn('Backlog').locator('.k42-tasks-card', { hasText: 'Kit checks the sign-in copy' });
    await kitCard.waitFor();
    const foxCard = memberColumn('In progress').locator('.k42-tasks-card', { hasText: 'Store native tasks with atomic claims' });
    expect(await foxCard.getAttribute('draggable')).toBe('false');
    expect(await foxCard.evaluate((node: Element) => getComputedStyle(node).cursor)).not.toBe('grab');
    expect(await memberColumn('Backlog').locator('.k42-tasks-card', { hasText: 'Write the retirement inventory' }).getAttribute('draggable')).toBe('false');
    expect(await kitCard.getAttribute('draggable')).toBe('true');
    await foxCard.dragTo(memberColumn('Done'));
    expect(mutations).toEqual([]);
    expect((await stored(started.id)).status).toBe('in_progress');
    expect(await memberColumn('In progress').locator('.k42-tasks-card', { hasText: 'Store native tasks with atomic claims' }).count()).toBe(1);
    await member.screenshot({ animations: 'disabled', path: join(directory, 'board-member-1440.png') });
    await kitCard.dragTo(memberColumn('In progress'));
    await memberColumn('In progress').locator('.k42-tasks-card', { hasText: 'Kit checks the sign-in copy' }).waitFor();
    expect((await stored(kitTask.id)).status).toBe('in_progress');
    // A card the member cannot move still opens its task page, whose status buttons are disabled too.
    await foxCard.getByRole('button', { name: 'Store native tasks with atomic claims', exact: true }).click();
    const memberPage = member.getByRole('article', { name: 'Store native tasks with atomic claims', exact: true });
    await memberPage.getByRole('button', { name: 'Done', exact: true }).waitFor();
    expect(await memberPage.getByRole('button', { name: 'Done', exact: true }).isDisabled()).toBe(true);

    expect(errors).toEqual([]);
    console.info(`Verified actual Tasks list/board views, remembered choice, drag status changes and phone width: ${directory}`);
  } catch (e) { if (diagnostic) { await diagnostic.screenshot({ animations: 'disabled', path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await diagnostic.locator('body').innerText().catch(() => 'No UI'), apiOutput.slice(-1500)); } throw e; }
  finally { if (browser) for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'wait' }); await browser?.close(); await web.close(); api.kill('SIGTERM'); await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); }); }
}, 120_000);
