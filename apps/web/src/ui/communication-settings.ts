import { COMMUNICATION_BOUNDS as B, type CommunicationFields, type CommunicationSettings } from '@minions/contracts';

export type CommunicationDraft = { broadcastAllowed: 'allow' | 'deny'; sendsPerHour: string;
  minimumGapSeconds: string; broadcastsPerHour: string; sharedBroadcastsPerHour: string };
export function validateCommunicationSettings(value: CommunicationSettings) {
  const integer = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
  const fields = (f: CommunicationFields | undefined): boolean => !!f && typeof f.broadcastAllowed === 'boolean'
    && integer(f.sendsPerHour, 1, B.sendsPerHour) && integer(f.minimumGapSeconds, B.minimumGapSeconds, B.maximumGapSeconds)
    && integer(f.broadcastsPerHour, 1, B.broadcastsPerHour);
  const config = value?.configuration;
  if (typeof value?.canEditDefaults !== 'boolean' || !fields(value.effective)
    || !integer(value.effective.sharedBroadcastsPerHour, 1, B.broadcastsPerHour) || !integer(value.effective.projectRevision, 0)
    || !config || !fields(config.defaults) || config.projectRevision !== value.effective.projectRevision
    || config.sharedBroadcastsPerHour !== value.effective.sharedBroadcastsPerHour)
    throw new Error('The settings response was incomplete. Load saved settings before editing.');
  return value;
}
export function communicationDraft(saved: CommunicationSettings): CommunicationDraft {
  const fields = saved.configuration.defaults;
  return { broadcastAllowed: fields.broadcastAllowed ? 'allow' : 'deny', sendsPerHour: fields.sendsPerHour.toString(),
    minimumGapSeconds: fields.minimumGapSeconds.toString(), broadcastsPerHour: fields.broadcastsPerHour.toString(),
    sharedBroadcastsPerHour: saved.configuration.sharedBroadcastsPerHour.toString() };
}
export function communicationEdit(saved: CommunicationSettings, draft: CommunicationDraft) {
  if (!saved.canEditDefaults) throw new Error('Editing is unavailable.');
  const fields = { broadcastAllowed: draft.broadcastAllowed === 'allow' } as CommunicationFields;
  const limits = { sendsPerHour: [1, B.sendsPerHour], minimumGapSeconds: [B.minimumGapSeconds, B.maximumGapSeconds], broadcastsPerHour: [1, B.broadcastsPerHour] };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const text = draft[key].trim(), [min, max] = limits[key], number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max)
      throw new Error(`Enter a whole number from ${min} to ${max}.`);
    fields[key] = number;
  }
  const shared = Number(draft.sharedBroadcastsPerHour);
  if (!/^\d+$/.test(draft.sharedBroadcastsPerHour) || !Number.isSafeInteger(shared) || shared < 1 || shared > B.broadcastsPerHour)
    throw new Error(`The shared project allowance must be from 1 to ${B.broadcastsPerHour}.`);
  return { expectedRevision: saved.configuration.projectRevision, defaults: fields, sharedBroadcastsPerHour: shared };
}
