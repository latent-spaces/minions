// Explicit standalone commands. Importing this file is a CLI invocation, never a hosted server side effect.
import { parseArgs } from 'node:util';
import { selfHostedConfig } from './self-hosted-config.js';
import { initializeSelfHostedStore, readOwnerConfiguration } from './self-hosted-initialize.js';
import { lockSelfHostedStore } from './self-hosted-lock.js';
import { standaloneStopSignals } from './self-hosted-runtime.js';

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The standalone engine requires Node.js 24 or newer.');
  const command = process.argv[2];
  if (!['init', 'start', 'check-running'].includes(command ?? '')) throw new Error('Use self-hosted-main.js init, start or check-running. See the self-hosted engine instructions.');
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    'owner-name': { type: 'string' }, 'owner-email': { type: 'string' }, 'source-revision': { type: 'string' }, url: { type: 'string' },
  }, allowPositionals: false });
  const allowed = command === 'init' ? ['owner-name', 'owner-email', 'source-revision'] : command === 'check-running' ? ['url'] : [];
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
  if (command === 'check-running') {
    // Exits 0 only when the engine at this address signs sessions with this owner file's secret. Nothing secret is sent.
    const origin = new URL(values.url ?? `http://127.0.0.1:${config.port}`);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.href !== `${origin.origin}/`) throw new Error('Provide a literal http://127.0.0.1:PORT engine address with --url.');
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
  const engine = await startSelfHostedEngine();
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    // An active worker cannot have its database closed underneath it. A hard timeout reports an unclean stop;
    // its lock remains for explicit operator recovery, instead of pretending all work drained.
    const deadline = setTimeout(() => { console.error('Standalone shutdown did not finish; inspect the database lock before restarting.'); process.exit(1); }, 10_000);
    deadline.unref();
    void engine.stop().then(() => { clearTimeout(deadline); if (process.connected) process.disconnect(); process.exitCode = 0; }, () => {
      clearTimeout(deadline); console.error('Standalone shutdown failed. Inspect its lock and database before restarting.'); if (process.connected) process.disconnect(); process.exitCode = 1;
    });
  };
  for (const signal of standaloneStopSignals(process.platform, process.connected)) process.on(signal, stop);
  // A supervising Node process can request the same graceful shutdown on Windows, where kill(SIGTERM) is abrupt.
  if (process.connected) process.on('message', message => { if (message === 'mlswarm-stop') stop(); });
  console.info(`Standalone engine listening on ${engine.url}. Open ${engine.url}/ on this computer.`);
}
void main().catch(error => {
  // Refusals describe configuration without printing provider responses, tokens, codes, or request bodies.
  console.error(error instanceof Error ? error.message : 'Standalone startup failed.');
  if (process.connected) process.disconnect(); process.exitCode = 1;
});
