// Screenshots for project updates. The update prompt gives agents this file's path:
//   node shot.cjs <address> <out.png> [<address> <out.png> ...]
// An address is an http(s) URL or a path to a local page. Each image is 1080x1350.
// A local page is served from its own folder on a short-lived 127.0.0.1 port: Chromium does not
// run module scripts from file addresses, so a page that imports its code rendered half-empty.
// It always ends: a stalled lookup or browser is cut off, and the process exits right after the
// last image without closing the browser, which could hang for minutes.
const { spawnSync } = require('node:child_process');
const { existsSync, readFile } = require('node:fs');
const http = require('node:http');
const { fileURLToPath } = require('node:url');
const path = require('node:path');

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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

// Serves one folder, read-only, to this computer only, until the process exits.
function serveFolder(root) {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    const file = path.join(root, name.endsWith('/') ? name + 'index.html' : name);
    if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    readFile(file, (error, body) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(body);
    });
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function addressOf(value, servers) {
  if (/^https?:/i.test(value)) return value;
  const file = path.resolve(/^file:/i.test(value) ? fileURLToPath(value) : value);
  const root = path.dirname(file);
  if (!servers.has(root)) servers.set(root, await serveFolder(root));
  return `http://127.0.0.1:${servers.get(root)}/${encodeURIComponent(path.basename(file))}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.length % 2) fail('Usage: node shot.cjs <address> <out.png> [<address> <out.png> ...]');
  setTimeout(() => fail(`No screenshot within ${LIMIT_MS / 1000} seconds. Run the same command once more.`), LIMIT_MS);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--single-process'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  const servers = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const address = await addressOf(args[index], servers);
    const response = await page.goto(address, { waitUntil: 'load', timeout: 20_000 });
    if (response && !response.ok()) fail(`Screenshot failed: ${args[index]} answered ${response.status()}.`);
    await page.screenshot({ path: path.resolve(args[index + 1]) });
    process.stdout.write(`${args[index + 1]}\n`);
  }
  process.exit(0);
}

main().catch(error => fail(`Screenshot failed: ${error?.message ?? error}`));
