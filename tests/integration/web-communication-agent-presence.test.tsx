import express from 'express';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { agents, db, inProject, type Agent } from '../../apps/server/src/firestore.js';
import { prepareCurrentStateProgress } from '../../apps/server/src/view/current-state-progress.js';
import { updateCanonicalStatus } from '../../apps/server/test/canonical-status-fixture.js';
import { writeAgentGroup } from '../../apps/server/src/v2/agent-group.js';
import { humanRequests } from '../../apps/server/src/projects/human-requests.js';
import { conversationEntries } from '../../apps/server/src/projects/steering.js';
import { messagesV2, presence } from '../../apps/server/src/v2/records.js';
import { startRun, reportPhase } from '../../apps/server/src/v2/runs.js';
import { syncWorkerSession } from '../../apps/server/src/projects/worker-sessions.js';
import { webAgentStarts } from '../../apps/server/src/owner/web-agent-starts.js';
import { viewRoutes } from '../../apps/server/src/view/routes.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from '../../apps/server/test/helpers.js';

// Agent-document fields the status document mirrors (contract C3: revocation, focus) are written as the product writers
// do, with the agent group in the same transaction, so the default-on current-state read sees what agents/{id} says.
const writeAgent = (agentId: string, change: Partial<Agent>) => db.runTransaction(async tx => {
  const ref = agents().doc(agentId), saved = await tx.get(ref);
  const status = presence().doc(agentId), progress = await prepareCurrentStateProgress(tx, [status]);
  tx.update(ref, change); writeAgentGroup(tx, status, { ...(saved.data() as Agent), ...change }, undefined, progress);
});

test('real communication card supports avatars, live states, hover, keyboard and mobile without inventing status on failure', async () => {
  const screenshots = await mkdtemp(join(tmpdir(), 'mlswarm-app-state-bubbles-'));
  await resetEmulator();
  const at = Date.now(), names = ['Demo Fox','Demo Owl','Demo Otter','Demo Panda','Demo Wolf','Demo Dog','Demo Hare'];
  const f = await seed({ project: { startsAt: at - 3600000 }, profiles: [{ name: 'Demo reader', email: 'communication-reader@example.test' }],
    agents: names.map(name => ({ person: 0, name })) });
  // The authoritative roster excludes the retired Dog even when the parent's
  // bounded preview still contains its historical identity.
  const activeAgentCount = f.agents.length - 1;
  await inProject(TEST_PROJECT, async () => {
    for (const [i, agent] of f.agents.entries()) {
      const run = await startRun(agent.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-test-no-model', takeover: false }, () => at);
      if ([0,3,4].includes(i)) await reportPhase(agent.agentId, run.run_id, { phase: 'turn' }, () => at);
      if (i === 2 || i === 3) await syncWorkerSession(agent.agentId, { run_id: run.run_id, missionId: run.run_id, startedAt: at,
        deadlineAt: at + 3600000, phase: i === 2 ? 'waiting' : 'blocked', remainingSlots: 64, generation: 1 }, () => at);
      if (i === 4) await updateCanonicalStatus(agent.agentId, { lastContactAt: at - 90001 });
      if (i === 5) await writeAgent(agent.agentId, { revokedAt: at });
      await writeAgent(agent.agentId, { focus: { text: `Synthetic focus: ${names[i]} is checking the map controls.`, updatedAt: at - 1000, runId: run.run_id } });
      const message = { id: `demo-${i}`, threadId: `demo-${i}`, agentId: agent.agentId,
        agentName: names[i], protocol: 2 as const, body: `Synthetic message from ${names[i]}`, createdAt: at - 1000,
        audience: 'direct' as const, to: [f.agents[(i+1)%f.agents.length].agentId] };
      await messagesV2().doc(message.id).set(message);
      await conversationEntries().doc(message.id).set({ ...message, kind: 'agent_message' });
    }
  });
  // Waiting is an approved queued start; a worker waiting for work is Idle.
  await webAgentStarts.doc(randomUUID()).set({ profileId: f.personIds[0], projectId: TEST_PROJECT,
    agentId: f.agents[2].agentId, state: 'pending', name: names[2], createdAt: at,
    pickupByAt: at + 600_000, activeUntil: at + 600_000 } as never);
  await inProject(TEST_PROJECT, () => conversationEntries().doc('demo-human-steering').set({
    id: 'demo-human-steering', threadId: 'demo-human-steering', kind: 'steering', agentId: f.agents[0].agentId,
    agentName: names[0], actorProfileId: f.personIds[0], actorName: 'Demo reader', to: [f.agents[0].agentId],
    body: 'Synthetic shared steering', audience: 'direct', protocol: 2, createdAt: at - 500, origin: 'coding_chat',
    operationId: randomUUID(), missionId: randomUUID(), generation: 1, state: 'queued', observedAt: null, receiptSequence: 0,
  }));
  await humanRequests.doc(randomUUID()).set({projectId:TEST_PROJECT,agentId:f.agents[6].agentId,assigneeProfileId:f.personIds[0],visibility:'private',status:'open',createdAt:at} as any);
  const token = await idTokenFor('communication-reader@example.test');
  let serverNow=at;
  const app = express(); app.use('/p/:projectId/api/view', scoped(viewRoutes(() => serverNow)));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createServer } = webRequire('vite');
  const { chromium } = webRequire(process.env.MLSWARM_TEST_PLAYWRIGHT ?? 'playwright');
  const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body>
    <p>Synthetic communication fixture · no running models</p><main id="root" style="max-width:1000px;margin:auto;padding:16px"></main>
    <script type="module">
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {ProjectCommunication} from '/src/ui/ProjectCommunication.tsx';
    import {session} from '/src/api.ts';
    import '/src/styles.css'; import '/src/ui/project-home.css';
    const agents=${JSON.stringify(f.agents.map((a, i) => ({ id: a.agentId, name: names[i], createdAt: at - 3600000, revokedAt: null })))};
    const user={uid:'test-reader',getIdToken:async()=>${JSON.stringify(token)}};
    // The fixture supplies the token; align the session's observed account with it.
    Object.assign(session,{currentUser:()=>user,currentUid:()=>user.uid});
    function Fixture(){const [active,setActive]=useState(true),[opened,setOpened]=useState(null),[destination,setDestination]=useState(null);return React.createElement(React.Fragment,null,
      React.createElement('button',{onClick:()=>setActive(true)},'Return to Activity'),
      opened&&React.createElement('p',null,'Opened agent: '+opened),
      !active&&React.createElement('p',null,'Conversation destination'),
      !active&&React.createElement('p',null,'Thread: '+(destination?.thread??'none')),
      React.createElement('div',{hidden:!active},React.createElement(ProjectCommunication,{user,projectId:${JSON.stringify(TEST_PROJECT)},active,agents,onOpenAgent:agentId=>setOpened(agentId),go:route=>{setDestination(route);setActive(false)}})));}
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script></body></html>`;
  const vite = await createServer({ root: fileURLToPath(new URL('../../apps/web', import.meta.url)), cacheDir: join(screenshots, 'vite-cache'), configFile: false,
    server: { host: '127.0.0.1', port: 0, proxy: { '/p': origin }, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url)), realpathSync(fileURLToPath(new URL('../../node_modules/@fontsource-variable/inter', import.meta.url)))] } },
    plugins: [{ name: 'isolated-communication-verification', configureServer(server: any) {
      server.middlewares.use('/__communication.html', (_req: any, res: any) => {
        void server.transformIndexHtml('/__communication.html', html).then((value: string) => { res.setHeader('content-type', 'text/html'); res.end(value); });
      });
    } }],
  });
  let browser: any;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.route('**/*', (route: any) => ['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/__communication.html`);
    expect(await page.locator('.k42-communication-timeline').count()).toBe(0);
    const fox = page.getByRole('button', { name: /^Select agent Demo Fox\./ });
    await fox.waitFor({ state: 'visible', timeout: 20000 });
    await page.getByRole('button', { name: /^Select agent Demo Fox\. Current status: Working\./ }).waitFor({ state: 'visible' });
    for (const [name,state] of [['Demo Owl','Idle'],['Demo Otter','Waiting'],['Demo Panda','Blocked'],['Demo Wolf','Offline'],['Demo Hare','Needs you']])
      expect(await page.getByRole('button', { name: new RegExp(`^Select agent ${name}\\. Current status: ${state}\\.`) }).count(), `${name} should be ${state}`).toBe(1);
    expect(await page.getByRole('button', { name: /^Select agent Demo Dog\./ }).count()).toBe(0);
    const humanEdge = page.getByRole('button', { name: `Show messages from Demo reader to ${names[0]}`, exact: true });
    await humanEdge.waitFor({ state: 'visible' });
    expect(await humanEdge.getAttribute('data-from')).toBe(`person:${f.personIds[0]}`);
    await humanEdge.press('Enter');
    await page.getByText('Conversation destination', { exact: true }).waitFor();
    expect(await page.getByText('Thread: demo-human-steering', { exact: true }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Return to Activity' }).click();
    const person = page.getByRole('button', { name: 'Open profile for Demo reader', exact: true });
    await person.waitFor({ state: 'visible' });
    {
      await person.focus();
      await expect.poll(() => page.locator('.communication-map').getAttribute('data-owner-highlight')).toBe(f.personIds[0]);
      expect(await page.getByRole('tooltip').count()).toBe(0);
      await person.press('Escape');
      await expect.poll(() => page.locator('.communication-map').getAttribute('data-owner-highlight')).toBe('');
    }
    expect(await page.locator('.k42-communication-avatar').count()).toBe(activeAgentCount);
    expect(await page.locator('.agent-state-bubble').count()).toBe(activeAgentCount);
    expect(await page.locator('.k42-communication-state-marker').count()).toBe(0);
    const urgent=page.locator('.agent-state-bubble.state-needs_you .agent-state-bubble-surface');
    expect(await urgent.evaluate((node:Element)=>getComputedStyle(node).fill)).toBe('rgb(180, 35, 24)');
    expect(await urgent.getAttribute('r')).toBe('17');
    expect(await page.locator('.agent-state-bubble.state-working').evaluate((node:Element)=>getComputedStyle(node).color)).toBe('rgb(0, 102, 255)');
    expect(await page.getByRole('button',{name:'2D',exact:true}).count()).toBe(0);
    expect(await page.locator('.communication-map').getAttribute('data-map-dimensions')).toBe('2');
    // Native fullscreen and CSS fallback both retain tooltip content inside the panel.
    await page.getByRole('button',{name:'Full screen',exact:true}).click();
    await page.locator('.k42-communication.is-expanded').waitFor({state:'visible'});
    await fox.hover();
    await page.getByRole('tooltip').waitFor({state:'visible'});
    expect(await page.getByRole('tooltip').evaluate((node:Element)=>!!node.closest('.k42-communication.is-expanded'))).toBe(true);
    await page.locator('[data-map-edge]:visible').first().press('Enter');
    await page.getByText('Conversation destination',{exact:true}).waitFor({state:'visible'});
    await expect.poll(()=>page.locator('.k42-communication.is-expanded').count()).toBe(0);
    await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
    await page.getByRole('button',{name:'Return to Activity'}).click();
    await page.evaluate(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(new Error('Synthetic native fullscreen unavailable'));});
    await page.getByRole('button',{name:'Full screen',exact:true}).click();
    await page.locator('.k42-communication.is-expanded').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await expect.poll(()=>page.locator('.k42-communication.is-expanded').count()).toBe(0);
    await expect.poll(()=>page.getByRole('button',{name:'Full screen',exact:true}).evaluate((node:Element)=>node===document.activeElement)).toBe(true);
    await fox.hover(); const tooltip = page.getByRole('tooltip'); await tooltip.waitFor({ state: 'visible' });
    expect(await tooltip.innerText()).toContain('Synthetic focus: Demo Fox is checking the map controls.');
    expect(await tooltip.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: join(screenshots, 'desktop.png') });
    await page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'detached' });
    await fox.focus(); await tooltip.waitFor({ state: 'visible' }); await fox.press('Enter'); expect(await page.getByText('Opened agent: '+f.agents[0].agentId,{exact:true}).isVisible()).toBe(true);
    expect(await fox.getAttribute('aria-pressed')).toBe('false');
    await tooltip.waitFor({ state: 'visible' });
    const resetOwnerFromMap=async()=>{
      const ownerMenu=page.getByRole('combobox',{name:"Highlight agents by person",exact:true});
      const ownerId=await ownerMenu.locator('option').nth(1).getAttribute('value');
      await ownerMenu.selectOption(ownerId!);
      await page.getByRole('button',{name:'Fit map',exact:true}).click();
      expect(await ownerMenu.inputValue()).toBe(ownerId);
      await page.getByRole('group',{name:'Agent communication graph',exact:true}).click({position:{x:4,y:4}});
      expect(await ownerMenu.inputValue()).toBe('');
      await expect.poll(()=>page.locator('.communication-map').getAttribute('data-owner-highlight')).toBe('');
      expect(await fox.getAttribute('aria-pressed')).toBe('false');
      await fox.focus();await fox.press('Enter');await tooltip.waitFor({state:'visible'});
      expect(await page.getByText('Opened agent: '+f.agents[0].agentId,{exact:true}).isVisible()).toBe(true);
      expect(await fox.getAttribute('aria-pressed')).toBe('false');
      await expect.poll(()=>page.locator('.communication-map').getAttribute('data-owner-highlight')).toBe(ownerId);
      await page.getByRole('group',{name:'Agent communication graph',exact:true}).click({position:{x:4,y:4}});
      await expect.poll(()=>page.locator('.communication-map').getAttribute('data-owner-highlight')).toBe('');
      expect(await ownerMenu.inputValue()).toBe('');
      expect(await fox.getAttribute('aria-pressed')).toBe('false');
      await tooltip.waitFor({state:'detached'});
    };
    await resetOwnerFromMap();
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await resetOwnerFromMap();
    // Tap the visible portrait; neighboring transparent hit areas must not
    // intercept it in the compact fitted mobile overview.
    await fox.locator('.k42-communication-avatar').click(); await tooltip.waitFor({ state: 'visible' });
    expect(await page.locator('.k42-communication-spotlight').count()).toBe(0);
    await fox.focus(); await tooltip.waitFor({ state: 'visible' });
    const box = await tooltip.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(12); expect(box.x+box.width).toBeLessThanOrEqual(378);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The overview fits the full world; direct inspection preserves a readable portrait.
    const frameBeforeFocus=await page.locator('.communication-map').getAttribute('data-map-frames');
    await expect.poll(async()=>Number(await page.locator('.communication-map').getAttribute('data-map-frames')),{timeout:15000}).toBeGreaterThan(Number(frameBeforeFocus)+3);
    await fox.focus();
    await expect.poll(async()=> (await page.locator('.k42-communication-avatar').first().boundingBox()).width).toBeGreaterThanOrEqual(38);
    expect(await page.locator('.state-working .agent-state-bubble-symbol-motion').evaluate((node: Element) => getComputedStyle(node).animationName)).toBe('none');
    await page.screenshot({ path: join(screenshots, 'mobile.png') });
    // The status read (the current-state endpoint, the only one) fails: the map shows the error and no invented states.
    await page.route('**/communication/agents/current*', (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Status unavailable' }) }));
    await page.reload(); await page.getByText('Current agent states are unavailable. Communication history is still shown.').waitFor({ state: 'visible' });
    expect(await page.locator('.k42-communication-avatar').count()).toBe(activeAgentCount);
    expect(await page.getByRole('button', { name: /^Select agent Demo Dog\./ }).count()).toBe(0);
    expect(await page.locator('.k42-map-crowd [data-tip="Demo Dog"]').count()).toBe(0);
    await humanEdge.waitFor({ state: 'visible' });
    expect(await page.locator(`[data-map-edge][data-from="${f.agents[5].agentId}"], [data-map-edge][data-to="${f.agents[5].agentId}"]`).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Select agent Demo Fox. Current status: Unknown.' }).count()).toBe(1);
    await page.route('**/communication/traffic?*', (route:any)=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Traffic unavailable'})}));
    await page.reload();await page.getByRole('button',{name:'Retry connections',exact:true}).waitFor({state:'visible'});
    expect(await page.locator('[data-map-edge]').count()).toBe(0);
    await page.unroute('**/communication/traffic?*');await page.getByRole('button',{name:'Retry connections',exact:true}).click();
    await expect.poll(()=>page.getByRole('button',{name:'Retry connections',exact:true}).count()).toBe(0);
    await expect.poll(()=>page.locator('[data-map-edge]').count()).toBeGreaterThan(0);
    // A slow/failed live refresh must not remove the last accepted connections.
    const acceptedEdges=await page.locator('[data-map-edge]').count();
    let requested!:()=>void,release!:()=>void;
    const nextTraffic=new Promise<void>(resolve=>{requested=resolve;});
    const finishTraffic=new Promise<void>(resolve=>{release=resolve;});
    await page.route('**/communication/traffic?*',async(route:any)=>{
      requested();await finishTraffic;
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Refresh temporarily unavailable'})});
    });
    // V1 shares frames for five seconds and reuses traffic when its newest-message
    // mark is unchanged. Advance beyond that cache and add a real synthetic message
    // on an existing edge, so this phase tests a failed refresh rather than waiting
    // for the unchanged-traffic fallback interval.
    serverNow+=5001;
    await inProject(TEST_PROJECT,async()=>{
      const message={id:'demo-refresh',threadId:'demo-refresh',agentId:f.agents[0].agentId,
        agentName:names[0],protocol:2 as const,body:'Synthetic refresh trigger',createdAt:serverNow-1,
        audience:'direct' as const,to:[f.agents[1].agentId]};
      await messagesV2().doc(message.id).set(message);
      await conversationEntries().doc(message.id).set({...message,kind:'agent_message'});
    });
    await nextTraffic;
    expect(await page.locator('[data-map-edge]').count()).toBe(acceptedEdges);
    release();await page.getByRole('button',{name:'Retry connections',exact:true}).waitFor({state:'visible'});
    expect(await page.locator('[data-map-edge]').count()).toBe(acceptedEdges);
    await page.unroute('**/communication/traffic?*');
    // The paged roster, not the parent’s bounded preview, owns map completeness.
    await page.unroute('**/communication/agents/current*');
    serverNow+=60001; // Independent acceptance phase: release the synthetic fixed-time quota window.
    await inProject(TEST_PROJECT,async()=>{
      const template=(await agents().doc(f.agents[0].agentId).get()).data()!;
      const batch=agents().firestore.batch();
      for(let i=0;i<67;i++)batch.set(agents().doc(`additional-${String(i).padStart(3,'0')}`),{...template,name:`Additional agent ${i}`});
      await batch.commit();
    });
    await page.reload();
    await expect.poll(()=>page.locator('.k42-communication-avatar').count()).toBe(activeAgentCount+67);
    const lastOwn=page.getByRole('button',{name:/Select agent Additional agent 66/});
    await lastOwn.waitFor();
    await lastOwn.focus();
    await page.getByRole('tooltip').waitFor({state:'visible'});
    expect(await page.getByRole('tooltip').innerText()).toContain('Additional agent 66');
    expect(await page.getByRole('button',{name:/Select agent Additional agent 66/}).count()).toBe(1);
    // Rate limiting preserves the graph without bringing back the removed preview.
    await page.clock.install();
    serverNow+=60001;
    const lastNodes=await page.locator('.k42-communication-avatar').count();
    // The refresh notice must not move or resize the graph, even on mobile.
    await page.getByRole('button',{name:'Fit map',exact:true}).click();
    const mapBounds=()=>page.locator('.communication-map').evaluate((node:Element)=>{const r=node.getBoundingClientRect();return {y:r.y,width:r.width,height:r.height};});
    const beforeNotice=await mapBounds();
    let rateCalls=0;
    await page.route('**/api/view/communication?*',(route:any)=>{rateCalls++;return route.fulfill({status:429,headers:{'Retry-After':'60'},json:{error:'rate_limited',message:'Synthetic read budget'}});});
    await page.clock.runFor(10000);
    const rateNotice=page.getByText('Updates will resume shortly. Showing the last loaded view.',{exact:true});
    await rateNotice.waitFor({state:'visible'});
    expect(await mapBounds()).toEqual(beforeNotice);
    expect(await page.locator('.k42-communication-avatar').count()).toBe(lastNodes);
    await page.clock.runFor(20000);expect(rateCalls).toBe(1);
    await page.unroute('**/api/view/communication?*');
    // Frame reconciliation runs every 60 seconds. A tick during the 60-second
    // Retry-After hold is skipped, so recovery may need the following full interval.
    // Cover both bounds without weakening the no-extra-request assertion above.
    await page.clock.runFor(60000+60000);await rateNotice.waitFor({state:'detached'});
    expect(await mapBounds()).toEqual(beforeNotice);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close(); await vite.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 90000);
