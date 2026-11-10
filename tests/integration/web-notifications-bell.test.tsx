// Real bell interactions with synthetic HTTP replies. No saved accounts, models or external network.
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const web = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const root = fileURLToPath(new URL('../../apps/web', import.meta.url));
const notice = (id: string, reason: string) => ({ id, reason, kind: 'moderation', actorName: 'Moderator', action: 'pause',
  agentName: 'Synthetic agent', agentId: 'synthetic-agent', projectId: 'a'.repeat(64), projectTitle: 'Synthetic project', createdAt: 1000 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const reply = (route: any, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

type Reads = { me?: (route: any, uid: string) => Promise<void>; needsYou?: (route: any) => Promise<void> };
async function bell(run: (page: any) => Promise<void>, notifications: (route: any, url: URL, uid: string) => Promise<void>, reads: Reads = {}) {
  const { createServer } = web('vite'), { chromium } = web(process.env.MLSWARM_TEST_PLAYWRIGHT ?? 'playwright');
  const html = `<!doctype html><html><meta charset="utf-8"><body><main id="root"></main><script type="module">
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {NotificationsBell} from '/src/ui/NotificationsBell.tsx'; import {session} from '/src/api.ts';
    import {QueryClientProvider} from '@tanstack/react-query'; import {queryClient} from '/src/query-client.ts';
    import '/src/styles.css';
    const account=uid=>({uid,getIdToken:async()=>uid});
    function Fixture(){const [user,setUser]=useState(()=>account('Alice'));
      Object.assign(session,{currentUser:()=>user,currentUid:()=>user.uid});
      window.switchAccount=uid=>setUser(account(uid));
      return React.createElement(QueryClientProvider,{client:queryClient},React.createElement(NotificationsBell,{user,active:true,go:()=>{}}));}
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script></body></html>`;
  const cacheDir = await mkdtemp(join(tmpdir(), 'mlswarm-notifications-bell-'));
  const vite = await createServer({ root, cacheDir, configFile: false, server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url)), realpathSync(web.resolve('@fontsource-variable/inter/package.json') + '/..')] } },
  plugins: [{ name: 'synthetic-bell', configureServer(server: any) { server.middlewares.use('/__bell.html', (_req: any, res: any) => {
    void server.transformIndexHtml('/__bell.html', html).then((value: string) => { res.setHeader('content-type', 'text/html'); res.end(value); });
  }); } }] });
  let browser: any;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage(), errors: string[] = [], wrongProfiles: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), uid = route.request().headers().authorization?.replace('Bearer ', '') ?? '';
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
      // This fixture controls reads directly. A valid idle SSE connection avoids
      // treating Vite's missing endpoint as an unrelated terminal access event.
      if (url.pathname === '/api/realtime') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': ready\n\n' });
      if (url.pathname === '/community/me') return reads.me ? reads.me(route, uid) : reply(route, { person: { id: `profile-${uid}` } });
      if (url.pathname.startsWith('/api/needs-you') || url.pathname.startsWith('/api/owner/notifications')) {
        if (route.request().headers()['x-mlswarm-profile-id'] !== `profile-${uid}`) {
          wrongProfiles.push(`${uid}:${url.pathname}`); return reply(route, { message: 'Wrong profile' }, 403);
        }
        if (url.pathname.startsWith('/api/needs-you')) return reads.needsYou ? reads.needsYou(route) : reply(route, { items: [], next: null });
        return notifications(route, url, uid);
      }
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/__bell.html`);
    await run(page);
    expect(errors).toEqual([]);
    expect(wrongProfiles, 'an account may never request another account\'s invited profile').toEqual([]);
  } finally { await browser?.close(); await vite.close(); }
}

test('a filtered-empty update page retains an honest bell label and a working next-page action', async () => {
  const second = notice('second', 'Older unread update');
  await bell(async page => {
    await page.getByRole('button', { name: 'Notifications, more updates available', exact: true }).click();
    await page.getByText('More updates are available', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'More updates', exact: true }).click();
    await page.getByText(second.reason, { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: 'More updates', exact: true }).count()).toBe(0);
  }, (route, url) => reply(route, url.searchParams.has('cursor') ? { items: [second], next: null } : { items: [], next: 'older-page' }));
}, 60_000);

test('opening the bell before its profile is known does not read Needs you for no one', async () => {
  const me = deferred<void>();
  await bell(async page => {
    await page.getByRole('button', { name: /^Notifications/ }).click();
    // Give a read the opening starts time to reach the fixture, which reports one without the profile.
    await page.waitForTimeout(500);
    me.resolve();
    await page.getByRole('tab', { name: /Updates/ }).waitFor();
  }, route => reply(route, { items: [], next: null }), { me: async (route, uid) => { await me.promise; await reply(route, { person: { id: `profile-${uid}` } }); } });
}, 60_000);

test('Try again reads Needs you again after that read failed', async () => {
  let failing = true, reads = 0;
  await bell(async page => {
    await page.getByRole('button', { name: /^Notifications/ }).click();
    // The first read and the one opening the bell starts both fail before the reply recovers.
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    const alert = page.getByRole('alert');
    await alert.waitFor();
    failing = false;
    await alert.getByRole('button', { name: 'Try again', exact: true }).click();
    await alert.waitFor({ state: 'detached', timeout: 5000 });
  }, route => reply(route, { items: [], next: null }), { needsYou: route => ++reads && failing ? reply(route, { message: 'GitHub is busy.' }, 500) : reply(route, { items: [], next: null }) });
}, 60_000);

test('an earlier first-page refresh cannot replace a completed older notification page', async () => {
  const older = notice('older', 'Keep this older update'), delayed = deferred<any>();
  let firstPageReads = 0;
  await bell(async page => {
    await page.getByRole('button', { name: 'Notifications, more updates available', exact: true }).click();
    const stale = await delayed.promise;
    try {
      await page.getByRole('button', { name: 'More updates', exact: true }).click();
      await page.getByText(older.reason, { exact: false }).waitFor();
      await reply(stale, { items: [], next: 'older-page' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.getByText(older.reason, { exact: false }).count()).toBe(1);
      expect(await page.getByRole('button', { name: 'More updates', exact: true }).count()).toBe(0);
    } finally { await reply(stale, { items: [], next: 'older-page' }).catch(() => {}); }
  }, async (route, url) => {
    if (url.searchParams.has('cursor')) return reply(route, { items: [older], next: null });
    if (++firstPageReads === 2) { delayed.resolve(route); return; }
    return reply(route, { items: [], next: 'older-page' });
  });
}, 60_000);

for (const action of ['dismiss', 'mark-all'] as const) test(`an older delayed poll cannot restore a notice after ${action} is acknowledged`, async () => {
  const old = notice('old', 'Dismiss this update'), delayed = deferred<any>(), fresh = deferred<any>();
  let reads = 0, dismissed = false;
  await bell(async page => {
    await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
    const stale = await delayed.promise;
    await page.getByRole('button', { name: action === 'dismiss' ? `Clear ${old.reason}` : 'Clear all', exact: true }).click();
    const current = await fresh.promise;
    try {
      await reply(stale, { items: [old], next: null });
      // Let the actual fetch/React work settle while the newer read remains deliberately unanswered.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.getByText(old.reason, { exact: false }).count()).toBe(0);
      await page.getByText("You're all caught up", { exact: true }).waitFor();
    } finally { await reply(current, { items: [], next: null }); }
  }, async route => {
    if (route.request().method() === 'POST') { dismissed = true; return reply(route, { ok: true }); }
    if (++reads === 2) { delayed.resolve(route); return; }
    if (dismissed) { fresh.resolve(route); return; }
    return reply(route, { items: [old], next: null });
  });
}, 60_000);

test('a previous account mutation cannot block or alter the next account bell', async () => {
  const alice = notice('alice', 'Alice update'), bob = notice('bob', 'Bob update'), pendingAlice = deferred<any>();
  let bobRead = false;
  await bell(async page => {
    await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
    await page.getByRole('button', { name: `Clear ${alice.reason}`, exact: true }).click();
    const oldMutation = await pendingAlice.promise;
    try {
      await page.evaluate(() => (window as any).switchAccount('Bob'));
      await page.getByText(bob.reason, { exact: false }).waitFor({ timeout: 5000 });
      await reply(oldMutation, { ok: true });
      await page.getByRole('button', { name: `Clear ${bob.reason}`, exact: true }).click();
      await page.getByText("You're all caught up", { exact: true }).waitFor();
      expect(bobRead).toBe(true);
      expect(await page.getByText(alice.reason, { exact: false }).count()).toBe(0);
    } finally { await reply(oldMutation, { ok: true }).catch(() => {}); }
  }, async (route, _url, uid) => {
    if (route.request().method() === 'POST') {
      if (uid === 'Alice') { pendingAlice.resolve(route); return; }
      bobRead = true; return reply(route, { ok: true });
    }
    return reply(route, { items: uid === 'Alice' ? [alice] : bobRead ? [] : [bob], next: null });
  });
}, 60_000);
