// Project previews served by the shared local service, which outlives agent runs. A server an agent starts
// itself stops when its run ends and the Preview tab is left on a dead link (owner, 13 November 2026:
// “an agent's preview dies with its run”). The service serves plain web files from inside the agent's working
// folder on this computer's loopback address, so the preview keeps working after the run ends.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { lstatExists, pathInside, readPrivate, writePrivate } from '../state.mjs';
import { RuntimeError } from './contracts.mjs';

export const PREVIEW_TOOL = {
  name: 'serve_project_preview',
  description: 'Show plain web files from your working folder, such as an HTML5 game or a static site, in the project’s Preview tab. MyLittleSwarm on this computer serves the folder at http://127.0.0.1:PORT/ and keeps serving it after your run ends, so the preview keeps working; a server you start yourself stops when your run ends. It serves the files as they are in your working folder, so people see your latest saved changes when they reload. It sets the project preview for you. For a project with a build step, build it to static files first and pass the output folder (for example dist). Files and folders whose names start with a dot are never served. Only people on this computer can open it.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    folder: { type: 'string', maxLength: 512, description: 'The folder to serve, relative to your working folder, for example "" (the working folder itself), "web" or "dist". Default: the working folder.' },
    page: { type: 'string', maxLength: 512, description: 'The page to open, relative to that folder. Default: index.html.' },
  } },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const refused = message => { throw new RuntimeError('bad_input', message); };

// One path segment a browser asked for, or the agent named. Dot names (.git, .env), Windows stream (“a:b”)
// and device-alias spellings (trailing dot or space) and separators inside a segment are refused on every platform.
const safeSegment = part => part !== '' && !part.startsWith('.') && !/[\\/:\0*?"<>|]/.test(part) && !/[. ]$/.test(part)
  && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part);
export function relativeSegments(value, what) {
  if (typeof value !== 'string' || value.length > 512) refused(`Use a ${what} relative to your working folder.`);
  const parts = value.replace(/^\.\/+/, '').split('/').filter(part => part !== '' && part !== '.');
  if (parts.some(part => !safeSegment(part))) refused(`Use a ${what} inside your working folder, with / between names and no names that start with a dot.`);
  return parts;
}

export function createProjectPreviews({ home, host = '127.0.0.1', log = () => {} }) {
  const file = home ? join(home, 'previews.json') : null;
  const servers = new Map();
  let closed = false;
  const saved = () => {
    try { return file && lstatExists(file) ? readPrivate(file, true)?.projects ?? {} : {}; }
    catch (error) { log(`Saved previews could not be read: ${error.message}`); return {}; }
  };
  const save = () => {
    if (!file) return;
    const projects = Object.fromEntries([...servers].map(([projectId, item]) => [projectId, { agentId: item.agentId, folder: item.folder, root: item.root, page: item.page, port: item.port }]));
    writePrivate(file, { schemaVersion: 1, projects });
  };

  async function handle(item, req, res) {
    const fail = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
    // A page elsewhere could reach this port by a DNS name that resolves to 127.0.0.1; answer only the loopback names.
    if (![`127.0.0.1:${item.port}`, `localhost:${item.port}`].includes(req.headers.host ?? '')) return fail(421, 'Wrong host.');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return fail(405, 'Only reading is allowed.'); }
    let parts;
    try { parts = new URL(req.url ?? '/', 'http://preview').pathname.split('/').slice(1).map(decodeURIComponent); } catch { return fail(400, 'Bad path.'); }
    const directory = parts.length === 0 || parts.at(-1) === '';
    if (directory) parts = parts.slice(0, -1);
    if (parts.some(part => !safeSegment(part))) return fail(404, 'Not found.');
    try {
      let path = await realpath(join(item.root, ...parts));
      if (!pathInside(item.root, path)) return fail(404, 'Not found.');
      let info = await stat(path);
      if (info.isDirectory()) {
        // Relative links on the page resolve against the folder only when the address ends with “/”.
        if (!directory) { res.writeHead(301, { Location: `${new URL(req.url, 'http://preview').pathname}/`, 'Cache-Control': 'no-store' }); return res.end(); }
        path = await realpath(join(path, 'index.html'));
        if (!pathInside(item.root, path)) return fail(404, 'Not found.');
        info = await stat(path);
      }
      if (!info.isFile()) return fail(404, 'Not found.');
      res.writeHead(200, { 'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size,
        // Agents keep editing these files: a reload always shows the latest saved version.
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) fail(404, 'Not found.'); else res.destroy(); }
  }

  function listen(item, port) {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { handle(item, req, res).catch(() => res.destroy()); });
      server.once('error', reject);
      server.listen({ port, host, exclusive: true }, () => { server.off('error', reject); server.on('error', () => {}); resolve(server); });
    });
  }
  async function stopServer(item) {
    await new Promise(resolve => { item.server.close(() => resolve()); item.server.closeAllConnections?.(); });
  }
  const urlFor = item => `http://${host}:${item.port}/${item.page.map(encodeURIComponent).join('/')}`;

  // Serves `folder`/`root` for one project and returns the page address. The port stays the same for the project
  // while it is free, so a saved preview link keeps working when the service restarts.
  async function serve({ projectId, agentId, folder, root = '', page = 'index.html' }) {
    if (closed) refused('MyLittleSwarm on this computer is closing.');
    const rootParts = relativeSegments(root, 'folder'), pageParts = relativeSegments(page, 'page');
    if (!pageParts.length) pageParts.push('index.html');
    let base, served;
    try { base = await realpath(folder); served = await realpath(join(base, ...rootParts)); }
    catch { refused('That folder does not exist in your working folder.'); }
    if (!pathInside(base, served) || !(await stat(served)).isDirectory()) refused('Choose a folder inside your working folder.');
    try {
      const target = await realpath(join(served, ...pageParts));
      if (!pathInside(served, target) || !(await stat(target)).isFile()) throw new Error();
    } catch { refused(`There is no page ${pageParts.join('/')} in that folder yet. Save it first.`); }
    const previous = servers.get(projectId), port = previous?.port ?? saved()[projectId]?.port ?? 0;
    if (previous) { await stopServer(previous); servers.delete(projectId); }
    const item = { agentId, folder: base, root: served, page: pageParts, port };
    try { item.server = await listen(item, port); }
    catch (error) { if (!port) throw error; item.server = await listen(item, 0); }
    item.port = item.server.address().port;
    servers.set(projectId, item);
    save();
    return { url: urlFor(item), root: served };
  }
  // After a restart, serve again what was served before, when the same agent's folder still holds it.
  async function restore({ folderFor }) {
    for (const [projectId, entry] of Object.entries(saved())) {
      try {
        const folder = folderFor({ projectId, agentId: entry.agentId });
        if (!folder || servers.has(projectId) || !Array.isArray(entry.page)) continue;
        const base = await realpath(folder), served = await realpath(entry.root);
        if (base !== entry.folder || !pathInside(base, served)) continue;
        const item = { agentId: entry.agentId, folder: base, root: served, page: entry.page, port: entry.port };
        item.server = await listen(item, entry.port);
        servers.set(projectId, item);
      } catch (error) { log(`The preview of project ${projectId} could not be served again: ${error.message}`); }
    }
  }
  return {
    serve, restore,
    servedUrl: projectId => { const item = servers.get(projectId); return item ? urlFor(item) : null; },
    async stop(projectId) { const item = servers.get(projectId); if (!item) return; servers.delete(projectId); await stopServer(item); save(); },
    async close() { closed = true; await Promise.all([...servers.values()].map(stopServer)); servers.clear(); },
  };
}
