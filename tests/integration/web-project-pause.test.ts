import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { profiles, inProject, projectDoc } from '../../apps/server/src/firestore.js';
import { updateCanonicalStatus } from '../../apps/server/test/canonical-status-fixture.js';
import { runs } from '../../apps/server/src/v2/records.js';
import { startRun } from '../../apps/server/src/v2/runs.js';
import { syncWorkerSession } from '../../apps/server/src/projects/worker-sessions.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() {
  const server = portServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}

test('actual project Pause shows pending, confirmed and unreachable agents on Home and the map', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'minions-project-pause-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({profiles:[{name:'Pause reviewer',email:'pause-reviewer@example.test',role:'owner'}],
    agents:['Synthetic worker','Synthetic offline','Synthetic chat'].map(name=>({person:0,name}))});
  await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:100});
  const at = Date.now(), missions: string[] = [];
  await inProject(TEST_PROJECT,async()=>{
    for(const [i,agent] of fixture.agents.entries()) {
      const run=await startRun(agent.agentId,{clientRunId:randomUUID(),runnerVersion:'synthetic-no-model',takeover:false},()=>at);
      missions.push(run.run_id);
      if(i===2) {
        await runs().doc(agent.agentId).update({mode:'current_chat'});
        await updateCanonicalStatus(agent.agentId, {runMode:'current_chat'});
      }
      else await syncWorkerSession(agent.agentId,{run_id:run.run_id,missionId:run.run_id,generation:1,startedAt:at,
        deadlineAt:at+3600000,phase:'working',remainingSlots:64},()=>i===1?at-100000:at);
    }
  });
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
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/needs-you`)).status === 401) break; } catch {}
      if (n > 100) throw new Error(output || 'API did not start'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    await web.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MINIONS_TEST_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route: any) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    page = await context.newPage(); const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=control-center`);
    await signInBrowser(page, await idTokenFor('pause-reviewer@example.test'));
    await page.locator('.k42-status-panel').getByRole('button',{name:'Pause all agents',exact:true}).waitFor({timeout:25000});
    await page.locator('.k42-status-panel').getByRole('button',{name:'Pause all agents',exact:true}).click();
    const dialog=page.getByRole('dialog');
    expect(await dialog.innerText()).toContain('Each agent finishes its current turn, then waits.');
    await dialog.getByRole('button',{name:'Pause project',exact:true}).click();
    await page.locator('.k42-status-panel').getByRole('button',{name:'Resume all agents',exact:true}).waitFor();
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}`);
    const banner=page.locator('.k42-project-pause-status');
    await banner.waitFor({timeout:25000});
    await page.getByRole('button',{name:/^Select agent Synthetic worker\. Current status: Pausing\./}).waitFor();
    await page.getByRole('button',{name:/^Select agent Synthetic offline\. Current status: Pause unconfirmed\./}).waitFor();
    await page.getByRole('button',{name:/^Select agent Synthetic chat\. Current status: Pause unconfirmed\./}).waitFor();
    expect(await banner.innerText()).toContain('awaiting feedback');
    expect(await banner.innerText()).toContain('Pause those chats directly');
    await banner.scrollIntoViewIfNeeded();
    await page.screenshot({animations:'disabled',path:join(directory,'desktop-pending.png')});
    const pause=await inProject(TEST_PROJECT,async()=> (await projectDoc().get()).data()!.execution.pauseRequest!);
    await inProject(TEST_PROJECT,()=>syncWorkerSession(fixture.agents[0].agentId,{run_id:missions[0],missionId:missions[0],generation:1,startedAt:at,
      deadlineAt:at+3600000,phase:'paused',remainingSlots:64,projectPauseRevision:pause.revision},Date.now));
    const worker=page.getByRole('button',{name:/^Select agent Synthetic worker\. Current status: Paused\./});
    await worker.waitFor({timeout:15000});
    const sidebarWorker=page.getByRole('navigation',{name:'My agents',exact:true}).locator('a').filter({hasText:'Synthetic worker'});
    await expect.poll(()=>sidebarWorker.locator('small').innerText(),{timeout:20000}).toBe('Paused');
    expect(await banner.innerText()).toContain('1 paused');
    await worker.focus();
    await page.getByText('Runtime confirmed that work has paused.',{exact:false}).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.k42-communication').scrollIntoViewIfNeeded();
    await page.screenshot({animations:'disabled',path:join(directory,'desktop-confirmed.png')});
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await banner.scrollIntoViewIfNeeded();
      await page.screenshot({animations:'disabled',path:join(directory,`mobile-${width}.png`)});
    }
    expect(errors).toEqual([]);
    console.info(`Actual app project Pause: pending and confirmed map states, external chat, offline, keyboard, desktop/390/320 screenshots: ${directory}`);
  } catch (error) {
    if (page) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => ''), output.slice(-1000)); }
    throw error;
  } finally {
    if (browser) for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'wait' });
    await browser?.close(); await web.close(); api.kill('SIGTERM');
    await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); });
  }
}, 120_000);
