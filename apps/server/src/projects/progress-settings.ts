import { z } from 'zod';
import type { Transaction } from '../firestore.js';
import type { ProjectUpdateSettings } from '@mlswarm/contracts';
import { db, projectDocument } from '../firestore.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertProjectWritable } from './access.js';

export const UPDATE_SETTINGS_INPUT = z.object({
  expectedRevision: z.number().int().nonnegative(),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  writingStyle: z.enum(['brief', 'detailed']),
  additionalInstructions: z.string().max(8000).refine(value => [...value].length <= 4000).optional(),
}).strict();
// Ignore retired fields on existing records; new saves write only the current settings.
const RECORD = z.object({
  writingStyle: z.enum(['brief', 'detailed']).default('brief'),
  additionalInstructions: z.string().default(''),
  revision: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), updatedByProfileId: z.string() });
const settingsDoc = () => projectDocument<z.infer<typeof RECORD>>('settings/projectUpdates');
const defaults = (): ProjectUpdateSettings => ({ writingStyle: 'brief', additionalInstructions: '', revision: 0, updatedAt: null });
const view = (record: z.infer<typeof RECORD>): ProjectUpdateSettings => ({ writingStyle: record.writingStyle, additionalInstructions: record.additionalInstructions, revision: record.revision, updatedAt: record.updatedAt });
async function manager(tx: Transaction, profileId: string) {
  const role = await assertMembership(tx, profileId);
  if (role !== 'owner') throw new Refusal('forbidden', 'Only the owner can change project update settings.');
}
// Caller has already checked project-agent access. No cache: changes reach the next context read.
export async function effectiveProjectUpdateSettings(tx?: Transaction): Promise<ProjectUpdateSettings> {
  const record = (await (tx ? tx.get(settingsDoc()) : settingsDoc().get())).data();
  return record === undefined ? defaults() : view(RECORD.parse(record));
}
export async function readProjectUpdateSettings(profileId: string): Promise<ProjectUpdateSettings> {
  return db.runTransaction(async tx => {
    await manager(tx, profileId);
    const record = (await tx.get(settingsDoc())).data();
    return record === undefined ? defaults() : view(RECORD.parse(record));
  });
}
export async function saveProjectUpdateSettings(profileId: string, input: unknown, now: () => number) {
  const parsed = UPDATE_SETTINGS_INPUT.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', 'Choose brief or detailed updates and use at most 4000 characters for additional instructions.');
  const data = parsed.data, fingerprint = hashToken(JSON.stringify(data));
  return db.runTransaction(async tx => {
    await manager(tx, profileId);
    const receiptRef = projectDocument<{ fingerprint: string; settings: ProjectUpdateSettings }>(`projectUpdateSettingOperations/${hashToken(profileId + ':' + data.clientRequestId)}`);
    const [receipt, record] = await Promise.all([tx.get(receiptRef), tx.get(settingsDoc())]);
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { writingStyle: receipt.data()!.settings.writingStyle ?? 'brief', additionalInstructions: receipt.data()!.settings.additionalInstructions ?? '', revision: receipt.data()!.settings.revision, updatedAt: receipt.data()!.settings.updatedAt, replayed: true };
    }
    await assertProjectWritable(tx);
    const before = record.exists ? view(RECORD.parse(record.data())) : defaults();
    if (before.revision !== data.expectedRevision) throw new Refusal('proposal_conflict', 'Someone else changed the project update settings. Reload, then save again.');
    const next = { writingStyle: data.writingStyle, additionalInstructions: data.additionalInstructions ?? before.additionalInstructions, revision: before.revision + 1, updatedAt: now(), updatedByProfileId: profileId };
    const settings = view(next);
    tx.set(settingsDoc(), next); tx.create(receiptRef, { fingerprint, settings });
    return { ...settings, replayed: false };
  });
}
