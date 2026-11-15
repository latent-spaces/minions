import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as reservePort } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { disposableTarget } from '../support/disposable-session.mjs';
import { signInBrowser } from '../support/browser-session.js';
import { idTokenFor } from '../../apps/server/test/helpers.js';
import { seed, TEST_PROJECT } from '../../apps/server/test/helpers.js';
import { inProject, profiles } from '../../apps/server/src/firestore.js';
import { startRun } from '../../apps/server/src/v2/runs.js';
import { requestHuman, humanRequests, acknowledgeHumanAnswer, resolveHumanRequest } from '../../apps/server/src/projects/human-requests.js';

disposableTarget();
const folder = process.argv[2]; if (!folder) throw new Error('Use the disposable launcher.');
const root = fileURLToPath(new URL('../../', import.meta.url));
async function port() { const s = reservePort(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p; }
const apiPort = await port(), webPort = await port(), origin = `http://127.0.0.1:${webPort}`;
Object.assign(process.env, { KARMA_LOCAL_API_URL: `http://127.0.0.1:${apiPort}` });
const email='needs-you@example.test';
const f=await seed({profiles:[{name:'Operator · synthetic',email}],agents:[{person:0,name:'Scout · synthetic'}]});
await profiles.doc(f.personIds[0]).update({onboardingCompletedAt:Date.now()});
const scope=<T>(fn:()=>T)=>inProject(TEST_PROJECT,fn);
const run=await scope(()=>startRun(f.agents[0].agentId,{clientRunId:randomUUID(),runnerVersion:'synthetic',takeover:false},Date.now));
const options=['Use an image — fastest; chart stays static.','Switch libraries — more work; keeps editable charts.','Skip PDF export — continue with the web version.'];
const create=async(key:string,suggestions:string[]=options,selection_mode:'single'|'multiple'='single')=> (await scope(()=>requestHuman(f.agents[0].agentId,run.run_id,{dedupe_key:key,visibility:'private',title:`Synthetic blocker · ${key}`,context:'Required PDF export is blocked: the chart library cannot export it. Tried the documented export API; this library reports it is unsupported.',question:'How should I continue?',suggested_options:suggestions,selection_mode},Date.now))).request;
const multipleOptions=['Export CSV — preserve the source data.','Include a static chart — provide a visual summary.','Add a limitation note — explain the missing PDF.'];
const requests=await Promise.all([create('click'),create('note'),create('custom',[]),create('retry'),create('multiple',multipleOptions,'multiple')]);
let api: ReturnType<typeof spawn> | undefined, web: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors:string[]=[];
try {
 api=spawn(process.execPath,['--import','tsx','apps/server/test/api-process.ts'],{cwd:root,stdio:'inherit',env:{...process.env,HOST:'127.0.0.1',PORT:String(apiPort)}});
 for(let i=0;;i++){try{if((await fetch(`http://127.0.0.1:${apiPort}/api/needs-you`)).status===401)break;}catch{}if(i>100)throw new Error('API did not start');await new Promise(r=>setTimeout(r,100));}
 web=await createServer({root:join(root,'apps/web'),cacheDir:join(folder,'vite-cache'),configFile:join(root,'apps/web/vite.config.ts'),server:{host:'127.0.0.1',port:webPort,strictPort:true}});await web.listen();
 browser=await chromium.launch({headless:true,...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MINIONS_TEST_BROWSER_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15_000);
 await context.route('**/*',route=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${origin}/`);
 await signInBrowser(page,await idTokenFor(email));
 // Inside the project, open requests are pinned in Communication and counted beside it in the menu.
 await page.goto(`${origin}/?project=${encodeURIComponent(TEST_PROJECT)}&section=conversations`);
 const pinned=page.getByRole('region',{name:'Waiting for an answer',exact:true});
 await pinned.getByText(`Waiting for an answer · ${requests.length}`).waitFor();
 assert.equal(await pinned.locator('article.k42-needs-item[data-waiting=true]').count(),requests.length);
 await page.getByRole('link',{name:`Communication, ${requests.length} waiting for you`,exact:true}).waitFor();
 for(const [width,name] of [[1440,'desktop'],[390,'mobile']] as const){
  await page.setViewportSize({width,height:1800});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} Communication fits`);
  await pinned.screenshot({path:join(folder,`communication-pinned-${name}.png`)});
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(`${origin}/?view=needs-you`);
 const item=(key:string)=>page.locator(`article.k42-needs-item[aria-label$="· ${key}"]`);
 // No disclosures: the question, one paragraph and the choices are all visible at once.
 assert.equal(await page.locator('details').count(),0);
 await item('click').getByRole('heading',{name:'How should I continue?',exact:true}).waitFor();
 assert.equal(await item('click').locator('.k42-needs-detail').textContent(),'Required PDF export is blocked: the chart library cannot export it. Tried the documented export API; this library reports it is unsupported.');
 assert.equal(await item('click').getByRole('group',{name:'Choose one',exact:true}).getByRole('radio').count(),4);
 for(const [width,name] of [[1440,'desktop'],[390,'mobile']] as const){
  await page.setViewportSize({width,height:1800});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} fits`);
  assert.ok(await item('click').locator('.k42-needs-choice').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height>=44)),`${name} touch targets`);
  await item('click').screenshot({path:join(folder,`needs-you-${name}.png`)});
 }
 await item('click').getByRole('radio',{name:options[0],exact:true}).focus();await page.keyboard.press('Space');
 assert.equal((await humanRequests.doc(requests[0].id).get()).data()!.status,'open');
 await item('click').getByRole('button',{name:'Send answer',exact:true}).click();
 await item('click').getByText('You answered:',{exact:true}).waitFor();
 assert.equal((await humanRequests.doc(requests[0].id).get()).data()!.answer!.body,options[0]);
 assert.equal((await humanRequests.doc(requests[0].id).get()).data()!.status,'answered');
 // Typing into "Something else…" selects it; picking a choice afterwards replaces the draft (one answer).
 await item('note').getByRole('textbox',{name:'Write your own answer',exact:true}).fill('A draft to replace.');
 assert.equal(await item('note').getByRole('radio',{name:'Something else',exact:true}).isChecked(),true);
 assert.equal(await item('note').getByRole('button',{name:'Send answer',exact:true}).isDisabled(),false);
 await item('note').getByRole('radio',{name:options[0],exact:true}).check();
 assert.equal(await item('note').getByRole('radio').evaluateAll(nodes=>nodes.filter(n=>(n as HTMLInputElement).checked).length),1);
 assert.equal(await item('note').getByRole('textbox',{name:'Write your own answer',exact:true}).inputValue(),'');
 await item('note').getByRole('textbox',{name:'Write your own answer',exact:true}).click();
 assert.equal(await item('note').getByRole('radio',{name:'Something else',exact:true}).isChecked(),true);
 assert.equal(await item('note').getByRole('button',{name:'Send answer',exact:true}).isDisabled(),true);
 await item('note').getByRole('textbox',{name:'Write your own answer',exact:true}).fill('Keep the approved library.');
 await item('note').getByRole('button',{name:'Send answer',exact:true}).click();
 await item('note').getByText('You answered:',{exact:true}).waitFor();
 assert.equal((await humanRequests.doc(requests[1].id).get()).data()!.answer!.body,'Keep the approved library.');
 assert.equal(await item('custom').getByRole('radio').count(),0);
 await item('custom').getByRole('textbox',{name:'Your answer',exact:true}).fill('Use the approved CSV export instead.');await item('custom').getByRole('button',{name:'Send answer',exact:true}).click();
 await item('custom').getByText('You answered:',{exact:true}).waitFor();
 assert.equal((await humanRequests.doc(requests[2].id).get()).data()!.answer!.body,'Use the approved CSV export instead.');
 // Lose the response after the real server accepted it. The saved retry must be identical.
 const sent:string[]=[];let lose=true;
 await page.route(`**/api/needs-you/${requests[3].id}/answer`,async route=>{sent.push(route.request().postData()!);const response=await route.fetch();if(lose){lose=false;await route.abort('failed');}else await route.fulfill({response});});
 await item('retry').getByRole('radio',{name:options[1],exact:true}).check();
 await item('retry').getByRole('button',{name:'Send answer',exact:true}).click();
 await item('retry').getByRole('button',{name:'Retry saved response',exact:true}).waitFor();
 assert.equal(await item('retry').getByRole('radio').evaluateAll(nodes=>nodes.every(n=>(n as HTMLInputElement).matches(':disabled'))),true);
 await item('retry').getByRole('button',{name:'Retry saved response',exact:true}).click();
 await item('retry').getByText('You answered:',{exact:true}).waitFor();assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);
 await item('multiple').getByRole('checkbox',{name:multipleOptions[0],exact:true}).check();
 await item('multiple').getByRole('checkbox',{name:multipleOptions[2],exact:true}).check();
 await item('multiple').getByRole('textbox',{name:'Write your own answer',exact:true}).click();
 assert.equal(await item('multiple').getByRole('checkbox',{name:'Something else',exact:true}).isChecked(),true);
 assert.equal(await item('multiple').getByRole('button',{name:'Send answer',exact:true}).isDisabled(),true);
 await item('multiple').getByRole('textbox',{name:'Write your own answer',exact:true}).fill('Also attach the export instructions.');
 for(const [width,name] of [[1440,'desktop'],[390,'mobile']] as const){
  await page.setViewportSize({width,height:1800});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await item('multiple').screenshot({path:join(folder,`needs-you-multiple-${name}.png`)});
 }
 await item('multiple').getByRole('button',{name:'Send answer',exact:true}).click();
 await item('multiple').getByText('You answered:',{exact:true}).waitFor();
 assert.deepEqual((await humanRequests.doc(requests[4].id).get()).data()!.answer!.optionIndices,[0,2]);
 assert.equal((await humanRequests.doc(requests[4].id).get()).data()!.answer!.customAnswer,'Also attach the export instructions.');
 // A read is not an acknowledgment. Only the explicit agent mutation advances this receipt.
 await page.getByRole('button',{name:'Answered',exact:true}).click();
 await item('click').getByText('Awaiting acknowledgment',{exact:true}).waitFor();
 await scope(()=>acknowledgeHumanAnswer(f.agents[0].agentId,run.run_id,{request_id:requests[0].id,expected_revision:2,client_request_id:'acknowledged'},Date.now));
 await page.reload();
 await page.getByRole('button',{name:'Answered',exact:true}).click();
 await item('click').getByText('Agent acknowledged',{exact:true}).waitFor();
 assert.equal((await humanRequests.doc(requests[0].id).get()).data()!.status,'answered');
 for(const [width,name] of [[1440,'desktop'],[390,'mobile']] as const){
  await page.setViewportSize({width,height:1800});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await item('click').screenshot({path:join(folder,`needs-you-acknowledged-${name}.png`)});
 }
 await scope(()=>resolveHumanRequest(f.agents[0].agentId,run.run_id,{request_id:requests[0].id,expected_revision:3,client_request_id:'resolved',summary:'Recovered PDF export using a static chart.'},Date.now));
 await page.getByRole('button',{name:'Resolved',exact:true}).click();await item('click').getByText('Resolved by Scout · synthetic:',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Open',exact:true}).click();await page.getByRole('heading',{name:'Nothing waiting here',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 await writeFile(join(folder,'needs-you-results.json'),JSON.stringify({checks:['real app auth/API','pinned in Communication with menu count','desktop/mobile fit','no disclosures, one paragraph','keyboard selects before explicit send','single choice','something else replaces a choice','multiple choices with custom answer','custom answer','lost response exact retry','saved before explicit acknowledgment','explicit acknowledgment stays Answered','answered before agent resolution','resolved/empty filters'],models:0,errors},null,2));
 console.info(`Needs you application checks passed. Evidence: ${folder}`);
} finally {
 await browser?.close();await web?.close();
 if(api&&api.exitCode===null){const child=api,done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),6000);await done;clearTimeout(timer);}
}
