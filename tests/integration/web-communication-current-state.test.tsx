// c12: the actual web map (ProjectCommunication) reading the current-state endpoint, its only status read, end to end on
// the Firestore emulator: real source writers (run start, phase report, worker sync, a private request), the real view
// routes, and the real component in Chromium. A failed read keeps what is shown and says so, then recovers; an access
// refusal clears the states. No other read is ever made. Synthetic data, no running models.
import express from 'express';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { inProject } from '../../apps/server/src/firestore.js';
import { humanRequests } from '../../apps/server/src/projects/human-requests.js';
import { startRun, reportPhase } from '../../apps/server/src/v2/runs.js';
import { syncWorkerSession } from '../../apps/server/src/projects/worker-sessions.js';
import { webAgentStarts } from '../../apps/server/src/owner/web-agent-starts.js';
import { revokeOwned } from '../../apps/server/src/onboarding/store.js';
import { viewRoutes } from '../../apps/server/src/view/routes.js';
import { stopCurrentState } from '../../apps/server/src/view/current-state.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from '../../apps/server/test/helpers.js';

afterEach(() => { stopCurrentState(); });

test('the map shows live states from the current-state endpoint, its only status read, and says so when a read fails or access is refused', async () => {
  await resetEmulator();
  stopCurrentState();
  const at = Date.now(), names = ['Demo Fox', 'Demo Owl', 'Demo Otter', 'Demo Hare'];
  const f = await seed({ project: { startsAt: at - 3600000 }, profiles: [{ name: 'Demo reader', email: 'current-state-reader@example.test' }],
    agents: names.map(name => ({ person: 0, name })) });
  await inProject(TEST_PROJECT, async () => {
    for (const [i, agent] of f.agents.entries()) {
      const run = await startRun(agent.agentId, { clientRunId: randomUUID(), runnerVersion: 'synthetic-test-no-model', takeover: false }, () => at);
      if (i === 0) await reportPhase(agent.agentId, run.run_id, { phase: 'turn' }, () => at);
      if (i === 2) await syncWorkerSession(agent.agentId, { run_id: run.run_id, missionId: run.run_id, startedAt: at,
        deadlineAt: at + 3600000, phase: 'waiting', remainingSlots: 64, generation: 1 }, () => at);
    }
  });
  await webAgentStarts.doc(randomUUID()).set({ profileId: f.personIds[0], projectId: TEST_PROJECT,
    agentId: f.agents[2]!.agentId, state: 'pending', name: names[2], createdAt: at,
    pickupByAt: at + 600_000, activeUntil: at + 600_000 } as never);
  await humanRequests.doc(randomUUID()).set({ projectId: TEST_PROJECT, agentId: f.agents[3]!.agentId, assigneeProfileId: f.personIds[0],
    visibility: 'private', status: 'open', createdAt: at } as never);
  const token = await idTokenFor('current-state-reader@example.test');
  let serverNow = at;
  const app = express(); app.use('/p/:projectId/api/view', scoped(viewRoutes(() => serverNow)));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createServer } = webRequire('vite');
  const { chromium } = webRequire(process.env.MLSWARM_TEST_PLAYWRIGHT ?? 'playwright');
  const html = `<!doctype html><html><meta charset="utf-8"><body><main id="root"></main>
    <script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ProjectCommunication} from '/src/ui/ProjectCommunication.tsx';
    import {session} from '/src/api.ts';
    import '/src/styles.css'; import '/src/ui/project-home.css';
    const agents=${JSON.stringify(f.agents.map((a, i) => ({ id: a.agentId, name: names[i], createdAt: at - 3600000, revokedAt: null })))};
    const user={uid:'test-reader',getIdToken:async()=>${JSON.stringify(token)}};
    Object.assign(session,{currentUser:()=>user,currentUid:()=>user.uid});
    createRoot(document.getElementById('root')).render(React.createElement(ProjectCommunication,{user,projectId:${JSON.stringify(TEST_PROJECT)},active:true,agents,onOpenAgent:()=>{},go:()=>{}}));
    </script></body></html>`;
  const cacheDir = await mkdtemp(join(tmpdir(), 'mlswarm-current-state-browser-'));
  const vite = await createServer({ root: fileURLToPath(new URL('../../apps/web', import.meta.url)), cacheDir, configFile: false,
    server: { host: '127.0.0.1', port: 0, proxy: { '/p': origin }, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url)), realpathSync(fileURLToPath(new URL('../../node_modules/@fontsource-variable/inter', import.meta.url)))] } },
    plugins: [{ name: 'current-state-map', configureServer(server: any) {
      server.middlewares.use('/__current-state.html', (_req: any, res: any) => {
        void server.transformIndexHtml('/__current-state.html', html).then((value: string) => { res.setHeader('content-type', 'text/html'); res.end(value); });
      });
    } }],
  });
  let browser: any;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}),
      ...(process.env.MLSWARM_TEST_BROWSER_ARGS ? { args: process.env.MLSWARM_TEST_BROWSER_ARGS.split(' ') } : {}) });
    const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/__current-state.html`;
    const statusOf = (page: any, name: string, state: string) =>
      page.getByRole('button', { name: new RegExp(`^Select agent ${name}\\. Current status: ${state}\\.`) });
    // One page for every phase, reloaded from scratch for each (single-process Chromium cannot open a second page after
    // closing the first); each phase gets its own request and error records.
    let shared: any, current = { reads: [] as string[], errors: [] as string[] };
    const open = async (search: string, prepare?: (page: any) => Promise<void>) => {
      if (!shared) {
        shared = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await shared.route('**/*', (route: any) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
        shared.on('request', (request: any) => { const path = new URL(request.url()).pathname; if (path.includes('/communication/agents/')) current.reads.push(path.replace(/^.*\/communication\/agents\//, '')); });
        shared.on('pageerror', (e: Error) => current.errors.push(e.message));
      } else await shared.goto('about:blank');
      current = { reads: [], errors: [] };
      await prepare?.(shared);
      await shared.goto(base + search);
      return { page: shared, ...current };
    };

    const rounds = (page: any) => page.locator('.k42-communication-map-stage').getAttribute('data-status-rounds');
    const unavailable = (page: any) => page.getByText('Current agent states are unavailable. Communication history is still shown.');
    // Every state the map shows comes from the endpoint, including the viewer's own Needs you.
    let releaseRoster!: (route: any) => void;
    const nextRoster = new Promise<any>(done => { releaseRoster = done; });
    const rosterRows = f.agents.map((agent, i) => ({ id: agent.agentId, name: names[i], operatorId: f.personIds[0], createdAt: at }));
    const on = await open('', page => page.route('**/communication/roster*', (route: any) => {
      if (new URL(route.request().url()).searchParams.has('cursor')) { releaseRoster(route); return; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ agents: rosterRows.slice(0, 2), next: 'synthetic-next-page', serverTime: at }) });
    }));
    const remainder = await nextRoster;
    try { await on.page.getByText('1 person · 2 agents shown', { exact: true }).waitFor({ timeout: 10000 }); }
    finally { await remainder.fulfill({ contentType: 'application/json', body: JSON.stringify({ agents: rosterRows.slice(2), next: null, serverTime: at }) }); }
    await on.page.unroute('**/communication/roster*');
    await statusOf(on.page, 'Demo Fox', 'Working').waitFor({ state: 'visible', timeout: 20000 });
    for (const [name, state] of [['Demo Owl', 'Idle'], ['Demo Otter', 'Waiting'], ['Demo Hare', 'Needs you']])
      await statusOf(on.page, name, state).waitFor({ state: 'visible' });
    expect(on.reads).toContain('current');
    expect(on.reads.filter(read => read !== 'current')).toEqual([]);
    // A clock-only transition with no source write: contact + 90 s passes, the endpoint re-sends the same rev with a later
    // evaluatedAt, and the map shows Offline within its next poll.
    serverNow = at + 95_000;
    await statusOf(on.page, 'Demo Fox', 'Offline').waitFor({ state: 'visible', timeout: 20000 });
    await statusOf(on.page, 'Demo Owl', 'Offline').waitFor({ state: 'visible' });
    // Every round rested on a complete endpoint answer: a quiet listener past the stall bound is served from its
    // re-attached snapshot (c3 S1).
    expect(on.reads.filter(read => read !== 'current')).toEqual([]);
    expect(await rounds(on.page)).toMatch(/^current:\d+ held:0 pending:0 error:0$/);
    expect(on.errors).toEqual([]);

    // The roster can lag behind a status update. Counts must follow the live graph's revocation filter.
    await on.page.route('**/communication/roster*', (route: any) => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ agents: rosterRows, next: null, serverTime: at }) }));
    await inProject(TEST_PROJECT, () => revokeOwned(f.personIds[0]!, f.agents[3]!.agentId, () => serverNow));
    await on.page.getByText('1 person · 3 agents shown', { exact: true }).waitFor({ timeout: 20000 });
    expect(await statusOf(on.page, 'Demo Hare', 'Needs you').count()).toBe(0);
    await on.page.unroute('**/communication/roster*');

    // A failing read (503) keeps the shown states and says so; the next good answer clears the message. An access refusal
    // (404: no longer a member) clears the states. Neither makes any other read.
    serverNow = at;
    const failed = await open('');
    await statusOf(failed.page, 'Demo Fox', 'Working').waitFor({ state: 'visible', timeout: 20000 });
    await failed.page.route('**/communication/agents/current*', (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Status unavailable' }) }));
    await unavailable(failed.page).waitFor({ state: 'visible', timeout: 20000 });
    expect(await statusOf(failed.page, 'Demo Fox', 'Working').count()).toBe(1);
    await failed.page.unroute('**/communication/agents/current*');
    await unavailable(failed.page).waitFor({ state: 'hidden', timeout: 20000 });
    await failed.page.route('**/communication/agents/current*', (route: any) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Project not available.' }) }));
    await unavailable(failed.page).waitFor({ state: 'visible', timeout: 20000 });
    await statusOf(failed.page, 'Demo Fox', 'Unknown').waitFor({ state: 'visible' });
    await failed.page.unroute('**/communication/agents/current*');
    await statusOf(failed.page, 'Demo Fox', 'Working').waitFor({ state: 'visible', timeout: 20000 });
    expect(failed.reads.filter(read => read !== 'current')).toEqual([]);
    expect(await rounds(failed.page)).toMatch(/\berror:[2-9]/);
    expect(failed.errors).toEqual([]);
  } finally {
    await browser?.close();
    await vite.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 120_000);
