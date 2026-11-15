// Focused production-component regression; synthetic delayed transport, no Auth,
// Firestore, models or saved viewer state. Run: node apps/web/test/native-teams-access-loss.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'minions-teams-access-loss-'));
const entry = join(root, '__team-access-loss.tsx');
const source = `
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ProjectTeams } from '/src/ui/ProjectTeams.tsx';
import '/src/styles.css';
import '/src/ui/theme.css';
const mode = new URLSearchParams(location.search).get('mode') ?? 'detail';
let team = { id: 'team-test', projectId: 'project-test', name: 'Private launch group', purpose: 'Private purpose', createdByAgentId: 'a', memberCount: 1, revision: 1, archived: false, createdAt: 1000, updatedAt: 1000 };
const otherTeam = { ...team, projectId: 'other-project', name: 'Other project group', purpose: 'Other project purpose' };
let refused = false, pendingList = null, rejectLabel = null;
const detail = value => ({ team: value, members: [{ agentId: 'a', active: true, joinedAt: 1000, leftAt: null }, ...(value.memberCount === 2 ? [{ agentId: 'b', active: true, joinedAt: 2000, leftAt: null }] : [])], activity: value.memberCount === 2 ? [{ id: 'joined', teamId: value.id, actorAgentId: 'b', action: 'join', revision: 2, at: 2000, team: value }] : [], nextMemberCursor: null, nextActivityCursor: null });
window.listReads = 0;
const apiA = {
  list: () => { window.listReads++; return refused ? new Promise(resolve => { pendingList = resolve; }) : Promise.resolve({ teams: [team], nextCursor: null }); },
  get: () => refused && mode === 'detail' ? Promise.reject(Object.assign(new Error('Project access was removed'), { status: window.refusalStatus })) : Promise.resolve(detail(team)),
};
const apiB = { list: () => Promise.resolve({ teams: [otherTeam], nextCursor: null }), get: () => Promise.resolve(detail(otherTeam)) };
const lookupA = { agents: () => new Promise((_resolve, reject) => { rejectLabel = reject; window.labelReadStarted = true; }), members: async () => [] };
const lookupB = { agents: async () => [{ id: 'a', name: 'Current project agent', operatorId: 'p', operatorName: 'Current owner', revokedAt: null }], members: async () => [] };
window.refusalStatus = 403;
window.refuse = () => { refused = true; };
window.finishStaleList = () => { pendingList?.({ teams: [team], nextCursor: null }); };
window.finishLabel = () => { rejectLabel?.(Object.assign(new Error('Project access was removed'), { status: window.refusalStatus })); };
window.changeTeam = () => { team = { ...team, purpose: 'Updated team purpose', revision: 2, memberCount: 2 }; };
function Harness() {
  const [project, setProject] = useState('A');
  const [refreshToken, setRefreshToken] = useState(0), [active, setActive] = useState(true);
  window.switchProject = () => setProject('B');
  window.invalidateTeams = () => setRefreshToken(value => value + 1);
  window.deactivateTeams = () => setActive(false);
  return <ProjectTeams api={project === 'A' ? apiA : apiB} active={active} refreshToken={refreshToken} disabledNotice={false} agents={[]} lookup={mode === 'detail' || mode === 'live' ? undefined : project === 'A' ? lookupA : lookupB} scope={project} />;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;
let server, browser;
try {
  server = await createServer({ root, cacheDir, configFile: join(root, 'vite.config.ts'), plugins: [{
    name: 'synthetic-team-access-loss',
    configureServer(app) { app.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/review-teams') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await app.transformIndexHtml(req.url, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__team-access-loss.tsx"></script></body></html>'));
    }); },
    resolveId(id) { if (id.endsWith('/__team-access-loss.tsx')) return entry; },
    load(id) { if (id === entry) return source; },
  }], server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ args: ['--single-process'], ...(process.env.MINIONS_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MINIONS_TEST_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  for (const mode of ['detail', 'labels']) for (const status of [401, 403, 404]) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/review-teams?mode=${mode}`);
    await page.getByRole('button', { name: 'Private launch group 1 member', exact: true }).click();
    await page.getByText('Private purpose', { exact: true }).waitFor();
    if (mode === 'labels') await page.waitForFunction(() => window.labelReadStarted === true);
    await page.evaluate(code => { window.refusalStatus = code; window.refuse(); }, status);
    // Keep a directory response outstanding while detail or actor-label access refuses.
    await page.getByRole('button', { name: 'Refresh teams', exact: true }).click();
    if (mode === 'labels') await page.evaluate(() => window.finishLabel());
    await page.getByRole('alert').getByText('Project access was removed', { exact: false }).waitFor();
    assert.equal(await page.getByText('Private launch group', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Private purpose', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: 'Team details', exact: true }).count(), 0);
    await page.evaluate(() => window.finishStaleList());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('Private launch group', { exact: true }).count(), 0, 'late list data must remain fenced after confirmed access loss');
    await page.close();
  }
  for (const status of [401, 403, 404]) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/review-teams?mode=labels`);
    await page.getByRole('button', { name: 'Private launch group 1 member', exact: true }).click();
    await page.getByText('Private purpose', { exact: true }).waitFor();
    await page.waitForFunction(() => window.labelReadStarted === true);
    await page.evaluate(code => { window.refusalStatus = code; window.switchProject(); }, status);
    await page.getByText('Other project purpose', { exact: true }).waitFor();
    await page.getByText('Current project agent', { exact: true }).first().waitFor();
    await page.evaluate(() => window.finishLabel());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('alert').count(), 0, 'a previous project label rejection must not clear the current context');
    assert.equal(await page.getByText('Other project purpose', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Other project group 1 member', exact: true }).count(), 1);
    await page.close();
  }
  for (const refresh of ['invalidation', 'reconciliation']) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/review-teams?mode=live`);
    await page.getByRole('button', { name: 'Private launch group 1 member', exact: true }).click();
    await page.getByText('Private purpose', { exact: true }).waitFor();
    await page.clock.install();
    await page.evaluate(() => window.changeTeam());
    if (refresh === 'invalidation') await page.evaluate(() => window.invalidateTeams());
    else await page.clock.fastForward(60000);
    await page.getByRole('button', { name: 'Private launch group 2 members', exact: true }).waitFor();
    await page.getByText('Updated team purpose', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Members (2)', exact: true }).waitFor();
    await page.getByText('Agent b joined', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Private launch group 2 members', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => window.deactivateTeams());
    const reads = await page.evaluate(() => window.listReads);
    await page.clock.fastForward(120000);
    assert.equal(await page.evaluate(() => window.listReads), reads, 'inactive teams must not poll');
    await page.close();
  }
  console.log('PASS: detail and label 401/403/404 clear all team data and fence pending directory responses; previous-context label refusals cannot clear a new project.');
  console.log('PASS: invalidation and reconciliation refresh the directory, selected roster and history without manual refresh; inactive views do not poll.');
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
