// Explicit operator initialization, never called by runtime startup. Existing databases and
// owner files are refused, so this cannot attest to a migration or repair live participant state.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DISPLAY_NAME } from './display-name.js';
import { createOwnerFile, readOwnerFile } from './self-hosted-files.js';
import { absoluteSelfHostedPath } from './self-hosted-paths.js';
import { CURRENT_STATE_CUTOVER_RECEIPT, CURRENT_STATE_PROGRESS_SCHEMA, CURRENT_STATE_PROGRESS_EPOCH, USAGE_EPOCH } from './storage/schema.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const ownerDetails = z.object({ name: DISPLAY_NAME, email: z.email().trim().toLowerCase().max(254) }).strict();
const ownerConfiguration = z.object({ schema: z.literal(1), profileId: identifier,
  owner: ownerDetails.extend({ subject: identifier }).strict(),
  signingSecret: z.string().regex(/^[a-f0-9]{64}$/), validAfter: z.number().int().nonnegative(),
}).strict();
export type OwnerConfiguration = z.infer<typeof ownerConfiguration>;
export type InitialRow = { path: string; data: Record<string, unknown> };
type InitializationStore = { createRows(rows: InitialRow[]): Promise<void>; close(): void | Promise<void> };
export const ENGINE_INITIALIZATION = 'platform/selfHostedInitialization';
export const initializationEvidenceHash = (record: Record<string, unknown>) => createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).digest('hex');

export function readOwnerConfiguration(file: string): OwnerConfiguration {
  const text = readOwnerFile(absoluteSelfHostedPath('MINIONS_OWNER_FILE', file));
  try { return ownerConfiguration.parse(JSON.parse(text)); }
  catch { throw new Error('The private owner configuration is invalid. Existing credentials were not changed.'); }
}

export async function initializeSelfHostedStore({ sqlitePath, ownerFile, sourceRevision, owner, now = Date.now }: {
  sqlitePath: string; ownerFile: string; sourceRevision: string;
  owner: { name: string; email: string }; now?: () => number;
}, openStore: (file: string) => Promise<InitializationStore>) {
  absoluteSelfHostedPath('MINIONS_SQLITE_PATH', sqlitePath);
  absoluteSelfHostedPath('MINIONS_OWNER_FILE', ownerFile);
  if (sqlitePath === ownerFile) throw new Error('The database and owner configuration need separate paths.');
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error('Initialization requires the exact 40-character source revision of this engine build.');
  const details = ownerDetails.safeParse(owner);
  if (!details.success) throw new Error('Provide a valid owner name and email for initialization.');
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('Initialization requires a valid clock.');
  const profileId = `owner-${randomUUID()}`;
  const configuration: OwnerConfiguration = { schema: 1, profileId,
    owner: { ...details.data, subject: `local-${randomUUID()}` }, signingSecret: randomBytes(32).toString('hex'), validAfter: 0 };

  // Exclusive creation is the empty-store proof. Never open an existing SQLite file for initialization.
  createOwnerFile(sqlitePath, '');
  createOwnerFile(ownerFile, `${JSON.stringify(configuration, null, 2)}\n`);
  const evidence = { kind: 'empty-self-hosted-store', initializedAt: at, writerSource: sourceRevision,
    schema: CURRENT_STATE_PROGRESS_SCHEMA, epoch: CURRENT_STATE_PROGRESS_EPOCH, usageEpoch: USAGE_EPOCH,
    signIn: 'local-owner', ownerProfileId: profileId, ownerSubject: configuration.owner.subject };
  const evidenceSha256 = initializationEvidenceHash(evidence);
  const store = await openStore(sqlitePath);
  try {
    // The adapter commits all initialization records together. This grants no platform role.
    await store.createRows([
      { path: `profiles/${profileId}`, data: { ...details.data, removedAt: null } },
      { path: ENGINE_INITIALIZATION, data: { ...evidence, evidenceSha256 } },
      { path: CURRENT_STATE_CUTOVER_RECEIPT, data: { schema: CURRENT_STATE_PROGRESS_SCHEMA,
        epoch: CURRENT_STATE_PROGRESS_EPOCH, usageEpoch: USAGE_EPOCH, writerSource: sourceRevision, evidenceSha256,
        initialization: 'empty-self-hosted-store' } },
    ]);
  } finally { await store.close(); }
  return { profileId, initializedAt: at };
}
