// The connector runs from this repository checkout with the Node that runs it; nothing is downloaded.
import { fileURLToPath } from 'node:url';

export const CONNECTOR_ENTRY = fileURLToPath(new URL('./cli.mjs', import.meta.url));

/**
 * One line to paste into this platform's usual terminal (PowerShell on Windows, a POSIX shell elsewhere) that runs
 * this checkout's connector. Values are single-quoted, so paths with spaces, quotes, $ or % stay intact.
 */
export function connectorCommand(platform, { node = process.execPath, cli = CONNECTOR_ENTRY, env = {}, args = [] } = {}) {
  if (platform === 'win32') {
    // PowerShell also reads the curly quotes ‘ ’ ‚ ‛ as single quotes; doubling escapes each one.
    const quote = value => `'${String(value).replace(/['‘’‚‛]/g, '$&$&')}'`;
    return `${Object.entries(env).map(([name, value]) => `$env:${name}=${quote(value)}; `).join('')}& ${[node, cli, ...args].map(quote).join(' ')}`;
  }
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [...Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`), ...[node, cli, ...args].map(quote)].join(' ');
}
