// Actual local app/API, disposable SQLite, synthetic observations; no model or native worker.
import { signInBrowser } from '../support/browser-session.js';
import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer as portServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inProject, profiles } from '../../apps/server/src/firestore.js';
import { startRun } from '../../apps/server/src/v2/runs.js';
import { runs } from '../../apps/server/src/v2/records.js';
import { syncWorkerSession } from '../../apps/server/src/projects/worker-sessions.js';
import { projectCollection } from '../../apps/server/src/firestore.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from '../../apps/server/test/helpers.js';
const root = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
async function port() { const s = portServer(); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve)); const value = (s.address() as { port: number }).port; await new Promise<void>(resolve => s.close(() => resolve())); return value; }

test('the local My agents panel expires old background activity and keeps fresh same-mission sessions', async () => {
  await resetEmulator();
  const directory = await mkdtemp(join(tmpdir(), 'mlswarm-stale-status-')), apiPort = await port(), webPort = await port(), at = Date.now();
  const fixture = await seed({ project: { name: 'Synthetic worker observations', startsAt: at - 60000, endsAt: at + 600_000 },
    profiles: [{ name: 'Demo owner', email: 'owner-stale@example.test', role: 'owner' }],
    agents: [{ person: 0, name: 'Synthetic stale Fox' }, { person: 0, name: 'Synthetic fresh Owl' }] });
  await profiles.doc(fixture.personIds[0]).update({ onboardingCompletedAt: 100 });
  const identities: { agentId: string; runId: string }[] = [];
  await inProject(TEST_PROJECT, async () => {
    for (const [index, agent] of fixture.agents.entries()) {
      const old = at - 120_000, runId = randomUUID();
      const run = await startRun(agent.agentId, { clientRunId: runId, runnerVersion: 'synthetic-no-process', takeover: false }, () => old);
      identities.push({ agentId: agent.agentId, runId });
      await syncWorkerSession(agent.agentId, { run_id: runId, missionId: runId, generation: 1, startedAt: old,
        deadlineAt: at + 600_000, remainingSlots: 64, phase: index === 0 ? 'working' : 'waiting' }, () => index === 0 ? old : at);
      await projectCollection('backgroundControls').doc(agent.agentId).set({
        target: { site: 'http://127.0.0.1', ownerId: fixture.personIds[0], projectId: TEST_PROJECT, agentId: agent.agentId },
        missionId: runId, generation: 1, deadlineAt: at + 600_000, state: 'running', pauseOperationId: null,
        updatedAt: old, deviceLastSeenAt: old, connectionId: randomUUID(), pendingId: null,
        cloudRun: { runId, generation: run.generation },
      });
    }
  });
  const api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), ADMIN_EMAILS: 'admin@example.test' } });
  let apiOutput = ''; api.stdout?.on('data', data => { apiOutput += String(data); }); api.stderr?.on('data', data => { apiOutput += String(data); });
  const { createServer } = require('vite'), { chromium } = require('playwright');
  const web = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}`, '/community': `http://127.0.0.1:${apiPort}`, '/p': `http://127.0.0.1:${apiPort}` } } });
  let browser: any, diagnostic: any;
  try {
    for (let n = 0; ; n++) {
      if (api.exitCode !== null) throw new Error(apiOutput);
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/feedback/admin`)).status === 401) break; } catch {}
      if (n > 100) throw new Error(apiOutput || 'API did not start'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    await web.listen(); browser = await chromium.launch({ headless: true, args: ['--single-process'], ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route: any) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const page = await context.newPage(); diagnostic = page;
    const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${webPort}/?project=${TEST_PROJECT}&section=agents`);
    await signInBrowser(page, await idTokenFor('owner-stale@example.test'));
    const panel = page.locator('.my-worker-controls');
    const stale = panel.locator('.background-worker-row').filter({ hasText: 'Synthetic stale Fox' });
    const fresh = panel.locator('.background-worker-row').filter({ hasText: 'Synthetic fresh Owl' });
    await stale.waitFor();
    await expect.poll(() => stale.locator('.k42-agent-status-text').innerText()).toBe('Offline');
    expect(await stale.locator('.state-offline').count()).toBe(1);
    expect(await stale.locator('.state-working').count()).toBe(0);
    expect(await stale.getByRole('button', { name: 'Pause Synthetic stale Fox' }).isDisabled()).toBe(true);
    await expect.poll(() => fresh.locator('.k42-agent-status-text').innerText()).toBe('Idle');
    expect(await fresh.locator('.state-idle').count()).toBe(1);
    // Reading status does not end a run, change its identity or start any native process.
    for (const identity of identities) {
      const saved = await inProject(TEST_PROJECT, async () => (await runs().doc(identity.agentId).get()).data());
      expect(saved).toMatchObject({ runId: identity.runId, endedAt: null });
    }
    await panel.screenshot({ animations: 'disabled', path: join(directory, 'stale-worker-panel.png') });
    expect(errors).toEqual([]);
    console.info(`Verified the actual local My agents panel with synthetic observations and no model processes: ${directory}`);
  } catch (e) { if (diagnostic) { await diagnostic.screenshot({ animations: 'disabled', path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await diagnostic.locator('body').innerText().catch(() => 'No UI'), apiOutput.slice(-1500)); } throw e; }
  finally { if (browser) for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'wait' }); await browser?.close(); await web.close(); api.kill('SIGTERM'); await new Promise<void>(resolve => { if (api.exitCode !== null) resolve(); else api.once('exit', () => resolve()); }); }
}, 120_000);
