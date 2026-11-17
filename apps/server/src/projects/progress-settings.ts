import { z } from 'zod';
import type { Transaction } from '../firestore.js';
import { PROGRESS_LIMITS, UPDATE_TOPICS, type ProjectUpdateSettings, type UpdateEveryMinutes } from '@minions/contracts';
import { db, projectDocument } from '../firestore.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertProjectWritable } from './access.js';

const every = z.union([z.literal(5), z.literal(15), z.literal(30)]);
const topics = z.array(z.enum(UPDATE_TOPICS)).min(1).max(UPDATE_TOPICS.length).refine(value => new Set(value).size === value.length);
// A field left out keeps its saved value.
export const UPDATE_SETTINGS_INPUT = z.object({
  expectedRevision: z.number().int().nonnegative(),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  everyMinutes: every.optional(), topics: topics.optional(), slides: z.boolean().optional(),
  additionalInstructions: z.string().max(4000).refine(value => [...value].length <= PROGRESS_LIMITS.instructions).optional(),
}).strict();
// Ignore retired fields on existing records (the writing style); new saves write only the current settings.
const RECORD = z.object({
  everyMinutes: every.default(5), topics: topics.default([...UPDATE_TOPICS]), slides: z.boolean().default(true),
  additionalInstructions: z.string().default(''),
  revision: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), updatedByProfileId: z.string() });
const settingsDoc = () => projectDocument<z.infer<typeof RECORD>>('settings/projectUpdates');
const defaults = (): ProjectUpdateSettings => ({ everyMinutes: 5, topics: [...UPDATE_TOPICS], slides: true, additionalInstructions: '', revision: 0, updatedAt: null });
const view = (record: z.infer<typeof RECORD>): ProjectUpdateSettings => ({ everyMinutes: record.everyMinutes as UpdateEveryMinutes, topics: UPDATE_TOPICS.filter(topic => record.topics.includes(topic)), slides: record.slides, additionalInstructions: record.additionalInstructions, revision: record.revision, updatedAt: record.updatedAt });
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
  if (!parsed.success) throw new Refusal('bad_input', `Choose updates every 5, 15 or 30 minutes, at least one kind of update, and at most ${PROGRESS_LIMITS.instructions} characters of instructions.`);
  const data = parsed.data, fingerprint = hashToken(JSON.stringify(data));
  return db.runTransaction(async tx => {
    await manager(tx, profileId);
    const receiptRef = projectDocument<{ fingerprint: string; settings: ProjectUpdateSettings }>(`projectUpdateSettingOperations/${hashToken(profileId + ':' + data.clientRequestId)}`);
    const [receipt, record] = await Promise.all([tx.get(receiptRef), tx.get(settingsDoc())]);
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { ...defaults(), ...receipt.data()!.settings, replayed: true };
    }
    await assertProjectWritable(tx);
    const before = record.exists ? view(RECORD.parse(record.data())) : defaults();
    if (before.revision !== data.expectedRevision) throw new Refusal('proposal_conflict', 'Someone else changed the project update settings. Reload, then save again.');
    const next = { everyMinutes: data.everyMinutes ?? before.everyMinutes, topics: data.topics ?? before.topics, slides: data.slides ?? before.slides, additionalInstructions: data.additionalInstructions ?? before.additionalInstructions, revision: before.revision + 1, updatedAt: now(), updatedByProfileId: profileId };
    const settings = view(next);
    tx.set(settingsDoc(), next); tx.create(receiptRef, { fingerprint, settings });
    return { ...settings, replayed: false };
  });
}
