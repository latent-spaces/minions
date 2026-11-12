import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSONA_OPTIONS } from '@mlswarm/contracts';
import { startRun, reportPhase } from '../../apps/server/src/v2/runs.js';
import { randomUUID } from 'node:crypto';
import { db, profiles, inProject } from '../../apps/server/src/firestore.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor, loadAgent } from '../../apps/server/test/helpers.js';
import { sendMessageV2 } from '../../apps/server/src/v2/messages.js';
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
  const fixture = await seed({ profiles: [{name:'Icon reviewer',email:'icons@example.test',role:'owner'}], agents: [
    {person:0,name:'Alpha worker'}, {person:0,name:'Beta worker'}, {person:0,name:'Gamma unknown'},
  ] });
  await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:100});
  const pipeBody='A recent handoff is ready for review. '+ 'Additional detail stays in the conversation. '.repeat(8);
  const pipeMessage=await inProject(TEST_PROJECT,async()=>sendMessageV2(await loadAgent(fixture.agents[0].agentId),
    {to:[fixture.agents[1].agentId],body:pipeBody,clientId:'pipe-preview'},()=>Date.now()-60_000));
  for (const [index, provider, model] of [[0,'claude','gpt-synthetic-reroute'],[1,'codex','claude-synthetic-reroute'],[2,'unknown','claude-no-tool-report']] as const) {
    await db.doc(`projects/${TEST_PROJECT}/runnerUsage/${fixture.agents[index].agentId}`).set({
      runId:'synthetic-no-model',provider,model,firstReportedAt:Date.now(),lastReportedAt:Date.now(),turns:0,seconds:0,
      input:0,output:0,cacheRead:0,cacheWrite:0,modelCalls:0,costUsd:0,costReports:0,tokenReports:0,
      tokenCoverage:{input:0,output:0,cacheRead:0,cacheWrite:0},inputSemantics:'uncached',
    });
  }
  await db.doc(`projects/${TEST_PROJECT}/agents/${fixture.agents[1].agentId}`).update({persona:{text:PERSONA_OPTIONS.find(p=>p.id==='build')!.text}});
  const run = await inProject(TEST_PROJECT,()=>startRun(fixture.agents[0].agentId,{clientRunId:randomUUID(),runnerVersion:'synthetic-no-model',takeover:false},Date.now));
  await inProject(TEST_PROJECT,()=>reportPhase(fixture.agents[0].agentId,run.run_id,{phase:'turn'},Date.now));
  const api = spawn(process.execPath, ['--import','tsx','apps/server/test/api-process.ts'], {cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOST:'127.0.0.1',PORT:String(apiPort),ADMIN_EMAILS:'admin@example.test'}});
  let output=''; api.stdout?.on('data',data=>{output+=String(data);});api.stderr?.on('data',data=>{output+=String(data);});
  const {createServer}=require('vite'),{chromium}=require('playwright');
  const web=await createServer({root:join(root,'apps/web'),configFile:join(root,'apps/web/vite.config.ts'),
    server:{host:'127.0.0.1',port:webPort,strictPort:true,proxy:Object.fromEntries(['/api','/community','/p','/s'].map(path=>[`^${path}(?:/|$)`,`http://127.0.0.1:${apiPort}`]))}});
  let browser:any,page:any; const errors:string[]=[], diagnostics:string[]=[];
  try {
    for(let attempt=0;;attempt++) {
      if(api.exitCode!==null)throw new Error(output);
      try{if((await fetch(`http://127.0.0.1:${apiPort}/api/needs-you`)).status===401)break;}catch{}
      if(attempt>100)throw new Error(output||'API did not start');await new Promise(resolve=>setTimeout(resolve,100));
    }
    await web.listen();browser=await chromium.launch({headless:true,...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MLSWARM_TEST_BROWSER_EXECUTABLE}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    // Advance presentation time only; server freshness and real model state stay untouched.
    await context.addInitScript(() => {
      const testWindow = window as Window & { avatarReviewOffset: number };
      testWindow.avatarReviewOffset = 0;
      const now = performance.now.bind(performance), raf = requestAnimationFrame.bind(window);
      performance.now = () => now() + testWindow.avatarReviewOffset;
      window.requestAnimationFrame = callback => raf(time => callback(time + testWindow.avatarReviewOffset));
    });
    await context.route('**/*',(route:any)=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    page=await context.newPage();page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(msg:any)=>{if(msg.type()==='error')diagnostics.push(msg.text());});page.on('requestfailed',(req:any)=>diagnostics.push(req.url()+': '+req.failure()?.errorText));
    const url=`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=agents`;
    await page.goto(url);
    await signInBrowser(page, await idTokenFor('icons@example.test'));
    const directoryView=page.locator('.k42-directory:visible'),sidebar=page.locator('.k42-my-agents');
    await directoryView.getByRole('img',{name:'Coding agent: Claude Code',exact:true}).waitFor();
    await directoryView.getByRole('img',{name:'Coding agent: Codex',exact:true}).waitFor();
    await sidebar.getByRole('img',{name:'Coding agent: Claude Code',exact:true}).waitFor();
    await sidebar.getByRole('img',{name:'Coding agent: Codex',exact:true}).waitFor();
    expect(await directoryView.locator('.k42-directory-card').filter({hasText:'Alpha worker'}).locator('[data-character]').getAttribute('data-character')).toMatch(/^(cat|dog|fox|raccoon|bear|panda|rabbit|owl|koala|frog|red-panda|tiger)$/);
    expect(await directoryView.locator('.k42-directory-card').filter({hasText:'Beta worker'}).locator('[data-character]').getAttribute('data-character')).toMatch(/^(cat|dog|fox|raccoon|bear|panda|rabbit|owl|koala|frog|red-panda|tiger)$/);
    expect(await directoryView.locator('.k42-directory-card').filter({hasText:'Gamma unknown'}).locator('[data-character]').count()).toBe(1);
    expect(await directoryView.locator('.k42-directory-card').filter({hasText:'Alpha worker'}).locator('.k42-agent-hat').count()).toBe(0);
    expect(await directoryView.locator('.k42-directory-card').filter({hasText:'Beta worker'}).locator('.k42-agent-hat').count()).toBe(1);
    expect(await directoryView.locator('.k42-directory-card').filter({hasText:'Gamma unknown'}).locator('.k42-tool-badge').count()).toBe(0);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await directoryView.locator('.k42-directory-card').filter({hasText:'Alpha worker'}).scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({animations:'disabled',path:join(directory,`cards-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await directoryView.locator('.k42-directory-card').filter({hasText:'Alpha worker'}).scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('.k42-directory-card [data-character-avatar]')?.getAttribute('data-motion')==='work-loop');
    // A transparent animation must replace the still, never composite over it.
    await page.waitForFunction(()=>{
      const avatar=document.querySelector('.k42-directory-card [data-character-avatar]');
      const neutral=avatar?.querySelector('.k42-character-neutral'),strip=avatar?.querySelector('.k42-character-strip');
      return neutral&&strip&&getComputedStyle(neutral).visibility==='hidden'&&getComputedStyle(strip).opacity==='1';
    });
    await page.screenshot({path:join(directory,'writing.png')});
    await page.mouse.move(1400, 500);
    await page.waitForTimeout(120);
    await page.evaluate(() => { (window as Window & { avatarReviewOffset: number }).avatarReviewOffset += 300_000; });
    const rare=page.locator('[data-motion="rare"]');
    await page.waitForFunction(() => document.querySelector('[data-motion="rare"]')?.getAttribute('data-frame') === '4');
    expect(await rare.count()).toBe(1);
    expect(await rare.locator('.k42-character-rare img').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth===2304)).toBe(true);
    expect(await rare.locator('.k42-character-neutral').evaluate((image:HTMLImageElement)=>getComputedStyle(image).opacity)).toBe('0');
    await page.screenshot({path:join(directory,'rare-native.png')});
    const gaze=page.locator('[data-motion="gaze"]').first();
    await gaze.waitFor();
    const before=await gaze.boundingBox();
    const pupils=gaze.locator('.k42-character-gaze img').last();
    expect(await gaze.locator('.k42-character-neutral').evaluate((image:HTMLImageElement)=>getComputedStyle(image).visibility)).toBe('hidden');
    expect(await gaze.locator('.k42-character-stage > .k42-character-strip').evaluate((image:HTMLImageElement)=>getComputedStyle(image).opacity)).toBe('0');
    expect(await gaze.locator('.k42-character-rare').evaluate((layer:HTMLElement)=>getComputedStyle(layer).opacity)).toBe('0');
    // A moving CSS transform is insufficient if the extracted sprite is empty.
    expect(await pupils.evaluate((image:HTMLImageElement)=>{
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      let visible=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)visible++;
      return visible;
    })).toBeGreaterThan(5);
    const offset=()=>pupils.evaluate((image:HTMLImageElement)=>new DOMMatrix(getComputedStyle(image).transform).m41);
    await page.waitForTimeout(150);
    expect(await offset()).toBeGreaterThan(0);
    await page.mouse.move(1,500);
    await page.waitForTimeout(200);
    expect(await offset()).toBeLessThan(0);
    expect(await gaze.boundingBox()).toEqual(before);
    await page.screenshot({path:join(directory,'cursor-gaze.png')});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>!document.querySelector('[data-motion="rare"], [data-motion="gaze"]'));
    await page.screenshot({path:join(directory,'ambient-reduced-motion.png')});
    await directoryView.locator('.k42-directory-card').filter({hasText:'Alpha worker'}).click();
    const detail=page.locator('.agent-detail:visible');await detail.getByRole('heading',{name:'Alpha worker',exact:true}).waitFor();
    await detail.locator('.agent-meta .k42-tool-label').getByText('Claude Code',{exact:true}).waitFor();
    expect(await detail.locator('.agent-meta .k42-model-name').textContent()).toContain('gpt-synthetic-reroute');
    expect(await detail.locator('.agent-profile-photo .k42-tool-badge').getAttribute('aria-label')).toBe('Coding agent: Claude Code');
    expect(await detail.locator('.agent-profile-photo .k42-agent-status-icon').count()).toBe(1);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});await detail.locator('.agent-name-line').scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({animations:'disabled',path:join(directory,`detail-${width}.png`)});
    }
    const settingsUrl=`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=control-center`;
    const settingsRoute='**/project-update-settings';
    await context.route(settingsRoute,(route:any)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({revision:1,additionalInstructions:''})}));
    await page.goto(settingsUrl);
    await page.getByRole('alert').filter({hasText:'unsupported update-settings format'}).waitFor();
    await page.getByRole('group',{name:'Choose my character'}).waitFor();
    await context.unroute(settingsRoute);
    await page.reload();
    const choices=page.getByRole('group',{name:'Choose my character'});
    await choices.getByRole('button',{name:'Character 4',exact:true}).click();
    await page.getByRole('button',{name:'Save character',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.my-character-save button')?.hasAttribute('disabled'));
    expect((await profiles.doc(fixture.personIds[0]).get()).data()?.character).toBe('person-04');
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('button[aria-label="Character 4"]')?.getAttribute('aria-pressed')==='true');
    expect(await page.locator('#settings-project-title').count()).toBe(0);
    await page.screenshot({path:join(directory,'settings.png'),fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:join(directory,'settings-desktop.png'),fullPage:true,animations:'disabled'});
    // A minute-old real message still has a pipe; its preview uses the existing authorized message reader.
    await page.goto(url);
    await page.getByRole('button',{name:'Map',exact:true}).click();
    const pipe=page.getByRole('button',{name:'Show messages from Alpha worker to Beta worker',exact:true});
    await pipe.waitFor();await pipe.focus();
    const pipePreview=page.getByRole('dialog',{name:'Alpha worker → Beta worker',exact:true});await pipePreview.waitFor();
    await pipePreview.getByText('A recent handoff is ready for review.',{exact:false}).waitFor();
    expect(Array.from((await pipePreview.locator('.k42-connection-excerpt').textContent())!).length).toBeLessThanOrEqual(161);
    await page.screenshot({path:join(directory,'real-message-pipe-preview.png')});
    await pipePreview.getByRole('link',{name:'Open conversation →'}).click();
    await page.waitForFunction((id:string)=>new URL(location.href).searchParams.get('message')===id,pipeMessage.message.id);
    expect(new URL(page.url()).searchParams.get('thread')).toBe(pipeMessage.message.id);
    // Failed strips keep the consent-free bundled still visible as a fallback.
    await page.emulateMedia({reducedMotion:'no-preference'});
    await context.route('**/sprites/*.webp*',(route:any)=>route.request().resourceType()==='image'?route.abort():route.continue());
    await page.goto(url);
    await page.waitForFunction(()=>{
      const avatar=document.querySelector('.k42-directory-card [data-character-avatar]');
      const neutral=avatar?.querySelector<HTMLImageElement>('.k42-character-neutral'),strip=avatar?.querySelector('.k42-character-strip');
      return avatar?.getAttribute('data-motion')==='work-loop'&&neutral?.complete&&neutral.naturalWidth>0&&getComputedStyle(neutral).visibility==='visible'&&strip&&getComputedStyle(strip).opacity==='0';
    });
    await page.screenshot({path:join(directory,'animation-fallback.png')});
    expect(errors).toEqual([]);console.info(`Full-source card/detail/sidebar/settings acceptance: ${directory}`);
  } catch(error) {if(page)await page.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(output.slice(-2000),errors,diagnostics,await page?.url());throw error;}
  finally {if(browser)for(const context of browser.contexts())await context.unrouteAll({behavior:'wait'});await browser?.close();await web.close();api.kill('SIGTERM');await new Promise<void>(resolve=>{if(api.exitCode!==null)resolve();else api.once('exit',()=>resolve());});}
},120_000);
