import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as reservePort } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { disposableTarget } from '../support/disposable-session.mjs';
import { signInBrowser } from '../support/browser-session.js';
import { idTokenFor } from '../../apps/server/test/helpers.js';
import { profiles } from '../../apps/server/src/firestore.js';
import { createPrivateProject } from '../../apps/server/src/projects/private.js';
import { seedRuntime } from '../../apps/server/test/helpers.js';
import { createWebAgentStart,publishRuntimeReadiness,acceptAgentStart } from '../../apps/server/src/owner/web-agent-starts.js';
import { connectOwnAgent } from '../../apps/server/src/owner/agents.js';
import { inProject } from '../../apps/server/src/firestore.js';
import { hashToken } from '../../apps/server/src/auth.js';

disposableTarget();
const folder = process.argv[2]; if (!folder) throw new Error('Run node tests/manual/repository-readiness-app.mjs.');
const root = fileURLToPath(new URL('../../', import.meta.url));
async function port() {
  const server = reservePort(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value;
}
const webPort = await port(), apiPort = await port(), origin = `http://127.0.0.1:${webPort}`;
Object.assign(process.env, { KARMA_LOCAL_API_URL: `http://127.0.0.1:${apiPort}` });
const people=[{id:'readiness-owner',name:'Owner · synthetic',email:'readiness-owner@example.test',removedAt:null,onboardingCompletedAt:Date.now()}];
await profiles.doc(people[0].id).create(people[0]);
const {id}=await createPrivateProject(people[0],{client_request_id:randomUUID(),title:'Repository readiness · synthetic',goal:'Focused application acceptance; no models.',githubUrl:'https://github.com/example/synthetic'},Date.now) as {id:string};
const projectUrl = `${origin}/?project=${id}&section=agents`;
let api: ReturnType<typeof spawn> | undefined, web: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [];
async function screenshot(page: Page, name: string) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} fits`);
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
  browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
  async function open(person: typeof people[number]) {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(45_000);
    await context.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`);
    await signInBrowser(page, await idTokenFor(person.email));
    await page.goto(projectUrl); return page;
  }
  await seedRuntime(id,{started:true,paused:false});
  const incarnation=randomUUID(),requestId=randomUUID(),now=Date.now;
  await publishRuntimeReadiness(people[0].id,{protocol:1,version:'synthetic',incarnation,platform:'darwin',github:'ready',providers:[{id:'claude',available:true,reason:'ready'}]},now);
  await createWebAgentStart(people[0].id,{id:requestId,projectId:id,name:'repository-check-synthetic',execution:{provider:'claude',model:null},approved:true},now);
  await inProject(id,()=>connectOwnAgent(people[0].id,{name:'repository-check-synthetic',candidateTokenHash:hashToken(randomUUID()),clientName:'Synthetic browser check',folder:'/tmp/synthetic-no-execution',webStartId:requestId},now));
  await acceptAgentStart(people[0].id,requestId,{incarnation,waitingFor:'github',repository:{waitingFor:'github',code:'git_authentication_failed',checkedAt:now()}},now);
  const owner=await open(people[0]);
  const message=owner.locator('main').getByText(/Last repository check:.*Git authentication/).first();
  await message.waitFor();
  const summary=owner.locator('.background-worker-row');
  assert.match(await summary.innerText(),/Waiting/);
  assert.equal(await summary.getByText('Set up…',{exact:true}).count(),0);
  await message.scrollIntoViewIfNeeded();
  assert.ok(!(await owner.locator('body').innerText()).includes('accepts the owner’s invitation'));
  await screenshot(owner,'repository-wait-desktop');
  await owner.setViewportSize({width:390,height:844});await message.scrollIntoViewIfNeeded();await screenshot(owner,'repository-wait-mobile');
  assert.deepEqual(errors,[]);
  console.info('Repository readiness actual-app desktop/mobile checks passed. Evidence: '+folder);
} catch (failure) {
  for (const [index, context] of (browser?.contexts() ?? []).entries()) for (const page of context.pages()) {
    await page.screenshot({ path: join(folder, `failure-${index}.png`), fullPage: true }).catch(() => {});
    await writeFile(join(folder, `failure-${index}.txt`), await page.locator('body').innerText()).catch(() => {});
  }
  throw failure;
} finally {
  await browser?.close(); await web?.close();
  if (api && api.exitCode === null) { api.kill('SIGTERM'); await new Promise<void>(resolve => api!.once('exit', () => resolve())); }
}
