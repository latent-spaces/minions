// Explicit standalone commands. Importing this file is a CLI invocation, never a hosted server side effect.
import { parseArgs } from 'node:util';
import { selfHostedConfig } from './self-hosted-config.js';
import { initializeSelfHostedStore, readOwnerConfiguration } from './self-hosted-initialize.js';
import { lockedMessage, lockSelfHostedStore } from './self-hosted-lock.js';
import { standaloneStopSignals } from './self-hosted-runtime.js';

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The standalone engine requires Node.js 24 or newer.');
  const command = process.argv[2];
  if (!['init', 'start', 'check-running', 'stop'].includes(command ?? '')) throw new Error('Use self-hosted-main.js init, start, check-running or stop. See the self-hosted engine instructions.');
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    'owner-name': { type: 'string' }, 'owner-email': { type: 'string' }, 'source-revision': { type: 'string' }, url: { type: 'string' },
  }, allowPositionals: false });
  const allowed = command === 'init' ? ['owner-name', 'owner-email', 'source-revision'] : command === 'check-running' || command === 'stop' ? ['url'] : [];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error('An option does not belong to this standalone command.');
  const config = selfHostedConfig();
  if (command === 'init') {
    const lock = lockSelfHostedStore(config.sqlitePath);
    try {
      const result = await initializeSelfHostedStore({ ...config, sqlitePath: lock.file,
        sourceRevision: values['source-revision'] ?? '', owner: { name: values['owner-name'] ?? '', email: values['owner-email'] ?? '' } }, async file => {
        const { SqliteFirestore } = await import('./storage/sqlite-firestore.js');
        const store = new SqliteFirestore(file);
        return { createRows: async rows => {
          const batch = store.batch(); for (const row of rows) batch.create(store.doc(row.path), row.data); await batch.commit();
        }, close: () => store.close() };
      });
      console.info(`Standalone database initialized with owner profile ${result.profileId}. Start it with the same file settings.`);
    } finally { lock.release(); }
    return;
  }
  const origin = new URL(values.url ?? `http://127.0.0.1:${config.port}`);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.href !== `${origin.origin}/`) throw new Error('Provide a literal http://127.0.0.1:PORT engine address with --url.');
  if (command === 'stop') {
    await stopRunningEngine(origin.origin, readOwnerConfiguration(config.ownerFile).signingSecret, `${config.sqlitePath}.lock`);
    return;
  }
  if (command === 'check-running') {
    // Exits 0 only when the engine at this address signs sessions with this owner file's secret. Nothing secret is sent.
    const owner = readOwnerConfiguration(config.ownerFile);
    const { localOwnerIdentity } = await import('./identity/local-owner.js');
    const provider = localOwnerIdentity({ secret: Buffer.from(owner.signingSecret, 'hex'), owner: owner.owner, validAfter: owner.validAfter });
    const response = await fetch(`${origin.origin}/api/auth/local-owner/session`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { origin: origin.origin, 'content-type': 'application/json' }, body: '{}' });
    const token = response.ok ? (await response.json() as { token?: unknown }).token : null;
    if (typeof token !== 'string' || !await provider.verifySession(token)) throw new Error('No engine with this owner file answers at that address.');
    return;
  }
  const { startSelfHostedEngine } = await import('./self-hosted-engine.js');
  let engine: Awaited<ReturnType<typeof startSelfHostedEngine>> | undefined;
  let stopping = false, stopRequested = false;
  const stop = () => {
    // A stop request can arrive while startup finishes; it runs as soon as the engine handle exists.
    if (!engine) { stopRequested = true; return; }
    if (stopping) return; stopping = true;
    // An active worker cannot have its database closed underneath it. A hard timeout reports an unclean stop; its
    // lock stays behind and the next start replaces it once this process is gone, instead of pretending work drained.
    const deadline = setTimeout(() => { console.error('Standalone shutdown did not finish; inspect the database lock before restarting.'); process.exit(1); }, 10_000);
    deadline.unref();
    void engine.stop().then(() => { clearTimeout(deadline); if (process.connected) process.disconnect(); process.exitCode = 0; }, () => {
      clearTimeout(deadline); console.error('Standalone shutdown failed. Inspect its lock and database before restarting.'); if (process.connected) process.disconnect(); process.exitCode = 1;
    });
  };
  for (const signal of standaloneStopSignals(process.platform, process.connected)) process.on(signal, stop);
  engine = await startSelfHostedEngine({ requestStop: stop });
  // A supervising Node process can request the same graceful shutdown on Windows, where kill(SIGTERM) is abrupt.
  if (process.connected) process.on('message', message => { if (message === 'minions-stop') stop(); });
  console.info(`Standalone engine listening on ${engine.url}. Open ${engine.url}/ on this computer.`);
  if (stopRequested) stop();
}
/**
 * Asks the engine at this address to stop, then waits up to 20 s for its database lock to go: the engine removes it at
 * the end of a clean stop. (Whether the port still answers proves nothing; another program may share it.)
 */
async function stopRunningEngine(origin: string, signingSecret: string, lock: string) {
  const { engineStopKey } = await import('./self-hosted-stop.js');
  const { existsSync } = await import('node:fs');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/auth/engine/stop`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${engineStopKey(signingSecret)}` } });
  } catch {
    console.info(`No engine answered at ${origin}.`);
    // Startup and shutdown can hold the database lock without a listening endpoint.
    if (existsSync(lock)) throw new Error(lockedMessage(lock));
    return;
  }
  if (response.status !== 202) throw new Error(`The program at ${origin} is not this engine or refused the stop request (HTTP ${response.status}). Nothing was stopped.`);
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    if (!existsSync(lock)) { console.info(`The engine at ${origin} stopped.`); return; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`The engine at ${origin} accepted the stop request but has not finished stopping after 20 seconds. Its log says why.`);
}

void main().catch(error => {
  // Refusals describe configuration without printing provider responses, tokens, codes, or request bodies.
  console.error(error instanceof Error ? error.message : 'Standalone startup failed.');
  if (process.connected) process.disconnect(); process.exitCode = 1;
});
