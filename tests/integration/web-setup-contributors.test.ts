import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

for (const [mode, width] of [['private', 390], ['public', 1000]] as const) {
  test(`${mode} creation uses the short flow, keeps one-person defaults and submits from the final inline summary`, async () => {
    const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
    const { createServer } = require('vite'), { chromium } = require(process.env.MLSWARM_TEST_PLAYWRIGHT ?? 'playwright');
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root"></main><script type="module">
      import React from 'react'; import {createRoot} from 'react-dom/client'; import '/src/styles.css';
      import {ProjectSetupModal} from '/src/ui/project-setup/ProjectSetupModal.tsx';
      createRoot(document.getElementById('root')).render(React.createElement(ProjectSetupModal,{open:true,onClose:()=>{},
        initialDraft:{name:'Synthetic project',purpose:'Verify the approved short setup',minContributors:200},
        onConfirm:(draft,mode)=>{window.confirmed={draft,mode};}}));
    </script></body></html>`;
    const vite = await createServer({ root: fileURLToPath(new URL('../../apps/web', import.meta.url)), configFile: false,
      server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'short-setup-test', configureServer(server: any) {
        server.middlewares.use('/__setup.html', (_req: any, res: any) => { void server.transformIndexHtml('/__setup.html', html).then((page: string) => { res.setHeader('Content-Type', 'text/html'); res.end(page); }); });
      } }] });
    let browser: any;
    try {
      await vite.listen(); browser = await chromium.launch({ headless: true, ...(process.env.MLSWARM_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.MLSWARM_TEST_BROWSER_EXECUTABLE } : {}) });
      const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(5000);
      await page.route('**/*', (route: any) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__setup.html`);
      const visibility = page.getByRole('radiogroup', { name: 'Project visibility' });
      await visibility.getByRole('radio', { name: /Private/ }).focus();
      if (mode === 'public') await page.keyboard.press('ArrowRight');
      expect(await visibility.getByRole('radio', { name: mode === 'public' ? /Public/ : /Private/ }).getAttribute('aria-checked')).toBe('true');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      expect(await page.getByRole('textbox', { name: 'Project name', exact: true }).inputValue()).toBe('Synthetic project');
      expect(await page.getByRole('spinbutton').count()).toBe(0);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      const progress = page.getByRole('progressbar'); expect(await progress.getAttribute('aria-valuenow')).toBe(await progress.getAttribute('aria-valuemax'));
      expect(await page.locator('.setup-body').getAttribute('data-setup-step')).toBe('Repository');
      await page.getByLabel('Project summary').waitFor();
      expect(await page.getByRole('radio').count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Skip for now', exact: true }).count()).toBe(0);
      const submit = page.getByRole('button', { name: mode === 'private' ? 'Create project' : 'Submit for review', exact: true });
      await submit.click(); await page.getByRole('alert').waitFor();
      expect(await page.evaluate(() => (window as any).confirmed)).toBeUndefined();
      await page.getByRole('textbox', { name: 'GitHub repository', exact: true }).fill('github.com/example/project');
      await submit.click();
      const result = await page.evaluate(() => (window as any).confirmed);
      expect(result.mode).toBe(mode); expect(result.draft.minContributors).toBe(1);
      expect(result.draft.agentGuidance).toBe(''); expect(result.draft.sendsPerHour).toBe(60);
      expect(result.draft).not.toHaveProperty('plannedRole');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await browser?.close(); await vite.close(); }
  }, 30_000);
}
