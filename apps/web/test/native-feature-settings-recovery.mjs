// Focused production-component regression; synthetic delayed transport, no Auth,
// Firestore, models or saved viewer state. Run: node apps/web/test/native-feature-settings-recovery.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'mlswarm-feature-settings-'));
const entry = join(root, '__feature-settings-recovery.tsx');
const source = `
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { TaskSettingsControl } from '/src/ui/TaskSettingsControl.tsx';
import '/src/styles.css';
import '/src/ui/theme.css';
window.currentSetting = { enabled: false, revision: 0 };
window.saved = []; window.writes = []; window.holdRead = false; window.failRead = false;
let receipt = null, uncertain = true;
const apiA = {
  get: () => window.failRead ? Promise.reject(new TypeError('Synthetic read failure')) : window.holdRead ? new Promise(resolve => { window.finishRead = resolve; }) : Promise.resolve(window.currentSetting),
  save: input => {
    window.writes.push(input);
    receipt ??= { enabled: input.enabled, revision: 1 };
    if (uncertain) { uncertain = false; window.currentSetting = { enabled: false, revision: 2 }; return Promise.reject(new TypeError('Synthetic lost response')); }
    return Promise.resolve(receipt);
  },
};
const apiB = { get: () => Promise.resolve({ enabled: true, revision: 20 }), save: () => { throw new Error('Unexpected project B write'); } };
function Harness() {
  const [project, setProject] = useState('A');
  window.switchProject = () => setProject('B');
  return <><p>Project {project}</p><TaskSettingsControl api={project === 'A' ? apiA : apiB} active={true} feature="teams" onSaved={setting => window.saved.push({ project, ...setting })} /></>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;
let server, browser;
try {
  server = await createServer({ root, cacheDir, configFile: join(root, 'vite.config.ts'), plugins: [{
    name: 'synthetic-feature-settings-recovery',
    configureServer(app) { app.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/review-teams') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await app.transformIndexHtml(req.url, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__feature-settings-recovery.tsx"></script></body></html>'));
    }); },
    resolveId(id) { if (id.endsWith('/__feature-settings-recovery.tsx')) return entry; },
    load(id) { if (id === entry) return source; },
  }], server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ args: ['--single-process'], ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  for (const mode of ['current', 'read-failure', 'switch-project']) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/review-teams`);
    const group = page.getByRole('group', { name: 'Use teams in this project', exact: true });
    const on = group.getByRole('button', { name: 'On', exact: true }), off = group.getByRole('button', { name: 'Off', exact: true });
    await off.waitFor();
    await on.click();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    if (mode === 'read-failure') await page.evaluate(() => { window.failRead = true; });
    if (mode === 'switch-project') await page.evaluate(() => { window.holdRead = true; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    if (mode === 'read-failure') {
      await page.getByRole('alert').getByText('Change confirmed, but current team settings could not be read.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0, 'a confirmed mutation must never become an uncertain write again');
      await page.evaluate(() => { window.failRead = false; });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
    } else if (mode === 'switch-project') {
      await page.waitForFunction(() => typeof window.finishRead === 'function');
      await page.evaluate(() => window.switchProject());
      await page.getByText('Project B', { exact: true }).waitFor();
      await on.waitFor();
      await page.evaluate(() => window.finishRead({ enabled: false, revision: 2 }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await on.getAttribute('aria-pressed'), 'true', 'the previous project post-save read cannot change this project');
      assert.deepEqual(await page.evaluate(() => window.saved), [], 'late post-save read must not publish a callback in the new project');
    }
    if (mode !== 'switch-project') {
      await off.waitFor();
      assert.equal(await off.getAttribute('aria-pressed'), 'true', 'display the newer OFF revision, not the historical ON receipt');
      assert.deepEqual(await page.evaluate(() => window.saved), [{ project: 'A', enabled: false, revision: 2 }], 'the parent learns the recovered current setting, including after a read failure');
    }
    const writes = await page.evaluate(() => window.writes);
    assert.equal(writes.length, 2, 'confirmed-write read recovery sends no additional mutation');
    assert.deepEqual(writes[0], writes[1], 'the uncertain mutation retries its identical original input');
    await page.close();
  }
  console.log('PASS: setting retries settle historical intent, reread current state, recover read failures without writes, and fence project changes.');
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
