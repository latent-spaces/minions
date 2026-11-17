import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { trustedWebsiteUrl } from './website-origin.mjs';

export function verifyBundle() {
  const root = fileURLToPath(new URL('../runtime/', import.meta.url));
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); }
  catch { throw new Error('Packaged runtime missing. Build or reinstall this package before preparing an agent.'); }
  const names = ['project-operations.mjs', 'work-controller.mjs', 'providers.mjs', 'claude-settings.json', 'AGENT_PROMPT_V2.md', 'project-tools.json', 'worker-guides.json'];
  if (Object.keys(manifest.files ?? {}).sort().join() !== [...names].sort().join()) throw new Error('Invalid packaged runtime manifest.');
  const files = {};
  for (const name of names) {
    const content = readFileSync(join(root, name));
    if (createHash('sha256').update(content).digest('hex') !== manifest.files[name]) throw new Error('Packaged runtime integrity check failed. Reinstall the package.');
    files[name] = content;
  }
  return { files, fingerprint: createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') };
}

// No desktop to open a page on: remote shells, CI, and Linux without a display.
export const canOpenPages = ({ platform = process.platform, env = process.env } = {}) =>
  !(env.MINIONS_NO_BROWSER || env.CI || env.SSH_CONNECTION || env.SSH_TTY || (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY));
// Opens only a Minions page or GitHub's sign-in code page, in the person's default browser. Returns whether an
// attempt was made; the caller still shows the link, because a launched command is not proof that a page appeared.
export function openPage(address, { platform = process.platform, env = process.env, spawnImpl = spawn } = {}) {
  let url;
  try { url = new URL(address); } catch { return false; }
  const minions = trustedWebsiteUrl(url) && (url.pathname === '/' || /^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname));
  if (!minions && url.href !== 'https://github.com/login/device' || !canOpenPages({ platform, env })) return false;
  const [command, args] = platform === 'darwin' ? ['open', [url.href]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url.href]] : ['xdg-open', [url.href]];
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {}); child.unref?.();
    return true;
  } catch { return false; }
}
