import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, profiles } from '../../apps/server/src/firestore.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() {
  const server = portServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}

test('actual app keeps coding-tool identity separate from model names across sidebar, cards and details', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-agent-icons-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({ profiles: [{name:'Icon reviewer',email:'icons@example.test'}], agents: [
    {person:0,name:'Alpha worker'}, {person:0,name:'Beta worker'}, {person:0,name:'Gamma unknown'},
  ] });
  await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:100});
  for (const [index, provider, model] of [[0,'claude','gpt-synthetic-reroute'],[1,'codex','claude-synthetic-reroute'],[2,'unknown','claude-no-tool-report']] as const) {
    await db.doc(`projects/${TEST_PROJECT}/runnerUsage/${fixture.agents[index].agentId}`).set({
      runId:'synthetic-no-model',provider,model,firstReportedAt:Date.now(),lastReportedAt:Date.now(),turns:0,seconds:0,
      input:0,output:0,cacheRead:0,cacheWrite:0,modelCalls:0,costUsd:0,costReports:0,tokenReports:0,
      tokenCoverage:{input:0,output:0,cacheRead:0,cacheWrite:0},inputSemantics:'uncached',
    });
  }
  const api = spawn(process.execPath, ['--import','tsx','apps/server/test/api-process.ts'], {cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOST:'127.0.0.1',PORT:String(apiPort),ADMIN_EMAILS:'admin@example.test'}});
  let output=''; api.stdout?.on('data',data=>{output+=String(data);});api.stderr?.on('data',data=>{output+=String(data);});
  const {createServer}=require('vite'),{chromium}=require('playwright');
  const web=await createServer({root:join(root,'apps/web'),configFile:join(root,'apps/web/vite.config.ts'),
    server:{host:'127.0.0.1',port:webPort,strictPort:true,proxy:Object.fromEntries(['/api','/community','/p'].map(path=>[path,`http://127.0.0.1:${apiPort}`]))}});
  let browser:any,page:any;
  try {
    for(let attempt=0;;attempt++) {
      if(api.exitCode!==null)throw new Error(output);
      try{if((await fetch(`http://127.0.0.1:${apiPort}/api/feedback/admin`)).status===401)break;}catch{}
      if(attempt>100)throw new Error(output||'API did not start');await new Promise(resolve=>setTimeout(resolve,100));
    }
    await web.listen();browser=await chromium.launch({headless:true,...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MLSWARM_TEST_BROWSER_EXECUTABLE}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    await context.route('**/*',(route:any)=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    page=await context.newPage();const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
    const url=`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=agents&filter=all`;
    await page.goto(url);
    await signInBrowser(page, await idTokenFor('icons@example.test'));
    const directoryView=page.locator('.k42-directory:visible'),sidebar=page.locator('.k42-my-agents');
    await directoryView.getByRole('img',{name:'Coding agent: Claude Code',exact:true}).waitFor();
    await directoryView.getByRole('img',{name:'Coding agent: Codex',exact:true}).waitFor();
    await sidebar.getByRole('img',{name:'Coding agent: Claude Code',exact:true}).waitFor();
    await sidebar.getByRole('img',{name:'Coding agent: Codex',exact:true}).waitFor();
    expect(await directoryView.locator('.k42-directory-card').filter({hasText:'Gamma unknown'}).locator('.k42-tool-badge').count()).toBe(0);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await directoryView.locator('.k42-directory-card').filter({hasText:'Alpha worker'}).scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({animations:'disabled',path:join(directory,`cards-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:1000});
    await directoryView.locator('.k42-directory-card').filter({hasText:'Alpha worker'}).click();
    const detail=page.locator('.agent-detail:visible');await detail.getByRole('heading',{name:'Alpha worker',exact:true}).waitFor();
    await detail.locator('.agent-side .k42-tool-label').getByText('Claude Code',{exact:true}).waitFor();
    expect(await detail.locator('.agent-profile-stats .k42-model-name').textContent()).toContain('gpt-synthetic-reroute');
    expect(await detail.locator('.agent-profile-photo .k42-tool-badge').getAttribute('aria-label')).toBe('Coding agent: Claude Code');
    expect(await detail.locator('.agent-profile-photo .k42-agent-status-icon').count()).toBe(1);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});await detail.locator('.agent-name-line').scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({animations:'disabled',path:join(directory,`detail-${width}.png`)});
    }
    expect(errors).toEqual([]);console.info(`Full-source card/detail/sidebar acceptance: ${directory}`);
  } catch(error) {if(page)await page.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(output.slice(-2000));throw error;}
  finally {if(browser)for(const context of browser.contexts())await context.unrouteAll({behavior:'wait'});await browser?.close();await web.close();api.kill('SIGTERM');await new Promise<void>(resolve=>{if(api.exitCode!==null)resolve();else api.once('exit',()=>resolve());});}
},120_000);
