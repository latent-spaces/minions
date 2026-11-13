import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profiles } from '../../apps/server/src/firestore.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() {
  const server = portServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}

test('Map defaults and unseen updates survive reloads but clear only when visible', async()=>{
  await resetEmulator();
  const directory=await mkdtemp(join(tmpdir(),'mlswarm-panel-')),apiPort=await port(),webPort=await port();
  const fixture=await seed({profiles:[{name:'Panel reviewer',email:'panel@example.test',role:'owner'}],agents:[{person:0,name:'Alpha worker'}]});
  await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:100});
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
    await context.route('**/*',(route:any)=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    // Synthetic published posts exercise the real app/feed without running models.
    const post=(id:number)=>({id:`post-${id}`,projectId:TEST_PROJECT,kind:'authored_update',publishedAt:1000+id,
      title:`Review update ${id}`,body:'Synthetic progress for the panel review.',
      author:{agent:{id:fixture.agents[0].agentId,name:'Alpha worker'},profile:{id:fixture.personIds[0],name:'Icon reviewer'}},links:[],screenshot:null,slides:[]});
    let posts=[post(2),post(1)];
    await context.route(`**/api/project-progress/${TEST_PROJECT}*`,(route:any)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:posts,next:null,observedAt:Date.now(),source:'authored_updates',audience:'member',coverage:'published_updates'})}));
    page=await context.newPage();page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(msg:any)=>{if(msg.type()==='error')diagnostics.push(msg.text());});page.on('requestfailed',(req:any)=>diagnostics.push(req.url()+': '+req.failure()?.errorText));
    const url=`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=agents`;
    await page.goto(url);
    await signInBrowser(page, await idTokenFor('panel@example.test'));
    const panel=page.getByRole('complementary',{name:'Project updates and map'});
    const mapTab=panel.getByRole('button',{name:'Map',exact:true});
    const updatesTab=panel.getByRole('button',{name:/^Updates/});
    expect(await mapTab.getAttribute('aria-pressed')).toBe('true');
    await updatesTab.getByLabel('2 unseen updates').waitFor();
    await panel.locator('.communication-map').waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({path:join(directory,'map-default-unseen-desktop.png')});
    await updatesTab.click();
    await panel.getByRole('article',{name:'Review update 2',exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.k42-panel-switch .k42-updates-count'));
    await mapTab.click();
    posts=[post(3),...posts];
    // The app's normal return-to-window refresh discovers posts without opening Updates.
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await updatesTab.getByLabel('1 unseen updates').waitFor({timeout:20000});
    await page.reload();
    await updatesTab.getByLabel('1 unseen updates').waitFor();
    expect(await mapTab.getAttribute('aria-pressed')).toBe('true');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:/^Map/}).filter({has:page.locator('.k42-updates-count')}).click();
    await updatesTab.getByLabel('1 unseen updates').waitFor();
    await page.waitForTimeout(700);
    await page.screenshot({path:join(directory,'map-default-unseen-mobile.png')});
    await updatesTab.click();
    await page.waitForFunction(()=>!document.querySelector('.k42-panel-switch .k42-updates-count'));
    await page.getByRole('button',{name:'Close updates',exact:true}).click();
    posts=[post(4),...posts];
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.locator('.k42-updates-toggle').getByLabel('1 unseen updates').waitFor({timeout:20000});
    await page.waitForTimeout(200);
    expect(await page.locator('.k42-updates-toggle .k42-updates-count').textContent()).toBe('1');
    await page.locator('.k42-updates-toggle').click();
    await page.waitForFunction(()=>!document.querySelector('.k42-panel-switch .k42-updates-count'));
    await page.getByRole('button',{name:'Close updates',exact:true}).click();
    await page.setViewportSize({width:1440,height:1000});
    await mapTab.click();
    expect(errors).toEqual([]);
    console.log('Panel review screenshots:',directory);
  } catch(error) {if(page)await page.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(output.slice(-2000),errors,diagnostics,await page?.url());throw error;}
  finally {if(browser)for(const context of browser.contexts())await context.unrouteAll({behavior:'wait'});await browser?.close();await web.close();api.kill('SIGTERM');await new Promise<void>(resolve=>{if(api.exitCode!==null)resolve();else api.once('exit',()=>resolve());});}
},120_000);
