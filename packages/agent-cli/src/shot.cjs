// Screenshots for project updates. The update prompt gives agents this file's path:
//   node shot.cjs <address> <out.png> [<address> <out.png> ...]
// An address is an http(s) or file URL, or a path to a local page. Each image is 1080x1350.
// It always ends: a stalled lookup or browser is cut off, and the process exits right after the
// last image without closing the browser, which could hang for minutes.
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIMIT_MS = 60_000;
const LOOKUP_MS = 20_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// npx puts the package's .bin folder on PATH for the command it runs; the module sits beside it.
function playwrightFromNpx(extra) {
  const print = 'process.stdout.write(process.env.PATH)';
  const options = { encoding: 'utf8', timeout: LOOKUP_MS, windowsHide: true };
  // npx is npx.cmd on Windows, which only starts through the shell; the command line is fixed text.
  const found = process.platform === 'win32'
    ? spawnSync(`npx ${extra.join(' ')} -y -p playwright node -e "${print}"`, { ...options, shell: true })
    : spawnSync('npx', [...extra, '-y', '-p', 'playwright', 'node', '-e', print], options);
  for (const dir of String(found.stdout ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, '..', 'playwright');
    if (dir.endsWith('.bin') && existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function loadPlaywright() {
  try { return require('playwright'); } catch {}
  // The cached copy first: it needs no registry answer. Then once more, allowing a download.
  const found = playwrightFromNpx(['--prefer-offline']) ?? playwrightFromNpx([]);
  if (!found) fail('Could not find Playwright with npx. Run the same command once more.');
  return require(found);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.length % 2) fail('Usage: node shot.cjs <address> <out.png> [<address> <out.png> ...]');
  setTimeout(() => fail(`No screenshot within ${LIMIT_MS / 1000} seconds. Run the same command once more.`), LIMIT_MS);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--single-process'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  for (let index = 0; index < args.length; index += 2) {
    const address = /^(https?|file):/i.test(args[index]) ? args[index] : pathToFileURL(path.resolve(args[index])).href;
    await page.goto(address, { waitUntil: 'load', timeout: 20_000 });
    await page.screenshot({ path: path.resolve(args[index + 1]) });
    process.stdout.write(`${args[index + 1]}\n`);
  }
  process.exit(0);
}

main().catch(error => fail(`Screenshot failed: ${error?.message ?? error}`));
