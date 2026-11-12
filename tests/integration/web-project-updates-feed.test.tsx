import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

let vite: any, chromium: any, origin: string;
beforeAll(async()=>{
  const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
  const {createServer}=require('vite');({chromium}=require(process.env.MLSWARM_TEST_PLAYWRIGHT??'playwright'));
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
  <main style="max-width:900px;margin:24px auto;padding:16px"><p>Synthetic project updates · no running models</p><div id="root"></div></main>
  <script type="module">
  import React,{useState} from 'react';import{createRoot}from'react-dom/client';
  import{ProjectUpdates}from'/src/ui/ProjectProgress.tsx';import'/src/styles.css';
  const projectId='demo-project',at=Date.now();
  const update=n=>({id:String(n),kind:'authored_update',projectId,publishedAt:at-(10-n)*60000,
    title:'Map update '+n,body:new URLSearchParams(location.search).has('previews')?'🌱'.repeat(n===3?151:150):'Synthetic preview: neighbors can find shared resources on the map. This is illustrative progress for testing the scrolling feed.',
    author:{agent:{id:'demo-fox',name:'Demo Fox'},profile:{id:'demo-human',name:'Demo participant'}},links:[],screenshot:n===3?{id:'visual',contentPath:'/synthetic',mimeType:'image/png',width:480,height:600,alt:'Synthetic garden progress',caption:'Synthetic example, not deployed',representation:'concept_image'}:null,
    slides:n===3?['visual','second','third'].map((id,i)=>({id,contentPath:'/synthetic',mimeType:'image/png',width:480,height:600,alt:'Synthetic slide '+(i+1),caption:i?'Slide caption '+(i+1):'Synthetic example, not deployed',representation:'concept_image'})):[]});
  const initial={items:[update(3),update(2)],next:'earlier',observedAt:at,source:'authored_updates',audience:'member',coverage:'published_updates'};
  function Harness(){
    const [page,setPage]=useState(initial);
    const [pending,setPending]=useState(0),[mounted,setMounted]=useState(true);
    window.arrive=()=>setPage(p=>({...p,items:[update(5),update(4),...p.items]}));
    window.removeFeed=()=>setMounted(false);
    const appendEarlier=()=>{const next={...initial,items:[update(1)],next:null};setPage(p=>({...p,items:[...p.items,update(1)],next:null}));return next;};
    const loadEarlier=async()=>appendEarlier();
    return React.createElement(React.Fragment,null,
      React.createElement('output',{'aria-label':'Pending updates'},pending),
      mounted&&React.createElement(ProjectUpdates,{projectId,page,onPendingChange:setPending,active:true,loading:false,error:null,loadEarlier,
        go:()=>{},resolveScreenshot:async()=>new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="480" height="600"><rect width="480" height="600" fill="#e7edce"/><text x="30" y="80" font-size="36">A small garden.</text></svg>'],{type:'image/svg+xml'})}));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  vite=await createServer({root:fileURLToPath(new URL('../../apps/web',import.meta.url)),configFile:false,
    server:{host:'127.0.0.1',port:0,fs:{allow:[fileURLToPath(new URL('../../',import.meta.url))]}},
    plugins:[{name:'updates-feed-fixture',configureServer(server:any){server.middlewares.use('/__updates.html',(_req:any,res:any)=>{
      void server.transformIndexHtml('/__updates.html',html).then((value:string)=>{res.setHeader('content-type','text/html');res.end(value);});
    });}}]});
  await vite.listen();origin=`http://127.0.0.1:${vite.httpServer.address().port}/__updates.html`;
},30000);
afterAll(async()=>{await vite?.close();});
// Each page gets its own browser. Single-process Chromium ends when a page's context closes and can't host a second
// context, so one shared browser can't give every case a fresh context.
const openPage=async(viewport:{width:number;height:number})=>{
  const browser=await chromium.launch({headless:true,...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.MLSWARM_TEST_BROWSER_EXECUTABLE}:{})});
  try { return await browser.newPage({viewport}); } catch (error) { await browser.close(); throw error; }
};
const closePage=(page:any)=>page.context().browser().close();
test('the pending count matches new arrivals and clears after reading and on unmount', async () => {
  const p = await openPage({ width: 390, height: 400 });
  try {
    await p.goto(origin);
    await p.getByRole('heading', { name: 'Map update 3', exact: true }).waitFor();
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(150); // Deliver the top sentinel's IntersectionObserver notification.
    await p.evaluate('window.arrive()');
    await p.getByRole('button', { name: '2 new updates', exact: true }).waitFor();
    await p.waitForFunction(() => document.querySelector('output')?.textContent === '2');
    await p.getByRole('button', { name: '2 new updates', exact: true }).click();
    await p.waitForFunction(() => document.querySelector('output')?.textContent === '0');
    // Unmounting must also clear the parent indicator.
    await p.goto(origin);
    await p.getByRole('heading', { name: 'Map update 3', exact: true }).waitFor();
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(150);
    await p.evaluate('window.arrive()');
    await p.waitForFunction(() => document.querySelector('output')?.textContent === '2');
    await p.evaluate('window.removeFeed()');
    await p.waitForFunction(() => document.querySelector('output')?.textContent === '0');
  } finally { await closePage(p); }
}, 30000);

test('150-character previews expand independently with keyboard controls on desktop and phone', async () => {
  for (const width of [1440, 390]) {
    const p = await openPage({ width, height: 844 });
    try {
      await p.goto(origin + '?previews=1');
      const long = p.getByRole('article', { name: 'Map update 3', exact: true });
      const short = p.getByRole('article', { name: 'Map update 2', exact: true });
      const toggle = long.locator('.k42-progress-body-toggle');
      expect(await long.locator('.k42-progress-body').textContent()).toBe('🌱'.repeat(150) + '…');
      expect(await short.locator('.k42-progress-body').textContent()).toBe('🌱'.repeat(150));
      expect(await short.getByRole('button', { name: 'more', exact: true }).count()).toBe(0);
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(await long.locator('.k42-progress-body').getAttribute('id')).toBe(await toggle.getAttribute('aria-controls'));
      await toggle.focus();
      await p.keyboard.press('Enter');
      expect(await long.locator('.k42-progress-body').textContent()).toBe('🌱'.repeat(151));
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      await long.getByRole('button', { name: 'less', exact: true }).press('Space');
      expect(await long.locator('.k42-progress-body').textContent()).toBe('🌱'.repeat(150) + '…');
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await closePage(p); }
  }
});

test('slides swipe sideways with arrows, a counter and dots on desktop and phone', async () => {
  for (const width of [1440, 390]) {
    const p = await openPage({ width, height: 844 });
    try {
      await p.goto(origin);
      const post = p.getByRole('article', { name: 'Map update 3', exact: true });
      await post.getByRole('group', { name: 'Slide 1 of 3' }).waitFor();
      expect(await post.locator('.k42-progress-count').textContent()).toBe('1/3');
      expect(await post.getByRole('button', { name: 'Previous slide' }).count()).toBe(0);
      expect(await post.locator('.k42-progress-badge').first().textContent()).toBe('Concept');
      await post.getByRole('button', { name: 'Next slide' }).click();
      await p.waitForFunction(() => document.querySelector('.k42-progress-count')?.textContent === '2/3');
      expect(await post.locator('.k42-progress-image-caption').textContent()).toBe('Slide caption 2');
      expect(await post.locator('.k42-progress-dots .is-current').count()).toBe(1);
      await post.getByRole('button', { name: 'Next slide' }).click();
      await p.waitForFunction(() => document.querySelector('.k42-progress-count')?.textContent === '3/3');
      expect(await post.getByRole('button', { name: 'Next slide' }).count()).toBe(0);
      expect(await p.getByRole('article', { name: 'Map update 2', exact: true }).locator('.k42-progress-preview').count()).toBe(0);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await closePage(p); }
  }
}, 30000);
