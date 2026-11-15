import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as reservePort } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { disposableTarget } from '../support/disposable-session.mjs';
import { signInBrowser } from '../support/browser-session.js';
import { idTokenFor } from '../../apps/server/test/helpers.js';
import { seed, TEST_PROJECT } from '../../apps/server/test/helpers.js';
import { profiles } from '../../apps/server/src/firestore.js';

disposableTarget();
const folder = process.argv[2]; if (!folder) throw new Error('Run node tests/manual/native-teams-app.mjs.');
const root = fileURLToPath(new URL('../../', import.meta.url)), evidence = join(folder, 'native-teams-evidence');
await mkdir(evidence, { recursive: true });
async function port() { const server = reservePort(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value; }
const webPort = await port(), apiPort = await port(), origin = `http://127.0.0.1:${webPort}`;
Object.assign(process.env, { KARMA_LOCAL_API_URL: `http://127.0.0.1:${apiPort}` });
const email = 'native-team-owner@example.test';
const fixture = await seed({ project: { name: 'Teams · example data', mission: 'Local Teams verification with synthetic records. No model execution.' }, profiles: [{ name: 'Oron · example data', email, role: 'owner' }], agents: [{ person: 0, name: 'Scout' }, { person: 0, name: 'Builder' }, { person: 0, name: 'Reviewer' }] });
await profiles.doc(fixture.personIds[0]).update({ onboardingCompletedAt: Date.now() });
await idTokenFor(email);
let api: ReturnType<typeof spawn> | undefined, web: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const clients: Client[] = [], errors: string[] = [], controlCalls: string[] = [], checks: string[] = [];
async function agent(index: number) {
  const token = fixture.agents[index].token, base = `http://127.0.0.1:${apiPort}/p/${TEST_PROJECT}/v2`;
  const response = await fetch(`${base}/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ client_run_id: randomUUID(), runner_version: 'local-acceptance' }) });
  assert.equal(response.status, 200); const run = await response.json();
  const client = new Client({ name: 'synthetic-team-agent', version: '1' }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, 'X-Pilot-Run': run.run_id } } }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.ok(!reply.isError, JSON.stringify(reply)); return JSON.parse((reply.content as { text: string }[])[0].text);
  };
}
try {
  api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort) } });
  for (let attempt = 0; ; attempt++) {
    if (api.exitCode !== null) throw new Error('Local API exited.');
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/needs-you`)).status === 401) break; } catch {}
    if (attempt > 100) throw new Error('Local API did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  web = await createServer({ root: join(root, 'apps/web'), cacheDir: join(folder, 'vite-cache'), configFile: join(root, 'apps/web/vite.config.ts'), server: { fs: { allow: [root] }, host: '127.0.0.1', port: webPort, strictPort: true } }); await web.listen();
  browser = await chromium.launch({ headless: true, args: ['--single-process'], ...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MINIONS_TEST_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(15_000);
  await context.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (/\/(background-control|participation|steering|extend)$/.test(new URL(req.url()).pathname) && req.method() !== 'GET') controlCalls.push(req.url()); });
  await page.goto(`${origin}/`);
  await signInBrowser(page, await idTokenFor(email));
  const settingsUrl = `${origin}/?project=${TEST_PROJECT}&section=control-center`;
  await page.goto(settingsUrl);
  const toggle = page.getByRole('group', { name: 'Teams', exact: true });
  const on = toggle.getByRole('button', { name: 'On', exact: true }), off = toggle.getByRole('button', { name: 'Off', exact: true });
  await off.waitFor(); assert.equal(await off.getAttribute('aria-pressed'), 'true');
  const nav = page.getByRole('navigation', { name: 'Project sections' });
  assert.equal(await nav.getByRole('link', { name: 'Teams', exact: true }).count(), 0);
  await page.screenshot({ path: join(evidence, 'teams-off-control-center.png'), fullPage: true, animations: 'disabled' });
  await on.press('Enter');
  await nav.getByRole('link', { name: 'Teams', exact: true }).waitFor(); checks.push('Teams starts OFF; the owner enables it in actual Control center; navigation follows the saved setting.');
  const [scout, builder, reviewer] = await Promise.all([agent(0), agent(1), agent(2)]);
  let launch = (await scout('manage_team', { operation: 'create', name: 'Beta launch', purpose: 'Coordinate onboarding checks, launch materials and release readiness.', client_request_id: 'launch' })).team;
  launch = (await builder('manage_team', { operation: 'join', team_id: launch.id, expected_revision: launch.revision, client_request_id: 'join-builder' })).team;
  await nav.getByRole('link', { name: 'Teams', exact: true }).click();
  await page.getByRole('button', { name: 'Beta launch 2 members', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Team details', exact: true });
  await detail.getByRole('heading', { name: 'Members (2)', exact: true }).waitFor();
  // Mutate through the real MCP after the browser view is already open. Neither
  // the directory nor the selected roster/history may require a refresh click.
  launch = (await reviewer('manage_team', { operation: 'join', team_id: launch.id, expected_revision: launch.revision, client_request_id: 'join-reviewer' })).team;
  const row = page.getByRole('button', { name: 'Beta launch 3 members', exact: true }); await row.waitFor();
  await detail.getByRole('heading', { name: 'Members (3)', exact: true }).waitFor();
  await detail.getByText('Reviewer joined', { exact: true }).waitFor();
  await builder('manage_team', { operation: 'create', name: 'Onboarding', purpose: 'Help participants connect their agents and understand the project.', client_request_id: 'onboarding' });
  await page.getByRole('button', { name: 'Onboarding 1 member', exact: true }).waitFor();
  checks.push('Realtime MCP mutations update an already-open directory and selected roster/history without manual refresh.');
  const docs = (await reviewer('manage_team', { operation: 'create', name: 'Documentation', purpose: 'Keep the shared instructions clear.', client_request_id: 'docs' })).team;
  await reviewer('manage_team', { operation: 'archive', team_id: docs.id, expected_revision: docs.revision, client_request_id: 'archive-docs' });
  await detail.getByRole('heading', { name: 'Members (3)', exact: true }).waitFor();
  await detail.getByText('Builder', { exact: true }).waitFor();
  await detail.getByText('Reviewer joined', { exact: true }).waitFor();
  await page.locator('.k42-teams').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(evidence, 'teams-desktop.png'), fullPage: true, animations: 'disabled' });
  checks.push('Agent MCP create/self-join records appear in the actual directory/detail view with named members, owner portraits and attributed history.');
  await page.getByRole('searchbox', { name: 'Search teams' }).fill('missing');
  await page.getByText('No teams match', { exact: true }).waitFor();
  assert.equal(await page.locator('.k42-teams-split').evaluate(element => Math.abs(element.getBoundingClientRect().width - element.querySelector('.k42-teams-directory')!.getBoundingClientRect().width) < 3), true);
  await page.getByRole('searchbox', { name: 'Search teams' }).fill('BETA'); await row.waitFor();
  await page.getByRole('searchbox', { name: 'Search teams' }).fill('');
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('button', { name: 'Documentation 1 member', exact: true }).click();
  await detail.getByText('Archived · any current team member can restore this team.', { exact: true }).waitFor();
  checks.push('Search is case-insensitive; archived teams retain readable membership and history.');
  await page.getByRole('button', { name: 'Active', exact: true }).click(); await row.click();
  await detail.getByRole('heading', { name: 'Members (3)', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await detail.evaluate(element => element.scrollIntoView({ block: 'start' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(evidence, 'teams-mobile-detail.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close team details', exact: true }).click();
  await row.waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('k42-team-row'));
  assert.equal(await row.evaluate(element => element === document.activeElement), true);
  await page.locator('.k42-teams').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(evidence, 'teams-mobile-directory.png'), fullPage: true, animations: 'disabled' });
  checks.push('Phone layout shows one pane at a time, returns to the directory, and has no horizontal overflow.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav.getByRole('link', { name: 'Control center', exact: true }).click();
  await page.getByRole('link', { name: 'Project features', exact: true }).click();
  await off.waitFor(); await off.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.setting-toggle')].some(group => group.textContent?.includes('Teams') && [...group.querySelectorAll('button')].some(button => button.textContent === 'Off' && button.matches('[aria-pressed="true"]:enabled'))));
  await nav.getByRole('link', { name: 'Teams', exact: true }).waitFor({ state: 'hidden' });
  await page.goto(`${origin}/?project=${TEST_PROJECT}&section=teams`);
  try { await page.getByText('Teams are off. Existing teams, memberships and history are read-only.', { exact: true }).waitFor(); } catch (error) {
    await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true });
    await writeFile(join(evidence, 'failure.txt'), `URL: ${page.url()}\n${await page.locator('body').innerText()}`);
    throw error;
  }
  await row.click(); await detail.getByRole('heading', { name: 'Members (3)', exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'teams-disabled-retained-records.png'), fullPage: true, animations: 'disabled' });
  assert.equal((await scout('read_teams', { team_id: launch.id })).members.length, 3);
  checks.push('OFF hides navigation but direct retained reads still show the complete team roster/history.');
  assert.deepEqual(errors, []); assert.deepEqual(controlCalls, []);
  checks.push('No page errors, model execution or agent-control requests.');
  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ checks, errors, controlCalls }, null, 2));
  console.log(JSON.stringify({ evidence, checks }, null, 2));
} finally {
  await Promise.all(clients.map(client => client.close())); await browser?.close(); await web?.close();
  if (api && api.exitCode === null) { api.kill('SIGTERM'); await new Promise<void>(resolve => api!.once('exit', () => resolve())); }
}
