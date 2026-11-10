export const COMMUNICATION_BOUNDS = {
  sendsPerHour: 60, broadcastsPerHour: 60, minimumGapSeconds: 5, maximumGapSeconds: 3600,
} as const;
export type CommunicationFields = {
  broadcastAllowed: boolean; sendsPerHour: number; minimumGapSeconds: number; broadcastsPerHour: number;
};
export type CommunicationEffective = CommunicationFields & {
  sharedBroadcastsPerHour: number; projectRevision: number; overrideRevision: number;
};
export type CommunicationSettings = {
  agentId: string | null;
  effective: CommunicationEffective;
  canEditDefaults: boolean;
  canEditAgent: boolean;
  overriddenFields: (keyof CommunicationFields)[];
  configuration?: {
    defaults: CommunicationFields; sharedBroadcastsPerHour: number; projectRevision: number;
    overrideFields: Partial<CommunicationFields>; overrideRevision: number;
  };
};
