import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, profiles, inProject, type Agent } from '../../apps/server/src/firestore.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const BLOCKER_PROJECT='9'.repeat(64);
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() {
  const server = portServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}

import { prepareCurrentStateProgress } from '../../apps/server/src/view/current-state-progress.js';
import { writeAgentGroup } from '../../apps/server/src/v2/agent-group.js';
test.each(['live','blockers','map'] as const)('actual app realtime acceptance: %s', async scenario => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-realtime-')), apiPort = await port(), webPort = await port();
  const fixture = await seed({ profiles: [{name:'Realtime reviewer',email:'realtime@example.test'}], agents: [{person:0,name:'Live worker'}] });
  await profiles.doc(fixture.personIds[0]).update({onboardingCompletedAt:100});
  const api = spawn(process.execPath, ['--import','tsx','apps/server/test/api-process.ts'], {cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOST:'127.0.0.1',PORT:String(apiPort),ADMIN_EMAILS:'admin@example.test'}});
  let output=''; api.stdout?.on('data',data=>{output+=String(data);});api.stderr?.on('data',data=>{output+=String(data);});
  const {createServer}=require('vite'),{chromium}=require('playwright');
  const web=await createServer({root:join(root,'apps/web'),configFile:join(root,'apps/web/vite.config.ts'),
    plugins:[{name:'realtime-hook-probe',resolveId(id:string){if(id==='/realtime-hook-probe.ts')return '\0realtime-hook-probe';},load(id:string){if(id==='\0realtime-hook-probe')return `
      import {createElement,useCallback} from 'react';import {createRoot} from 'react-dom/client';
      import {session,ProjectScope} from '/src/api.ts';import {useOpenRequests} from '/src/ui/NeedsYou.tsx';
      import {useChatHistory} from '/src/useChatHistory.ts';import {usePages} from '/src/shared.tsx';
      export function mount(){
      const host=document.createElement('div');document.body.append(host);const root=createRoot(host);window.__blockerRoot=root;
      function Probe(){
        const fetchPage=useCallback(async()=>{window.__historyReads=(window.__historyReads??0)+1;return {messages:[],next:null};},[]);
        useChatHistory(fetchPage,true,0,60000);usePages(session.currentUser(),()=>'/agents?view=labels&ids=${fixture.agents[0].agentId}',0,true);
        const state=useOpenRequests(session.currentUser(),${JSON.stringify(BLOCKER_PROJECT)},true);window.__blockerProbe={ready:state.ready,count:state.requests.length,error:state.error,old:state.requests.some(item=>item.id==='0000000000000000000000000000000000000000000000000000000000000000')};return null;}
      root.render(createElement(ProjectScope.Provider,{value:${JSON.stringify(TEST_PROJECT)}},createElement(Probe)));
      }
    `;}}],
    server:{host:'127.0.0.1',port:webPort,strictPort:true,proxy:Object.fromEntries(['/api','/community','/p'].map(path=>[path,`http://127.0.0.1:${apiPort}`]))}});
  let browser:any,page:any,releaseHeldFrame=()=>{};
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

    const failures:string[]=[];page.on('response',(response:any)=>{if(response.url().includes('/api/realtime')&&response.status()!==200)failures.push(String(response.status()));});
    const url=`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=conversations`;
    const subscribed=page.waitForResponse((response:any)=>response.url().includes('/api/realtime?project_id=')&&response.status()===200);
    await page.goto(url);
    await signInBrowser(page, await idTokenFor('realtime@example.test'));
    await page.getByRole('heading',{name:'Conversations',exact:true}).waitFor();
    await subscribed;
    const requestId='c'.repeat(64);
    const requestRecord={id:requestId,projectId:TEST_PROJECT,projectTitle:'Test game',agentId:fixture.agents[0].agentId,agentName:'Live worker',requesterProfileId:fixture.personIds[0],assigneeProfileId:fixture.personIds[0],visibility:'private',title:'A realtime blocker',question:'Which test option?',context:'Synthetic local acceptance.',attempted:'Synthetic check.',suggestedOptions:[],status:'open',revision:1,createdAt:Date.now(),updatedAt:Date.now(),answer:null,resolution:null};
    const writeMessage=async(id:string,body:string)=>db.doc(`projects/${TEST_PROJECT}/conversationEntries/${id}`).set({
      id,kind:'agent_message',agentId:fixture.agents[0].agentId,agentName:'Live worker',threadId:id,body,to:[],audience:'project',createdAt:Date.now(),protocol:2,
    });
    if(scenario==='blockers'){
    // The all-current blocker hook must retain 15 s reconciliation for old records
    // outside both watched open and answered windows, with no SSE event to rescue it.
    await inProject(BLOCKER_PROJECT,()=>seed());
    const member=(await db.doc(`projects/${TEST_PROJECT}/members/${fixture.personIds[0]}`).get()).data()!;
    await db.doc(`projects/${BLOCKER_PROJECT}/members/${fixture.personIds[0]}`).set({...member,projectId:BLOCKER_PROJECT});
    const old='0'.repeat(64),batch=db.batch();
    for(const status of ['open','answered'])for(let index=0;index<25;index++){
      const id=status==='open'&&index===0?old:(status==='open'?'1':'2')+String(index).padStart(63,'0');
      batch.set(db.doc(`humanRequests/${id}`),{...requestRecord,projectId:BLOCKER_PROJECT,id,status,createdAt:1000+index});
    }
    await batch.commit();
    let labelReads=0;page.on('request',(request:any)=>{if(request.url().includes('/agents?view=labels&ids='))labelReads++;});
    await page.evaluate(`import('/realtime-hook-probe.ts').then(module=>module.mount())`);
    await page.waitForFunction(()=>{const state=(window as any).__blockerProbe;return state?.ready&&state.count===25&&state.old;}).catch(async(error:unknown)=>{console.error('Probe state',JSON.stringify(await page.evaluate(()=>(window as any).__blockerProbe)),errors);throw error;});
    await page.waitForTimeout(6000);expect(await page.evaluate(()=>(window as any).__historyReads)).toBe(1);expect(labelReads).toBe(1);await db.doc(`humanRequests/${old}`).update({status:'answered',revision:2});
    await page.waitForFunction(()=>!(window as any).__blockerProbe.old,{},{timeout:20000});
    await page.evaluate(()=>{(window as any).__blockerRoot.unmount();});
      expect(failures).toEqual([]);expect(errors).toEqual([]);return;
    }
    if(scenario==='map'){
    // Keep a stale initial map frame in flight beyond the delayed notification.
    let releaseFrame!:()=>void, capturedFrame!:()=>void, frameReads=0;
    const captured=new Promise<void>(resolve=>{capturedFrame=resolve;}), released=new Promise<void>(resolve=>{releaseFrame=resolve;releaseHeldFrame=resolve;});
    await page.route('**/api/view/communication?range=recent',async(route:any)=>{
      frameReads++;
      if(frameReads===1){const response=await route.fetch();capturedFrame();await released;await route.fulfill({response});}
      else await route.continue();
    });
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=overview`);await Promise.race([captured,new Promise((_,reject)=>setTimeout(()=>reject(Error('Initial map frame was not captured.')),10000))]);
    await writeMessage('d'.repeat(64),'A message during a slow map read');
    await page.waitForTimeout(8000);
    const freshFrame=page.waitForResponse((response:any)=>response.url().endsWith('/api/view/communication?range=recent')&&frameReads>1);
    releaseFrame();await freshFrame;expect(frameReads).toBeGreaterThan(1);await page.unroute('**/api/view/communication?range=recent');
      expect(failures).toEqual([]);expect(errors).toEqual([]);return;
    }
    await writeMessage('a'.repeat(64),'A realtime conversation arrives');
    await page.getByText('A realtime conversation arrives',{exact:true}).first().waitFor({timeout:10000});
    await page.getByRole('button',{name:/A realtime conversation arrives/}).click();
    // Thread reads stop their former five-second timer once the live subscription is installed.
    await page.waitForTimeout(6500);
    let threadReads=0;page.on('request',(request:any)=>{if(new URL(request.url()).pathname.includes('/api/view/threads/'))threadReads++;});
    // The retained 30 s project refresh may land once; the former 5 s timer would read at least twice.
    await page.waitForTimeout(11000);expect(threadReads).toBeLessThanOrEqual(1);
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
    await writeMessage('b'.repeat(64),'Arrived while the tab was hidden');
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
    await page.getByText('Arrived while the tab was hidden',{exact:true}).first().waitFor({timeout:10000});
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=agents&filter=all`);
    const cards=page.locator('.k42-directory:visible');await cards.getByText('Live worker',{exact:true}).waitFor();
    await db.doc(`humanRequests/${requestId}`).set(requestRecord);
    await page.getByRole('button',{name:/Notifications.*1/}).waitFor({timeout:10000});
    await cards.getByText('Needs you',{exact:true}).waitFor({timeout:10000});
    await db.doc(`humanRequests/${requestId}`).update({status:'answered',revision:2});
    await cards.getByText('Unknown',{exact:true}).waitFor({timeout:10000});
    await db.runTransaction(async tx=>{
      const agentRef=db.doc(`projects/${TEST_PROJECT}/agents/${fixture.agents[0].agentId}`),statusRef=db.doc(`projects/${TEST_PROJECT}/presence/${fixture.agents[0].agentId}`);
      const prior=await tx.get(agentRef),progress=await prepareCurrentStateProgress(tx,[statusRef]);
      const after={...prior.data(),focus:{text:'Realtime focus changed',updatedAt:Date.now()}} as Agent;
      tx.update(agentRef,{focus:after.focus});writeAgentGroup(tx,statusRef,after,undefined,progress);
    });
    await cards.getByText('Realtime focus changed',{exact:false}).waitFor({timeout:10000});
    expect(failures).toEqual([]);expect(errors).toEqual([]);
    await page.screenshot({path:join(directory,'realtime-desktop.png')});
    await page.setViewportSize({width:390,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:join(directory,'realtime-mobile.png')});
    console.info(`Full local app realtime acceptance: ${directory}`);
  } catch(error) {if(page)await page.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(output.slice(-2000));throw error;}
  finally {releaseHeldFrame();if(browser)for(const context of browser.contexts())await context.unrouteAll({behavior:'wait'});await browser?.close();await web.close();api.kill('SIGTERM');await new Promise<void>(resolve=>{if(api.exitCode!==null)resolve();else api.once('exit',()=>resolve());});}
},120_000);
