import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as reservePort } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { disposableTarget } from '../support/disposable-session.mjs';
import { signInBrowser } from '../support/browser-session.js';
import { idTokenFor } from '../../apps/server/test/helpers.js';
import { agents, profiles, inProject } from '../../apps/server/src/firestore.js';
import { seed, TEST_PROJECT } from '../../apps/server/test/helpers.js';
import { startRun } from '../../apps/server/src/v2/runs.js';
import { sendMessageV2 } from '../../apps/server/src/v2/messages.js';
import { syncWorkerSession } from '../../apps/server/src/projects/worker-sessions.js';
import { submitSteering, observeSteering } from '../../apps/server/src/projects/steering.js';

disposableTarget();
const folder=process.argv[2]; if(!folder)throw new Error('Run node tests/manual/grouped-steering-app.mjs.');
const root=fileURLToPath(new URL('../../',import.meta.url));
async function port(){const server=reservePort();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const value=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return value;}
const webPort=await port(),apiPort=await port(),origin=`http://127.0.0.1:${webPort}`;
Object.assign(process.env,{KARMA_LOCAL_API_URL:`http://127.0.0.1:${apiPort}`});
const email='steering-owner@example.test',now=Date.now();
const fixture=await seed({project:{name:'Steering check · synthetic'},profiles:[{name:'Alice · synthetic',email}],agents:[{person:0,name:'Atlas · synthetic'},{person:0,name:'Nova · synthetic'}]});
await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:now});
const scope=<T>(f:()=>T)=>inProject(TEST_PROJECT,f);
const recipients=[];
for(const agent of fixture.agents){const run=await scope(()=>startRun(agent.agentId,{clientRunId:randomUUID(),runnerVersion:'synthetic-no-model',takeover:false},()=>now));await scope(()=>syncWorkerSession(agent.agentId,{run_id:run.run_id,missionId:run.run_id,startedAt:now,deadlineAt:now+600000,remainingSlots:64,phase:'waiting',generation:1},()=>now));recipients.push({agentId:agent.agentId,missionId:run.run_id,generation:1,operationId:randomUUID()});}
const instruction='Focus on finishing the onboarding flow. Synthetic instruction; no models run.';
const sent=await scope(()=>submitSteering(fixture.personIds[0],{operationId:recipients[0].operationId,recipients,body:instruction,origin:'coding_chat'},()=>now+1));
const d=recipients[0];await scope(()=>observeSteering(d.agentId,{receiptId:createHash('sha256').update(JSON.stringify(['steering',d.missionId,d.operationId,'included'])).digest('hex'),operationId:d.operationId,missionId:d.missionId,generation:1,state:'included',sequence:3,observedAt:now+2,turnId:randomUUID()},()=>now+2));
const agent=(await scope(()=>agents().doc(d.agentId).get())).data()!;
await scope(()=>sendMessageV2({...agent,id:d.agentId},{clientId:'explicit-reply',to:[],threadId:sent.message.id,body:'I will check the first onboarding step. Synthetic reply.'},()=>now+3));
let api: ReturnType<typeof spawn> | undefined, web: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [];
async function signIn(page: Page, email: string) {
  await signInBrowser(page, await idTokenFor(email));
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true });
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
  const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(20000);
  await context.route('**/*',route=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/`);await signIn(page,email);
  await page.goto(`${origin}/?project=${TEST_PROJECT}&section=conversations`);
  const card=page.locator('.conversation-card');await card.first().waitFor();assert.equal(await card.count(),1);
  await card.getByRole('button',{name:/Show conversation/}).click();
  await page.getByText(instruction,{exact:true}).waitFor();assert.equal(await page.getByText(instruction,{exact:true}).count(),1);
  await page.getByText('I will check the first onboarding step. Synthetic reply.',{exact:true}).waitFor();
  const summary=page.locator('details.steering-delivery > summary');await summary.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('details.steering-delivery').getAttribute('open'),'');
  assert.equal(await page.locator('details.steering-delivery li').count(),2);
  assert.match(await summary.innerText(),/Included in a turn: 1/);assert.match(await summary.innerText(),/Queued: 1/);
  await screenshot(page,'steering-desktop');
  await page.setViewportSize({width:390,height:844});await screenshot(page,'steering-mobile');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await summary.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('details.steering-delivery').getAttribute('open'),null);
  assert.deepEqual(errors,[]);
  console.info(JSON.stringify({result:'passed',checks:['one conversation for two recipients','instruction appears once','explicit reply shares thread','independent queued/included states','keyboard disclosure','390px without horizontal overflow'],screenshots:folder}));
} finally {
  await browser?.close(); await web?.close();
  if (api && api.exitCode === null) { api.kill('SIGTERM'); await new Promise<void>(resolve => api!.once('exit', () => resolve())); }
}
