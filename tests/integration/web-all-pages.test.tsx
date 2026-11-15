// Real hook/effect lifetimes with a deferred synthetic transport. No Auth/Firestore or models.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

let vite: any, browser: any, context: any, origin: string;
const root = fileURLToPath(new URL('../../', import.meta.url));
const apiFile = fileURLToPath(new URL('../../apps/web/src/api.ts', import.meta.url));
beforeAll(async () => {
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createServer } = require('vite'), { chromium } = require('playwright');
  const transport = `import {createContext} from 'react';
    export const ProjectScope=createContext(null);
    export class ApiError extends Error {constructor(status,message){super(message);this.status=status;}}
    export function read(user,path,project){return new Promise((resolve,reject)=>{
      window.fixture.requests.push({uid:user?.uid,path,project,resolve,reject});
    });}`;
  const html = `<!doctype html><html><body><div id="root"></div><script type="module">
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{useAllPages}from'/src/use-all-pages.ts';import{ProjectScope,ApiError}from'/src/api.ts';
    const path=cursor=>'/agents'+(cursor?'?cursor='+cursor:'');
    window.fixture={requests:[],resolve(index,items,next=null){this.requests[index].resolve({agents:items.map(id=>({id})),next});},
      reject(index,status){this.requests[index].reject(new ApiError(status,'Synthetic refusal'));}};
    // Fixture ticks represent the caller's thirty-second poll; a two-page walk fits that cadence.
    function Directory({state}){const rows=useAllPages({uid:state.uid},path,'agents',state.first.map(id=>({id})),state.tick,state.active,30_000);
      return React.createElement('output',{id:'rows'},JSON.stringify(rows.map(row=>row.id)));}
    function Harness(){const[state,setState]=useState({uid:'account-a',project:'project-a',first:['a'],tick:0,active:true,mounted:true});
      window.fixture.configure=patch=>setState(old=>({...old,...patch}));
      window.fixture.tick=()=>setState(old=>({...old,tick:old.tick+1}));
      return React.createElement(ProjectScope.Provider,{value:state.project},state.mounted?React.createElement(Directory,{state}):null);}
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>`;
  vite = await createServer({ root: fileURLToPath(new URL('../../apps/web', import.meta.url)), configFile: false,
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    plugins: [{ name: 'deferred-directory-transport', enforce: 'pre', load(id: string) { if (id === apiFile) return transport; },
      configureServer(server: any) { server.middlewares.use('/__all-pages.html', (_req: any, res: any) => {
        void server.transformIndexHtml('/__all-pages.html', html).then((value: string) => { res.setHeader('content-type', 'text/html'); res.end(value); });
      }); } }],
  });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}/__all-pages.html`;
  browser = await chromium.launch({ headless: true, ...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MINIONS_TEST_BROWSER_EXECUTABLE } : {}) });
  // Keep one context alive across pages. Closing an implicitly owned context with
  // browser.newPage() can close single-process Chromium before the next case.
  context = await browser.newContext();
}, 30_000);
afterAll(async () => { await context?.close(); await browser?.close(); await vite?.close(); });
const requests = (page: any, count: number) => page.waitForFunction((expected: number) => (window as any).fixture?.requests.length === expected, count);
const rows = (page: any, expected: string[]) => page.waitForFunction((value: string) => document.querySelector('#rows')?.textContent === value, JSON.stringify(expected));
// Let React apply control changes before asserting that no additional network read was admitted.
const flush = (page: any) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('ticks coalesce slow walks; completed snapshots supersede stale first pages and access loss suppresses them', async () => {
  const page = await context.newPage();
  try {
    await page.goto(origin); await requests(page, 1); await rows(page, ['a']);
    await page.evaluate(() => (window as any).fixture.resolve(0, ['a'], 'page-2')); await requests(page, 2);
    await page.evaluate(() => { (window as any).fixture.tick(); (window as any).fixture.tick(); }); await flush(page);
    expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(2);
    await page.evaluate(() => (window as any).fixture.resolve(1, ['b'])); await rows(page, ['a', 'b']); await flush(page);
    await page.evaluate(() => (window as any).fixture.tick()); await requests(page, 3);
    await page.evaluate(() => (window as any).fixture.reject(2, 503)); await flush(page); await rows(page, ['a', 'b']);
    await page.evaluate(() => (window as any).fixture.tick()); await requests(page, 4);
    await page.evaluate(() => (window as any).fixture.reject(3, 403)); await rows(page, []); await flush(page);
    await page.evaluate(() => (window as any).fixture.tick()); await requests(page, 5);
    await page.evaluate(() => (window as any).fixture.reject(4, 503)); await flush(page); await rows(page, []);
    await page.evaluate(() => (window as any).fixture.tick()); await requests(page, 6);
    await page.evaluate(() => { (window as any).fixture.resolve(5, []); });
    await rows(page, []); await flush(page);
    await page.evaluate(() => (window as any).fixture.tick()); await requests(page, 7);
    await page.evaluate(() => (window as any).fixture.resolve(6, ['revalidated'])); await rows(page, ['revalidated']); await flush(page);
    await page.evaluate(() => (window as any).fixture.tick()); await requests(page, 8);
    await page.evaluate(() => (window as any).fixture.resolve(7, [])); await rows(page, []);
  } finally { await page.close(); }
}, 30_000);

test('account and project changes, deactivation and unmount discard delayed pages without reading their next cursor', async () => {
  const page = await context.newPage();
  try {
    await page.goto(origin); await requests(page, 1);
    await page.evaluate(() => (window as any).fixture.configure({uid:'account-b',first:['b']})); await requests(page, 2); await rows(page, ['b']);
    await page.evaluate(() => (window as any).fixture.resolve(0, ['private-a'], 'must-not-read')); await flush(page);
    expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(2); await rows(page, ['b']);
    await page.evaluate(() => (window as any).fixture.configure({project:'project-b',first:['new-project']})); await requests(page, 3);
    await page.evaluate(() => (window as any).fixture.resolve(1, ['old-project'], 'must-not-read')); await flush(page); await rows(page, ['new-project']);
    await page.evaluate(() => (window as any).fixture.configure({active:false})); await flush(page);
    await page.evaluate(() => (window as any).fixture.resolve(2, ['inactive'], 'must-not-read')); await flush(page);
    expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(3);
    await page.evaluate(() => (window as any).fixture.configure({active:true})); await requests(page, 4);
    await page.evaluate(() => (window as any).fixture.configure({mounted:false})); await flush(page);
    await page.evaluate(() => (window as any).fixture.resolve(3, ['unmounted'], 'must-not-read')); await flush(page);
    expect(await page.evaluate(() => (window as any).fixture.requests.length)).toBe(4);
    expect(await page.locator('#rows').count()).toBe(0);
    const scopes = await page.evaluate(() => (window as any).fixture.requests.map(({uid,project}: any) => [uid,project]));
    expect(scopes).toEqual([['account-a','project-a'],['account-b','project-a'],['account-b','project-b'],['account-b','project-b']]);
  } finally { await page.close(); }
}, 30_000);
