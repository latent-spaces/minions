import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { nativeTasksEnabled, type NativeTaskSettings } from '@mlswarm/contracts';
import { hashToken } from '../auth.js';
import { db, projectCollection, projectDoc } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertProjectWritable } from './access.js';

export const NATIVE_TASK_SETTINGS_INPUT = z.object({ clientRequestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), enabled: z.boolean() }).strict();
/** No cache: callers read the setting at existing safe request/transaction boundaries. */
export async function effectiveNativeTaskSettings(tx?: Transaction): Promise<NativeTaskSettings> {
  const record = (await (tx ? tx.get(projectDoc()) : projectDoc().get())).data();
  if (!record) throw new Refusal('not_found', 'This project is unavailable.');
  return { enabled: nativeTasksEnabled(record.nativeTasks), revision: record.nativeTasks?.revision ?? 0 };
}
export async function assertNativeTasksEnabled(tx: Transaction) {
  if (!(await effectiveNativeTaskSettings(tx)).enabled) throw new Refusal('tasks_disabled', 'Native tasks are turned off for this project. Existing tasks remain readable; continue approved work through project conversations and results.');
}
export async function readNativeTaskSettings(profileId: string): Promise<NativeTaskSettings> {
  return db.runTransaction(async tx => { await assertMembership(tx, profileId); return effectiveNativeTaskSettings(tx); });
}
export async function saveNativeTaskSettings(profileId: string, value: unknown, now: () => number = Date.now): Promise<NativeTaskSettings> {
  const parsed = NATIVE_TASK_SETTINGS_INPUT.safeParse(value);
  if (!parsed.success) throw new Refusal('bad_input', 'Supply enabled, the current setting revision and a stable request UUID.');
  const input = parsed.data, fingerprint = hashToken(JSON.stringify(input));
  return db.runTransaction(async tx => {
    const role = await assertMembership(tx, profileId);
    if (role !== 'owner') throw new Refusal('forbidden', 'Only the project owner can change task settings.');
    const ref = projectCollection<{ fingerprint: string; settings: NativeTaskSettings; actorProfileId: string }>('nativeTaskSettingOperations').doc(hashToken(`${profileId}:${input.clientRequestId}`));
    const receipt = (await tx.get(ref)).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was used with different task settings.');
      return receipt.settings;
    }
    await assertProjectWritable(tx);
    const before = await effectiveNativeTaskSettings(tx);
    if (before.revision !== input.expectedRevision) throw new Refusal('intent_conflict', 'Task settings changed. Read the current setting, then save again.');
    const settings = { enabled: input.enabled, revision: before.revision + 1 };
    tx.update(projectDoc(), { nativeTasks: settings });
    tx.create(ref, { fingerprint, settings, actorProfileId: profileId });
    tx.create(projectCollection('nativeTaskSettingHistory').doc(String(settings.revision).padStart(16, '0')), { before, settings, actorProfileId: profileId, at: now() });
    return settings;
  });
}
