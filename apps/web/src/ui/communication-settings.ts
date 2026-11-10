import { COMMUNICATION_BOUNDS as B, type CommunicationFields, type CommunicationSettings } from '@mlswarm/contracts';

export type CommunicationMode = 'agent' | 'project';
export type CommunicationDraft = { broadcastAllowed: 'inherit' | 'allow' | 'deny'; sendsPerHour: string;
  minimumGapSeconds: string; broadcastsPerHour: string; sharedBroadcastsPerHour: string };
export function validateCommunicationSettings(value: CommunicationSettings, agentId: string | null) {
  const integer = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
  const fields = (f: Partial<CommunicationFields> | undefined, partial = false): boolean => !!f &&
    (partial && f.broadcastAllowed === undefined || typeof f.broadcastAllowed === 'boolean') &&
    (partial && f.sendsPerHour === undefined || integer(f.sendsPerHour, 1, B.sendsPerHour)) &&
    (partial && f.minimumGapSeconds === undefined || integer(f.minimumGapSeconds, B.minimumGapSeconds, B.maximumGapSeconds)) &&
    (partial && f.broadcastsPerHour === undefined || integer(f.broadcastsPerHour, 1, B.broadcastsPerHour));
  const config = value?.configuration;
  if (value?.agentId !== agentId || typeof value.canEditAgent !== 'boolean' || typeof value.canEditDefaults !== 'boolean'
    || !fields(value.effective) || !integer(value.effective.sharedBroadcastsPerHour, 1, B.broadcastsPerHour)
    || !integer(value.effective.projectRevision, 0) || !integer(value.effective.overrideRevision, 0)
    || !Array.isArray(value.overriddenFields) || value.overriddenFields.some(key => !['broadcastAllowed', 'sendsPerHour', 'minimumGapSeconds', 'broadcastsPerHour'].includes(key))
    || (value.canEditAgent || value.canEditDefaults) && !config
    || config && (!fields(config.defaults) || !fields(config.overrideFields, true)
      || config.projectRevision !== value.effective.projectRevision || config.overrideRevision !== value.effective.overrideRevision
      || config.sharedBroadcastsPerHour !== value.effective.sharedBroadcastsPerHour))
    throw new Error('The settings response was incomplete. Load saved settings before editing.');
  return value;
}
export function communicationDraft(saved: CommunicationSettings, mode: CommunicationMode): CommunicationDraft {
  const config = saved.configuration;
  if (!config) throw new Error('Editing is unavailable.');
  const fields = mode === 'agent' ? config.overrideFields : config.defaults;
  return { broadcastAllowed: fields.broadcastAllowed === undefined ? 'inherit' : fields.broadcastAllowed ? 'allow' : 'deny',
    sendsPerHour: fields.sendsPerHour?.toString() ?? '', minimumGapSeconds: fields.minimumGapSeconds?.toString() ?? '',
    broadcastsPerHour: fields.broadcastsPerHour?.toString() ?? '', sharedBroadcastsPerHour: config.sharedBroadcastsPerHour.toString() };
}
export function communicationEdit(saved: CommunicationSettings, mode: CommunicationMode, draft: CommunicationDraft) {
  const config = saved.configuration;
  if (!config || !(mode === 'agent' ? saved.canEditAgent : saved.canEditDefaults)) throw new Error('Editing is unavailable.');
  const fields: Partial<CommunicationFields> = {};
  if (draft.broadcastAllowed !== 'inherit') fields.broadcastAllowed = draft.broadcastAllowed === 'allow';
  const limits = { sendsPerHour: [1, B.sendsPerHour], minimumGapSeconds: [B.minimumGapSeconds, B.maximumGapSeconds], broadcastsPerHour: [1, B.broadcastsPerHour] };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const text = draft[key].trim(), [min, max] = limits[key];
    if (!text && mode === 'agent') continue;
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max)
      throw new Error(`Enter a whole number from ${min} to ${max}.`);
    fields[key] = number;
  }
  if (mode === 'agent') return { expectedRevision: config.overrideRevision, fields };
  if (draft.broadcastAllowed === 'inherit') throw new Error('Choose the project broadcast permission.');
  const shared = Number(draft.sharedBroadcastsPerHour);
  if (!/^\d+$/.test(draft.sharedBroadcastsPerHour) || !Number.isSafeInteger(shared) || shared < 1 || shared > B.broadcastsPerHour)
    throw new Error(`The shared project allowance must be from 1 to ${B.broadcastsPerHour}.`);
  return { expectedRevision: config.projectRevision, defaults: fields as CommunicationFields, sharedBroadcastsPerHour: shared };
}
