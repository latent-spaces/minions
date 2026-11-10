// Decisions for the one-command engine setup, kept free of side effects so both platforms can be tested anywhere.
import path from 'node:path';
import { connectorCommand as checkoutConnectorCommand } from '../../packages/agent-cli/src/connector-command.mjs';

// Test-session settings make the standalone engine refuse to start; a loopback engine also
// must not inherit an enrolled HTTPS origin, a proxy setting or a HOST other than 127.0.0.1.
const REMOVED = ['MLSWARM_TEST_SESSION', 'MLSWARM_TEST_SQLITE_PATH', 'TRUST_PROXY', 'MLSWARM_SELF_HOSTED_ORIGIN', 'HOST', 'PORT', 'NODE_ENV'];

export function requireNode24(version) {
  if (Number(version.replace(/^v/, '').split('.')[0]) < 24) throw new Error(`The engine requires Node.js 24 or newer; this is ${version}.`);
}

/** One private directory holds the engine files and the connector's separate installation. */
export function engineHome({ env, userHome, platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const chosen = env.MLSWARM_ENGINE_HOME ?? paths.join(userHome, '.mlswarm', 'engine');
  if (!paths.isAbsolute(chosen)) throw new Error('MLSWARM_ENGINE_HOME must be an absolute path.');
  return chosen;
}

export function enginePaths(home, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return {
    sqlitePath: paths.join(home, 'engine.sqlite'), blobDir: paths.join(home, 'media'), ownerFile: paths.join(home, 'owner.json'),
    serviceHome: paths.join(home, 'connector-service'), credentialHome: paths.join(home, 'connector-credentials'),
    engineLog: paths.join(home, 'engine.log'),
  };
}

export function enginePort(env) {
  const text = env.MLSWARM_ENGINE_PORT ?? '8787';
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1024 || Number(text) > 65_535) throw new Error('MLSWARM_ENGINE_PORT must be a port from 1024 to 65535.');
  return Number(text);
}

/** Children see the selected Node first on PATH (one PATH key, as Windows ignores case) and no hosted settings. */
export function childEnvironment(env, { nodeDirectory, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const result = {};
  let searchPath = '';
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path') { searchPath = value ?? ''; continue; }
    if (!REMOVED.includes(key)) result[key] = value;
  }
  result.PATH = searchPath ? `${nodeDirectory}${paths.delimiter}${searchPath}` : nodeDirectory;
  return result;
}

export function engineEnvironment(base, { home, port, platform = process.platform }) {
  const files = enginePaths(home, platform);
  return { ...base, MLSWARM_ENGINE: 'self-hosted', MLSWARM_SIGN_IN: 'local-owner', HOST: '127.0.0.1', PORT: String(port),
    MLSWARM_SQLITE_PATH: files.sqlitePath, MLSWARM_BLOB_DIR: files.blobDir, MLSWARM_OWNER_FILE: files.ownerFile };
}

export function connectorEnvironment(base, { home, port, platform = process.platform }) {
  const files = enginePaths(home, platform);
  return { ...base, MLSWARM_SERVICE_HOME: files.serviceHome, MLSWARM_CREDENTIAL_HOME: files.credentialHome, MLSWARM_SITE_URL: `http://127.0.0.1:${port}` };
}

/** The owner's name and email come from the command line, or from the Git identity of the person running it. */
export function ownerIdentity(values, gitConfig) {
  const name = values['owner-name'] ?? gitConfig('user.name'), email = values['owner-email'] ?? gitConfig('user.email');
  if (!name || !email) throw new Error('First-time initialization needs --owner-name and --owner-email (or a Git user.name and user.email).');
  return { name, email, fromGit: !values['owner-name'] || !values['owner-email'] };
}

/** How this desktop opens a page. The sign-in link holds a one-time code, so it is opened, never printed. */
export function pageOpener(platform, env) {
  if (env.MLSWARM_NO_BROWSER || env.CI || env.SSH_CONNECTION || env.SSH_TTY || (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return null;
  return platform === 'darwin' ? ['open'] : platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open'];
}

/** The engine prints this line once it listens; the sign-in link itself goes to the private link file, not stdout. */
export function engineUrl(output) {
  return /Standalone engine listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? null;
}

/**
 * npm writes node_modules/.package-lock.json only when an install completes, and `npm ci` removes node_modules
 * first, so a missing or older hidden lockfile means a partial install or changed dependencies. Times in ms or null.
 */
export function needsInstall({ hiddenLockfile, lockfile }) {
  return hiddenLockfile === null || lockfile === null || hiddenLockfile < lockfile;
}

/**
 * Initialization creates the empty database file first, then the owner file, then commits its records. Only both
 * files together are a store the engine may verify at startup; one without the other is an interrupted first run.
 */
export function initializationState({ database, owner }) {
  return database && owner ? 'existing' : !database && !owner ? 'new' : 'incomplete';
}

/** The connector passes on a Ctrl+C read in raw mode as SIGINT on POSIX and as exit code 130 on Windows. */
export function interruptedByUser({ code, signal } = {}) {
  return signal === 'SIGINT' || code === 130;
}

/** Recovery advice for known engine startup refusals, from its error output. Nothing is removed for the person. */
export function startupHint(output, { home, sqlitePath }) {
  if (/no completed standalone initialization/.test(output)) {
    return ` An earlier first run stopped before initialization finished. If nothing in ${home} needs keeping, remove that directory (or choose a new MLSWARM_ENGINE_HOME) and run npm run setup again.`;
  }
  if (/standalone database is locked/.test(output)) {
    return ` If no engine is running (for example after a crash or restart), remove ${sqlitePath}.lock and run npm run setup again.`;
  }
  return '';
}

/** The checkout connector's command line against this installation's service and credential folders. */
export function connectorCommand(platform, { node, cli, serviceHome, credentialHome, args }) {
  return checkoutConnectorCommand(platform, { node, cli, args, env: { MLSWARM_SERVICE_HOME: serviceHome, MLSWARM_CREDENTIAL_HOME: credentialHome } });
}
