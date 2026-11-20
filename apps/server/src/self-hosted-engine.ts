// The standalone entry deliberately imports no database-dependent module at module scope.
import { mkdirSync } from 'node:fs';
import express from 'express';
import { selfHostedConfig } from './self-hosted-config.js';
import { assertPrivateDataFile } from './self-hosted-files.js';
import { ENGINE_INITIALIZATION, initializationEvidenceHash, readOwnerConfiguration } from './self-hosted-initialize.js';
import { lockSelfHostedStore } from './self-hosted-lock.js';
import { startSelfHostedRuntime } from './self-hosted-runtime.js';
import { localOwnerSession } from './self-hosted-owner-session.js';
import { engineStopKey, engineStopRoute } from './self-hosted-stop.js';
import { CURRENT_STATE_CUTOVER_RECEIPT, CURRENT_STATE_PROGRESS_SCHEMA, CURRENT_STATE_PROGRESS_EPOCH, USAGE_EPOCH } from './storage/schema.js';

let consumed = false;
/** requestStop runs when `minions stop` asks this engine to stop; the caller owns the shutdown and exit code. */
export async function startSelfHostedEngine({ requestStop }: { requestStop(): void }) {
  const config = selfHostedConfig();
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The standalone engine requires Node.js 24 or newer.');
  const owner = readOwnerConfiguration(config.ownerFile);
  if (consumed) throw new Error('Start each standalone engine in a fresh process; its database and identity are process-wide.');
  assertPrivateDataFile(config.sqlitePath); // Startup never creates or initializes a database.
  const lock = lockSelfHostedStore(config.sqlitePath);
  consumed = true;
  // Use the canonical path both for the lock and the process-wide adapter selection.
  process.env.MINIONS_SQLITE_PATH = lock.file;
  let closeStore: (() => Promise<void>) | undefined;
  let runtime: Awaited<ReturnType<typeof startSelfHostedRuntime>> | undefined;
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
      || evidence.signIn !== 'local-owner' || !/^[a-f0-9]{40}$/.test(evidence.writerSource ?? '')
      || hash !== evidenceSha256 || receipt?.evidenceSha256 !== hash
      || receipt?.writerSource !== evidence.writerSource || receipt?.initialization !== 'empty-self-hosted-store'
      || receipt?.schema !== CURRENT_STATE_PROGRESS_SCHEMA || receipt?.epoch !== CURRENT_STATE_PROGRESS_EPOCH || receipt?.usageEpoch !== USAGE_EPOCH
      || evidence.ownerSubject !== owner.owner.subject || evidence.ownerProfileId !== owner.profileId) {
      throw new Error('Standalone initialization does not match this engine configuration. Existing records were preserved.');
    }
    const profile = (await db.doc(`profiles/${evidence.ownerProfileId}`).get()).data();
    if (!profile || profile.removedAt !== null || profile.email !== owner.owner.email) throw new Error('The initialized owner profile is missing or does not match its private configuration.');
    mkdirSync(config.blobRoot, { recursive: true, mode: 0o700 });
    const { identity, setIdentityProvider } = await import('./identity/index.js');
    const authentication = express.Router();
    let origin = '';
    const { sessionRoutes } = await import('./identity/session-routes.js');
    const { localOwnerIdentity, vouchesForOwnerEmail } = await import('./identity/local-owner.js');
    const provider = localOwnerIdentity({ secret: Buffer.from(owner.signingSecret, 'hex'), owner: owner.owner, validAfter: owner.validAfter });
    setIdentityProvider(provider);
    authentication.use('/local-owner', localOwnerSession({ provider, installed: () => identity() === provider && vouchesForOwnerEmail(identity()), origin: () => origin }));
    authentication.use('/engine/stop', engineStopRoute({ key: engineStopKey(owner.signingSecret), requestStop }));
    authentication.use(sessionRoutes(identity));
    const { createApi } = await import('./api.js');
    const { setDeliveryReviewObserver } = await import('./projects/delivery-review.js');
    const { observeGitHubDelivery } = await import('../../../packages/agent-cli/src/service/github-delivery-review.mjs');
    // Derive check evidence directly from GitHub on this computer. No agent or owner endpoint accepts a provider report.
    setDeliveryReviewObserver(observeGitHubDelivery);
    const { startLocalWorker } = await import('./v2/local-fanout.js');
    const { drainProjectControl } = await import('./projects/project-control.js');
    runtime = await startSelfHostedRuntime({ app: createApi(config.host, authentication, () => origin), host: config.host, port: config.port,
      startWorker: startLocalWorker, drain: drainProjectControl, closeStore });
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('The engine did not open a loopback listener.');
    origin = `http://127.0.0.1:${address.port}`;
    let stopped: Promise<void> | undefined;
    return { url: origin, stop: () => stopped ??= (async () => {
      try { await runtime!.close(); } finally { lock.release(); }
    })() };
  } catch (error) {
    try { if (runtime) await runtime.close(); else await closeStore?.(); }
    finally { lock.release(); }
    throw error;
  }
}
