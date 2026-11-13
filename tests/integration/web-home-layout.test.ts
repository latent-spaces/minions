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
const root = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() { const s = portServer(); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve)); const value = (s.address() as { port: number }).port; await new Promise<void>(resolve => s.close(() => resolve())); return value; }

// Tasks is the project's first tab: it keeps the communication map and the cheat sheet; Updates is the side panel.
test('actual project Tasks keeps the communication map and cheat sheet and fits desktop and phone widths', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-home-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({project:{name:'Synthetic Home feed',startsAt:Date.now()-60000},profiles:[{name:'Demo author',email:'author@example.test'}],agents:[{person:0,name:'Demo Fox'},{person:0,name:'Demo Owl'}]});
  await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:100});
  const api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), ADMIN_EMAILS: 'admin@example.test' } });
  let apiOutput = ''; api.stdout?.on('data', data => { apiOutput += String(data); }); api.stderr?.on('data', data => { apiOutput += String(data); });
  const { createServer } = require('vite'), { chromium } = require('playwright');
  const web = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}`, '/community': `http://127.0.0.1:${apiPort}`, '/p': `http://127.0.0.1:${apiPort}` } } });
  let browser: any, diagnostic: any;
  try {
    for (let n = 0; ; n++) {
      if (api.exitCode !== null) throw new Error(apiOutput);
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/needs-you`)).status === 401) break; } catch {}
      if (n > 100) throw new Error(apiOutput || 'API did not start'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    await web.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route('**/*',(route:any)=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    const page=await context.newPage(); diagnostic=page;
    const errors:string[]=[];let eventReads=0, updateReads=0;page.on('pageerror',(e:Error)=>errors.push(e.message));page.on('request',(request:any)=>{if(request.url().includes('/communication/events'))eventReads++;if(new URL(request.url()).pathname===`/api/project-progress/${TEST_PROJECT}` && request.method()==='GET')updateReads++;});
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}`);
    await signInBrowser(page, await idTokenFor('author@example.test'));
    const tabs=page.getByRole('navigation',{name:'Project sections',exact:true});
    await tabs.getByRole('link',{name:'Tasks',exact:true}).waitFor();
    await page.getByRole('button',{name:/Select agent Demo Fox/}).waitFor();
    // Updates is the full-height side panel, not a tab.
    expect(await tabs.getByRole('link',{name:'Updates',exact:true}).count()).toBe(0);
    expect(await page.getByRole('heading',{name:'Project updates',exact:true}).count()).toBe(1);
    expect(await page.locator('.k42-communication-spotlight').count()).toBe(0);
    expect(await page.locator('.k42-communication-timeline').count()).toBe(0);
    await page.getByRole('button',{name:'Cheat sheet',exact:true}).click();
    const sheet=page.getByRole('dialog',{name:'Cheat sheet',exact:true});await sheet.waitFor();
    const prompt='Preview my MyLittleSwarm project "Synthetic Home feed" locally, automatically pulling the latest code and refreshing the preview.';
    await sheet.getByText(prompt,{exact:true}).waitFor();
    await page.evaluate(() => { (window as any).__copied=''; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as any).__copied=text;}}}); });
    await sheet.getByRole('button',{name:'Copy prompt: Preview on my computer',exact:true}).click();
    await sheet.getByRole('button',{name:'Copied',exact:true}).waitFor();expect(await page.evaluate(()=>(window as any).__copied)).toBe(prompt);
    await sheet.getByRole('button',{name:'Close',exact:true}).click();
    const graph=await page.locator('.communication-map').boundingBox();
    expect(graph.height).toBeGreaterThanOrEqual(500);
    expect(await page.getByRole('form',{name:'Steer your agents',exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'Full screen',exact:true}).click();
    await page.locator('.k42-communication.is-expanded').waitFor();
    expect(await page.locator('.k42-communication.is-expanded').getByRole('heading',{name:'Project updates',exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'Exit full screen',exact:true}).click();await page.locator('.k42-communication.is-expanded').waitFor({state:'detached'});
    for (const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      if (name === 'mobile') { await page.reload(); await tabs.getByRole('link',{name:'Tasks',exact:true}).waitFor(); }
      expect(await tabs.getByRole('link',{name:'Tasks',exact:true}).getAttribute('aria-current')).toBe('page');
      await page.locator('.communication-map').scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({animations:'disabled',path:join(directory,`graph-${name}.png`)});
    }
    expect(await tabs.getByRole('link',{name:'Community',exact:true}).count()).toBe(0);
    expect(await tabs.getByRole('link',{name:'Needs you',exact:true}).count()).toBe(0);
    expect(await page.locator('.k42-ph-created').count()).toBe(0); // The synthetic project's owner has no profile; its member is not the creator.
    for (const width of [1440, 390]) {
      await page.setViewportSize({width,height:1000});
      await page.locator('.k42-ph').scrollIntoViewIfNeeded();
      await page.screenshot({animations:'disabled',path:join(directory,`header-${width}.png`)});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await page.goto(`http://127.0.0.1:${webPort}/?view=projects`);
    const filters=page.getByRole('group',{name:'Filter my projects',exact:true});
    await filters.waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({width,height:1000});
      await filters.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({animations:'disabled',path:join(directory,`projects-${width}.png`)});
    }
    expect(eventReads).toBe(0); // The Updates panel reads project updates; the map reads no event feed.
    expect(updateReads).toBeGreaterThan(0);expect(errors).toEqual([]);
    console.info(`Verified actual Tasks at desktop/mobile without event reads, cheat sheet, fullscreen and My projects: ${directory}`);
  } catch (e) { if (diagnostic) { await diagnostic.screenshot({ animations: 'disabled', path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await diagnostic.locator('body').innerText().catch(() => 'No UI'), apiOutput.slice(-1500)); } throw e; }
  finally { if (browser) for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'wait' }); await browser?.close(); await web.close(); api.kill('SIGTERM'); await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); }); }
}, 120_000);
