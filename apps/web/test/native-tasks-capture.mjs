// Captures the synthetic native-tasks component harness (not the actual app). Usage: node test/native-tasks-capture.mjs <harness URL> <output dir>
import { chromium } from 'playwright';
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--single-process'] });
// --single-process allows one page: reuse it and reload per shot.
const page = await browser.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const shot = async (name, viewport, steps) => {
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('table').waitFor();
  await steps(page);
  await page.screenshot({ path: `${out}/${name}.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(name, { overflow, errors: errors.splice(0) });
};
const openDrawer = async page => {
  await page.getByRole('button', { name: 'Store native tasks with atomic claims' }).click();
  await page.getByRole('dialog').getByText('Claim transaction is in').waitFor();
};
await shot('tasks-desktop-list', { width: 1280, height: 800 }, async () => {});
await shot('tasks-desktop-drawer', { width: 1280, height: 900 }, async page => { await openDrawer(page); await page.getByText('Links').click(); });
await shot('tasks-desktop-create', { width: 1280, height: 800 }, async page => {
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title').fill('Draft the native task docs');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('dialog').getByText('Assign an agent before moving out of Backlog.').waitFor();
});
await shot('tasks-phone-list', { width: 390, height: 844 }, async () => {});
await shot('tasks-phone-drawer', { width: 390, height: 844 }, openDrawer);
await shot('tasks-readonly', { width: 1280, height: 800 }, async page => { await page.goto(`${url}?readonly=1`, { waitUntil: 'networkidle' }); await page.getByRole('table').waitFor(); });
await shot('tasks-disabled-readonly', { width: 1280, height: 800 }, async page => { await page.goto(`${url}?disabled=1`, { waitUntil: 'networkidle' }); await page.getByRole('table').waitFor(); });
await browser.close();
