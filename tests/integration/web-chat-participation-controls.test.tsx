import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { ParticipationControlView } from '@minions/contracts';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const pid = 'a'.repeat(64), oldId = '11111111-1111-4111-8111-111111111111';
const at = 1792224000000;
const participation = (extra: Partial<ParticipationControlView> = {}): ParticipationControlView => ({
  participationId: oldId, generation: 1, scope: 'Synthetic browser verification', approvedAt: at,
  deadlineAt: at + 30 * 60000, state: 'active', updatedAt: at, deviceLastSeenAt: at, pending: null, ...extra,
});

test('real website hook retains exact retries, never auto-resends, and End bypasses a hung Extend without models', async () => {
  const { createServer } = webRequire('vite'), { chromium } = webRequire(process.env.MINIONS_TEST_PLAYWRIGHT ?? 'playwright');
  const root = fileURLToPath(new URL('../../apps/web', import.meta.url));
  const apiPath = fileURLToPath(new URL('../../apps/web/src/api.ts', import.meta.url));
  const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body>
  <p>Synthetic current-chat verification · no model runs</p><main id="root" style="max-width:380px;margin:auto;padding:16px"></main>
  <script type="module">
  import React from 'react';import{createRoot}from'react-dom/client';import{useMyWorkerControls}from'/src/ui/MyWorkerControls.tsx';import{ChatWork}from'/src/ui/ChatParticipationControls.tsx';
  import '/src/styles.css';import '/src/ui/project-controls.css';import{session}from'/src/api.ts';
  function Harness(){const controls=useMyWorkerControls(session.currentUser(),${JSON.stringify(pid)},true);const a=controls.data?.agents[0];return a?React.createElement(ChatWork,{agentId:a.agentId,agentName:a.agentName,participation:a.participation,controls:controls.participation,now:controls.now,disabled:false}):null;}
  createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  const mock = `export class ApiError extends Error{constructor(status,message){super(message);this.status=status}}
  const user={uid:'synthetic-owner'};export const session={currentUser:()=>user,currentUid:()=>user.uid};
  export async function projects(user,path,body){
   if(!body)return structuredClone(window.fixture);
   window.calls.push({path,body:structuredClone(body)});
   if(body.kind==='extend'&&window.mode==='hang')return new Promise(resolve=>window.finishExtend=()=>resolve({participation:window.fixture.agents[0].participation,replayed:false}));
   if(window.mode==='fail'){window.mode='normal';throw new Error('Synthetic lost response');}
   if(body.kind==='release')window.fixture.agents[0].participation.state='released';
   return{participation:structuredClone(window.fixture.agents[0].participation),replayed:false};
  }`;
  const vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] } },
    plugins: [{ name: 'synthetic-participation-browser-port', enforce: 'pre', resolveId(source: string, importer?: string) {
      if (source === '/src/api.ts' || source === apiPath || source === '../api' && importer?.startsWith(root)) return '\0synthetic-participation-api';
    }, load(id: string) { if (id === '\0synthetic-participation-api') return mock; }, configureServer(server: any) {
      server.middlewares.use('/__participation.html', (_req: any, res: any) => { void server.transformIndexHtml('/__participation.html', html).then((value: string) => {res.setHeader('content-type', 'text/html');res.end(value);}); });
    } }],
  });
  let browser: any;
  try {
    await vite.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MINIONS_TEST_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: {width: 1280, height: 900} });
    await page.route('**/*', (route: any) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const active = participation({ approvedAt: Date.now(), deadlineAt: Date.now() + 1800000, updatedAt: Date.now() });
    await page.addInitScript((view: unknown) => { (window as any).fixture = view; (window as any).calls = []; (window as any).mode = 'hang'; },
      { agents: [{ agentId: 'synthetic-chat', agentName: 'Synthetic chat', participation: active, worker: { agentId: 'synthetic-chat', session: null, available: false, serverTime: Date.now(), next: null } }], serverTime: Date.now() });
    const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port: number}).port}/__participation.html`);
    const duration = page.getByRole('spinbutton', {name: 'Time to add for Synthetic chat, in minutes'});
    await duration.waitFor({state:'visible'});
    expect(await page.getByRole('button', {name:'Add time to Synthetic chat in this chat', exact: true}).isDisabled()).toBe(true);
    await duration.fill('10'); await page.getByRole('button', {name:'Add time to Synthetic chat in this chat', exact: true}).click();
    await page.waitForFunction(() => (window as any).calls.length === 1);
    await page.getByRole('button', {name:'End Synthetic chat in this chat'}).click();
    await page.getByText('Ended. Your computer will finish up shortly.', {exact:true}).waitFor();
    expect(await page.evaluate(() => (window as any).calls.map((c: any) => c.body.kind))).toEqual(['extend','release']);
    await page.evaluate(() => (window as any).finishExtend());
    expect(await page.getByText('Ended. Your computer will finish up shortly.', {exact:true}).count()).toBe(1);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await duration.waitFor(); await page.evaluate(() => (window as any).mode = 'fail');
    await duration.fill('15'); await page.getByRole('button', {name:'Add time to Synthetic chat in this chat', exact:true}).click();
    await page.getByRole('button', {name:'Retry adding time', exact:true}).waitFor();
    const original = await page.evaluate(() => (window as any).calls[0]);
    await page.reload();
    await page.getByRole('button', {name:'Retry adding time', exact:true}).waitFor();
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(0);
    await page.evaluate(() => (window as any).mode = 'normal');
    await page.getByRole('button', {name:'Retry adding time', exact:true}).click();
    await page.getByText('Saved. Time starts now; waiting for your computer.', {exact:true}).waitFor();
    expect(await page.evaluate(() => (window as any).calls[0])).toEqual(original);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await vite.close(); }
}, 60000);
