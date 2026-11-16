import type { Transaction } from '../firestore.js';
import { z } from 'zod';
import { nativeTeamsEnabled, type NativeTeamSettings } from '@minions/contracts';
import { hashToken } from '../auth.js';
import { db, projectCollection, projectDoc } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership, assertProjectWritable } from './access.js';

export const NATIVE_TEAM_SETTINGS_INPUT = z.object({ clientRequestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), enabled: z.boolean() }).strict();
/** No cache: callers read the setting at existing safe request/transaction boundaries. */
export async function effectiveNativeTeamSettings(tx?: Transaction): Promise<NativeTeamSettings> {
  const record = (await (tx ? tx.get(projectDoc()) : projectDoc().get())).data();
  if (!record) throw new Refusal('not_found', 'This project is unavailable.');
  return { enabled: nativeTeamsEnabled(record.nativeTeams), revision: record.nativeTeams?.revision ?? 0 };
}
export async function assertNativeTeamsEnabled(tx: Transaction) {
  if (!(await effectiveNativeTeamSettings(tx)).enabled) throw new Refusal('teams_disabled', 'Native teams are turned off for this project. Existing teams and memberships remain readable; tasks and agent execution are unchanged.');
}
export async function readNativeTeamSettings(profileId: string): Promise<NativeTeamSettings> {
  return db.runTransaction(async tx => { await assertMembership(tx, profileId); return effectiveNativeTeamSettings(tx); });
}
export async function saveNativeTeamSettings(profileId: string, value: unknown, now: () => number = Date.now): Promise<NativeTeamSettings> {
  const parsed = NATIVE_TEAM_SETTINGS_INPUT.safeParse(value);
  if (!parsed.success) throw new Refusal('bad_input', 'Supply enabled, the current setting revision and a stable request UUID.');
  const input = parsed.data, fingerprint = hashToken(JSON.stringify(input));
  return db.runTransaction(async tx => {
    const role = await assertMembership(tx, profileId);
    if (role !== 'owner') throw new Refusal('forbidden', 'Only the project owner can change team settings.');
    const ref = projectCollection<{ fingerprint: string; settings: NativeTeamSettings; actorProfileId: string }>('nativeTeamSettingOperations').doc(hashToken(`${profileId}:${input.clientRequestId}`));
    const receipt = (await tx.get(ref)).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was used with different team settings.');
      return receipt.settings;
    }
    await assertProjectWritable(tx);
    const before = await effectiveNativeTeamSettings(tx);
    if (before.revision !== input.expectedRevision) throw new Refusal('intent_conflict', 'Team settings changed. Read the current setting, then save again.');
    const settings = { enabled: input.enabled, revision: before.revision + 1 };
    tx.update(projectDoc(), { nativeTeams: settings });
    tx.create(ref, { fingerprint, settings, actorProfileId: profileId });
    tx.create(projectCollection('nativeTeamSettingHistory').doc(String(settings.revision).padStart(16, '0')), { before, settings, actorProfileId: profileId, at: now() });
    return settings;
  });
}
