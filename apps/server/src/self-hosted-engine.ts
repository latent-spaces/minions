// The standalone entry deliberately imports no database-dependent module at module scope.
import { mkdirSync } from 'node:fs';
import express from 'express';
import { selfHostedConfig } from './self-hosted-config.js';
import { assertPrivateDataFile } from './self-hosted-files.js';
import { ENGINE_INITIALIZATION, initializationEvidenceHash, readOwnerConfiguration } from './self-hosted-initialize.js';
import { lockSelfHostedStore } from './self-hosted-lock.js';
import { startSelfHostedRuntime } from './self-hosted-runtime.js';
import { localOwnerHandoff } from './self-hosted-handoff.js';
import { readGithubOAuthConfig } from './github/oauth-config.js';
import { CURRENT_STATE_CUTOVER_RECEIPT, CURRENT_STATE_PROGRESS_SCHEMA, CURRENT_STATE_PROGRESS_EPOCH, USAGE_EPOCH } from './storage/schema.js';

let consumed = false;
export async function startSelfHostedEngine() {
  const config = selfHostedConfig();
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The standalone engine requires Node.js 24 or newer.');
  const github = config.signIn === 'github' ? readGithubOAuthConfig() : null;
  const owner = config.ownerFile ? readOwnerConfiguration(config.ownerFile) : null;
  if (consumed) throw new Error('Start each standalone engine in a fresh process; its database and identity are process-wide.');
  assertPrivateDataFile(config.sqlitePath); // Startup never creates or initializes a database.
  const lock = lockSelfHostedStore(config.sqlitePath);
  consumed = true;
  // Use the canonical path both for the lock and the process-wide adapter selection.
  process.env.MLSWARM_SQLITE_PATH = lock.file;
  let closeStore: (() => Promise<void>) | undefined;
  let runtime: Awaited<ReturnType<typeof startSelfHostedRuntime>> | undefined;
  let handoff: ReturnType<typeof localOwnerHandoff> | undefined;
  try {
    const { db } = await import('./firestore.js');
    let closingStore: Promise<void> | undefined;
    closeStore = () => closingStore ??= db.terminate();
    const evidence = (await db.doc(ENGINE_INITIALIZATION).get()).data();
    const receipt = (await db.doc(CURRENT_STATE_CUTOVER_RECEIPT).get()).data();
    if (!evidence) throw new Error('The database has no completed standalone initialization. Startup never repairs an existing store.');
    const { evidenceSha256, ...record } = evidence;
    const hash = initializationEvidenceHash(record);
    if (evidence.kind !== 'empty-self-hosted-store' || evidence.schema !== CURRENT_STATE_PROGRESS_SCHEMA
      || evidence.epoch !== CURRENT_STATE_PROGRESS_EPOCH || evidence.usageEpoch !== USAGE_EPOCH
      || evidence.signIn !== config.signIn || !/^[a-f0-9]{40}$/.test(evidence.writerSource ?? '')
      || hash !== evidenceSha256 || receipt?.evidenceSha256 !== hash
      || receipt?.writerSource !== evidence.writerSource || receipt?.initialization !== 'empty-self-hosted-store'
      || receipt?.schema !== CURRENT_STATE_PROGRESS_SCHEMA || receipt?.epoch !== CURRENT_STATE_PROGRESS_EPOCH || receipt?.usageEpoch !== USAGE_EPOCH
      || (owner && (evidence.ownerSubject !== owner.owner.subject || evidence.ownerProfileId !== owner.profileId))) {
      throw new Error('Standalone initialization does not match this engine configuration. Existing records were preserved.');
    }
    const profile = (await db.doc(`profiles/${evidence.ownerProfileId}`).get()).data();
    if (!profile || profile.removedAt !== null || (owner && profile.email !== owner.owner.email)) throw new Error('The initialized owner profile is missing or does not match its private configuration.');
    mkdirSync(config.blobRoot, { recursive: true, mode: 0o700 });
    const { identity, setIdentityProvider } = await import('./identity/index.js');
    const authentication = express.Router();
    let origin = '';
    const { sessionRoutes } = await import('./identity/session-routes.js');
    if (owner) {
      const { localOwnerIdentity, vouchesForOwnerEmail } = await import('./identity/local-owner.js');
      const provider = localOwnerIdentity({ secret: Buffer.from(owner.signingSecret, 'hex'), owner: owner.owner, validAfter: owner.validAfter });
      setIdentityProvider(provider);
      handoff = localOwnerHandoff({ provider, installed: () => identity() === provider && vouchesForOwnerEmail(identity()), origin: () => origin });
      authentication.use('/local-owner', handoff.router);
      authentication.use(sessionRoutes(identity, async () => {}));
    } else {
      const { serverSessionIdentity, endSession } = await import('./identity/server-sessions.js');
      const { githubOAuthRoutes } = await import('./github/oauth.js');
      setIdentityProvider(serverSessionIdentity());
      authentication.use(githubOAuthRoutes(github!, Date.now));
      authentication.use(sessionRoutes(identity, endSession));
    }
    const { createApi } = await import('./api.js');
    const { startLocalWorker } = await import('./v2/local-fanout.js');
    const { drainProjectControl } = await import('./projects/project-control.js');
    runtime = await startSelfHostedRuntime({ app: createApi(config.host, authentication, () => origin), host: config.host, port: config.port,
      startWorker: startLocalWorker, drain: drainProjectControl, closeStore });
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('The engine did not open a loopback listener.');
    origin = `http://127.0.0.1:${address.port}`;
    let stopped: Promise<void> | undefined;
    return { url: origin, stop: () => stopped ??= (async () => {
      handoff?.clear();
      try { await runtime!.close(); } finally { lock.release(); }
    })(), createOwnerHandoff: () => {
      if (stopped) throw new Error('The engine has stopped.');
      if (!handoff) throw new Error('Owner links are available only with local-owner sign-in.');
      return handoff.create();
    } };
  } catch (error) {
    handoff?.clear();
    try { if (runtime) await runtime.close(); else await closeStore?.(); }
    finally { lock.release(); }
    throw error;
  }
}
