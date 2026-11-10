// Synthetic harness check: typing in the drawer keeps focus in the field; Escape closes and returns focus to the opener.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--single-process'] });
const page = await browser.newPage();
await page.goto(process.argv[2], { waitUntil: 'networkidle' });
const opener = page.getByRole('button', { name: 'Store native tasks with atomic claims' });
await opener.click();
await page.getByRole('dialog').getByText('Claim transaction is in').waitFor();
await page.getByLabel('Comment', { exact: true }).click();
await page.keyboard.type('typed slowly', { delay: 30 });
const typing = await page.evaluate(() => ({ value: document.activeElement?.value, label: document.activeElement?.getAttribute('aria-label') }));
await page.keyboard.press('Escape');
const back = await page.evaluate(() => document.activeElement?.textContent);
console.log(JSON.stringify({ typing, focusAfterClose: back, dialogOpen: await page.getByRole('dialog').count() }));
await browser.close();
