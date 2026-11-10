import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { probeApiRefusal } from '../support/api-readiness.mjs';
import { createServer as reservePort } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { disposableTarget } from '../support/disposable-session.mjs';
import { signInBrowser } from '../support/browser-session.js';
import { idTokenFor, testGithubId } from '../../apps/server/test/helpers.js';
import { collection, profiles, inProject, agents } from '../../apps/server/src/firestore.js';
import { createPrivateProject } from '../../apps/server/src/projects/private.js';
import { membershipDoc, membershipsOf } from '../../apps/server/src/projects/access.js';
import { addAgent } from '../../apps/server/test/helpers.js';
import { reportMergePolicy, mergePolicySnapshot } from '../../apps/server/src/projects/merge-policy.js';
import { db, githubAccounts } from '../../apps/server/src/firestore.js';
import { publishGitHubAccess } from '../../apps/server/src/projects/github-access.js';
import { projects } from '../../apps/server/src/projects/records.js';

disposableTarget();
const folder = process.argv[2]; if (!folder) throw new Error('Use the disposable launcher.');
const root = fileURLToPath(new URL('../../', import.meta.url));
async function port() { const s = reservePort(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p; }
const apiPort = await port(), webPort = await port(), origin = `http://127.0.0.1:${webPort}`;
Object.assign(process.env, { KARMA_LOCAL_API_URL: `http://127.0.0.1:${apiPort}` });
const owner = { id: 'merging-owner', name: 'Alex · synthetic', email: 'merging-owner@example.test', githubUsername: 'alex-example', removedAt: null, onboardingCompletedAt: Date.now() };
await profiles.doc(owner.id).set(owner); await idTokenFor(owner.email);
const project = await createPrivateProject(owner, { client_request_id: randomUUID(), title: 'Merging review · synthetic', goal: 'Disposable local verification; no models.', githubUrl: 'https://github.com/example/merge-review' }, Date.now) as { id: string };
for (const name of ['collaborator', 'member'] as const) {
  const id = `merging-${name}`, email = `${id}@example.test`;
  await profiles.doc(id).set({ name: `${name} · synthetic`, email, removedAt: null, onboardingCompletedAt: Date.now(), ...(name === 'collaborator' ? { githubUsername: 'collaborator-example' } : {}) });
  await idTokenFor(email);
  const membership = { profileId: id, projectId: project.id, role: 'member' as const, status: 'active' as const, statusChangedAt: 1, restrictions: { chatMutedUntil: null }, revision: 1, updatedAt: 1, connectionEpoch: 0 };
  await membershipDoc(project.id, id).set(membership); await membershipsOf(id).doc(project.id).set(membership);
}
await inProject(project.id, () => addAgent('merging-collaborator', 'Scout · synthetic', Date.now));
const revoked = await inProject(project.id, () => addAgent(owner.id, 'Retired · synthetic', Date.now));
await inProject(project.id, () => agents().doc(revoked.agentId).update({ revokedAt: Date.now() }));
let api: ReturnType<typeof spawn> | undefined, web: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [];
async function stopApi() {
  if (!api || api.exitCode !== null || api.signalCode !== null) return;
  const child=api, done=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.kill('SIGTERM'); const timer=setTimeout(()=>child.kill('SIGKILL'),6000);
  await done; clearTimeout(timer);
}
async function restartApi() {
  await stopApi();
  api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/api-process.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort) } });
  const child = api, deadline = Date.now() + 15_000;
  let last = 'No response', spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`API exited during startup (${child.exitCode ?? child.signalCode}).`);
    try {
      const response = await probeApiRefusal(`http://127.0.0.1:${apiPort}/api/projects`);
      last = `HTTP ${response.status}: ${response.body}`;
      if (response.status === 401 && JSON.parse(response.body).error === 'unauthorized') {
        console.info('API ready: fresh connection received the expected unauthenticated refusal.');
        return;
      }
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`API did not become ready within 15 seconds. Last probe: ${last}`);
}
async function signIn(page: Page, email: string) {
  await page.goto(`${origin}/viewer/`);
  await signInBrowser(page, await idTokenFor(email));
  await page.goto(`${origin}/viewer/?project=${project.id}&section=control-center&tab=merging`);
}
try {
  await restartApi();
  web = await createServer({ root: join(root, 'apps/web'), cacheDir: join(folder, 'vite-cache'), configFile: join(root, 'apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: webPort, strictPort: true, fs: { allow: [root] } } });
  await web.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('response', async response => { if(response.url().endsWith('/community/me') && response.status()>=400) console.error('Failed community identity check:',response.status(),await response.text()); });
  await signIn(page, owner.email);
  await page.getByRole('heading', { name: 'People and agents', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Control center', exact: true }).count(), 1);
  const policy = page.getByRole('region', { name: 'Current merge rules' });
  assert.match(await policy.innerText(), /Agent discretion/);
  await policy.locator('summary[aria-label="Edit merge rules"]').click();
  const slider = policy.getByRole('slider'); await slider.focus(); await slider.press('Home');
  await slider.press('ArrowRight');
  await policy.getByText('Guidance: people or a different member’s agent approve and merge.', { exact: true }).waitFor();
  await policy.getByText('Reviewer identity is not verified by MyLittleSwarm.', { exact: false }).waitFor();
  await page.screenshot({ path: join(folder, 'merging-review-guidance.png'), animations: 'disabled' });
  await slider.press('ArrowLeft');
  await policy.getByRole('button', { name: 'Save merge rules', exact: true }).click();
  await policy.getByRole('status').filter({ hasText: 'Saved as version 2.' }).waitFor();
  await page.reload(); await policy.getByText(/Human approval/).first().waitFor();
  // Restore the new private-project default after verifying an explicit policy change.
  await policy.locator('summary[aria-label="Edit merge rules"]').click();
  await slider.focus(); await slider.press('End'); await policy.getByRole('button', { name: 'Save merge rules', exact: true }).click();
  await policy.getByRole('status').filter({ hasText: 'Saved as version 3.' }).waitFor();
  await page.getByRole('link', { name: 'Repository', exact: true }).click();
  assert.equal(await policy.isVisible(), false);
  await page.getByRole('link', { name: 'Merge rules', exact: true }).click();
  await page.getByRole('heading', { name: 'People and agents', exact: true }).waitFor();
  // Real app/API merge-access saves against synthetic identities. No GitHub mutations.
  const accessControl = page.getByRole('region', { name: 'Who can merge', exact: true });
  await accessControl.getByLabel('Merge access', { exact: true }).selectOption('selected_people');
  await accessControl.getByRole('button', { name: 'Save merge access', exact: true }).click();
  await accessControl.getByText(/Pending GitHub synchronization/).waitFor();
  await page.getByText('Can merge · owner', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Grant merge access for member · synthetic', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke merge access for member · synthetic', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Revoke merge access for member · synthetic', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Revoke merge access for member · synthetic', exact: true }).click();
  await page.getByRole('button', { name: 'Grant merge access for member · synthetic', exact: true }).waitFor();
  await restartApi(); await page.reload();
  // Simulate a lost successful write response. Retrying must use its original receipt.
  const mergePath = `**/api/projects/${project.id}/merge-access`, attempts: string[] = [];
  await page.route(mergePath, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    attempts.push(route.request().postData()!);
    if (attempts.length === 1) { await route.fetch(); await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Synthetic lost merge receipt"}' }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Grant merge access for member · synthetic', exact: true }).click();
  await page.getByRole('button', { name: 'Retry original merge change', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke merge access for member · synthetic', exact: true }).waitFor();
  assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1], 'Retry uses the original operation ID and input.');
  await page.unroute(mergePath);
  await page.getByRole('button', { name: 'Revoke merge access for member · synthetic', exact: true }).click();
  await page.getByRole('button', { name: 'Grant merge access for member · synthetic', exact: true }).waitFor();
  // Renew this disposable API's request budget after the additional access edits.
  await restartApi();
  await page.reload();
  await page.getByRole('heading', { name: 'People and agents', exact: true }).waitFor();
  // Synthetic observations use the real approved-computer report path; no GitHub calls or model execution.
  await page.getByText('Not checked · Start MyLittleSwarm on your computer', { exact: true }).waitFor();
  const connectionId = randomUUID(), observedAt = Date.now();
  await collection<Record<string, unknown>>('computerConnections').doc(connectionId).set({ profileId: owner.id, approvedAt: observedAt, revokedAt: null, connectionExpiresAt: observedAt + 3600000 });
  const observation = { version: 1, membershipEpoch: 0, projectId: project.id, repository: 'https://github.com/example/merge-review', checkedAt: observedAt,
    account: { status: 'ok', value: { login: 'local-example' } }, access: { status: 'ok', value: { role: 'admin', defaultBranch: 'trunk' } },
    collaborators: { status: 'ok', value: { people: [{ login: 'collaborator-example', role: 'write' }], complete: false } },
    invitations: { status: 'forbidden', value: null }, rules: { status: 'ok', value: { types: ['pull_request'], requiredApprovals: 1, requiredChecks: ['ci'], complete: true } },
    protection: { status: 'unavailable', value: null }, pullRequests: { status: 'ok', value: { open: 7, drafts: 2, merged: 12, complete: true } } };
  await publishGitHubAccess(owner.id, connectionId, observation, () => observedAt);
  // Match the already-verified engine sign-ins to the displayed synthetic identities.
  await githubAccounts.doc(testGithubId(owner.email)).update({ login: owner.githubUsername });
  await githubAccounts.doc(testGithubId('merging-collaborator@example.test')).update({ login: 'collaborator-example' });
  const mergeTarget = await inProject(project.id, () => db.runTransaction(tx => mergePolicySnapshot(tx, project.id)));
  assert.ok(mergeTarget.target);
  await reportMergePolicy(owner.id, connectionId, { projectId: project.id, policyKey: mergeTarget.target.policyKey, code: 'verified' }, () => observedAt);
  await accessControl.getByRole('button', { name: 'Refresh enforcement', exact: true }).click();
  await accessControl.getByText(/Verified on GitHub/).waitFor();
  // Observations refresh while the section stays open, independently of Card revision.
  await page.getByRole('link', { name: /@local-example/ }).waitFor();
  // Reset only the disposable API process to expire its ten-second overview cache.
  await restartApi();
  await page.reload();
  await page.getByRole('heading', { name: 'People and agents', exact: true }).waitFor();
  await page.getByRole('link', { name: /@local-example/ }).waitFor();
  await page.getByRole('link', { name: '7 open pull requests, latest available count on GitHub (opens in a new tab)', exact: true }).waitFor();
  await page.getByRole('link', { name: '12 merged pull requests, latest available count on GitHub (opens in a new tab)', exact: true }).waitFor();
  await page.getByText('1 approval', { exact: true }).waitFor();
  await page.getByText('Check: ci', { exact: true }).waitFor();
  assert.match(await page.locator('tr').filter({ hasText: 'collaborator · synthetic' }).innerText(), /Write/);
  await page.getByText('Access details', { exact: true }).click();
  await page.getByText(/Partial list/).waitFor();
  await page.getByText(/Repository report by Alex/).waitFor();
  await page.getByText('Access details', { exact: true }).click();
  const failedAt = observedAt + 1;
  await publishGitHubAccess(owner.id, connectionId, { ...observation, checkedAt: failedAt, access: { status: 'forbidden', value: null }, pullRequests: { status: 'forbidden', value: null } }, () => failedAt);
  await restartApi();
  await page.reload();
  await page.getByRole('heading', { name: 'People and agents', exact: true }).waitFor();
  assert.match(await page.getByRole('region', { name: 'GitHub check' }).innerText(), /Cannot read.*Saved results/);
  await page.getByText(/Waiting for a new update\./).waitFor();
  await page.getByRole('link', { name: '7 open pull requests, latest available count on GitHub (opens in a new tab)', exact: true }).waitFor();
  for (const [width, height, name] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => {
      const nav = document.querySelector('.k42-ph-tabs'), link = nav?.querySelector('[aria-current="page"]');
      if (!nav || !link) return false;
      const strip = nav.getBoundingClientRect(), item = link.getBoundingClientRect();
      return item.left >= strip.left && item.right <= strip.right;
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no page overflow`);
    const panels = await page.locator('.k42-merging-panel').evaluateAll(nodes => nodes.map(n => ({ label: n.getAttribute('aria-label') ?? n.getAttribute('aria-labelledby') ?? n.tagName, width: n.clientWidth, content: n.scrollWidth })));
    assert.ok(panels.every(n => n.content <= n.width), `${name}: panels fit: ${JSON.stringify(panels)}`);
    // Keep the menu visible while switching between tall and short sections.
    // Use pointer clicks so locator auto-scrolling cannot hide a page jump.
    await page.locator('.workspace-content').evaluate(pane => {
      const nav = pane.querySelector('.control-center-nav')!;
      pane.scrollTop += nav.getBoundingClientRect().top - pane.getBoundingClientRect().top - 80;
    });
    for (const section of ['Repository', 'Merge rules', 'Repository', 'Merge rules']) {
      const link = page.getByRole('navigation', { name: 'Control center sections' }).getByRole('link', { name: section, exact: true });
      await link.evaluate(element => {
        const nav = element.parentElement!;
        nav.scrollLeft += element.getBoundingClientRect().left - nav.getBoundingClientRect().left - 8;
      });
      const before = await page.locator('.workspace-content').evaluate(pane => pane.scrollTop);
      const rect = await link.boundingBox(); assert.ok(rect);
      await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.locator('.control-center-panel > h3').filter({ hasText: section }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = await page.locator('.workspace-content').evaluate(pane => pane.scrollTop);
      assert.ok(Math.abs(after - before) <= 1, `${name}: ${section} keeps page position (${before} → ${after})`);
    }
    await page.getByRole('heading', { name: 'Control center', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(folder, `merging-${name}.png`), animations: 'disabled' });
    await page.getByRole('heading', { name: /^Merge requirements/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(folder, `merging-${name}-access.png`), animations: 'disabled' });
  }
  const accessPath = `**/api/projects/${project.id}/merging?*`;
  await page.route(accessPath, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Synthetic access failure"}' }));
  await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'About', exact: true }).click();
  await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Control center', exact: true }).click();
  await page.getByRole('link', { name: 'Merge rules', exact: true }).click();
  await page.getByText('Synthetic access failure', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'People and agents', exact: true }).count(), 0);
  await page.unroute(accessPath);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('heading', { name: 'People and agents', exact: true }).waitFor();
  // Preserve disposable session data across an API restart; this also renews its process-local request budget.
  await restartApi();
  await page.reload();
  await page.getByRole('heading', { name: 'People and agents', exact: true }).waitFor();
  await page.getByRole('link', { name: /@local-example/ }).waitFor();
  assert.ok(await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Control center', exact: true }).evaluate(link => {
    const strip = link.parentElement!.getBoundingClientRect(), item = link.getBoundingClientRect();
    return item.left >= strip.left && item.right <= strip.right;
  }), 'Mobile direct-link entry reveals selected Merging tab');
  // When execution starts the direct-link denial must still hold, independently of waiting-room routing.
  const record = (await projects.doc(project.id).get()).data()!;
  await projects.doc(project.id).update({ execution: { ...record.execution, started: true, paused: false, awaitingKickoff: false } });
  for (const role of ['collaborator', 'member']) {
    const otherContext = await browser.newContext(), other = await otherContext.newPage();
    await signIn(other, `merging-${role}@example.test`);
    await other.getByText('Control center is available to the project owner.', { exact: true }).waitFor();
    assert.equal(await other.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Control center', exact: true }).count(), 0);
    assert.equal(await other.getByRole('heading', { name: 'People and agents', exact: true }).count(), 0);
    await otherContext.close();
  }
  await projects.doc(project.id).update({ execution: { ...record.execution, completedAt: Date.now() } });
  await page.reload(); await page.getByText('Project closed. Reopen it to change the merge rules.').waitFor();
  assert.equal(await page.locator('summary[aria-label="Edit merge rules"]').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(join(folder, 'merging-app-results.json'), JSON.stringify({ checks: ['owner-only access', 'selected-people mode save/reload', 'retry after lost merge receipt', 'member grants and revocations', 'automatic owner merge access', 'pending versus verified enforcement', 'members hidden/direct denial', 'policy keyboard save and reload', 'settings editor removed', 'desktop and mobile fit', 'unknown access evidence', 'cached GitHub roles and rules', 'partial and forbidden source evidence', 'access failure clears data and retry recovers', 'mobile active tab direct-link visibility', 'closed read only', 'cached observations persist across API restart', 'connector PR counts in actual header', 'PR failure preserves timestamp and counts'], models: 0, errors }, null, 2));
  console.info(`Merging application checks passed. Evidence: ${folder}`);
} finally {
  await browser?.close(); await web?.close();
  await stopApi();
}
