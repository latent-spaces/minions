export type AgentPersona = { text: string; revision: number; updatedAt: number | null };
export type AgentParticipationContext = {
  identity: { projectId: string; agentId: string; profileId: string };
  persona: AgentPersona;
  messaging: { directRecipientsMax: number; sendsPerHour: number; minimumGapSeconds: number;
    broadcastAllowed: boolean; broadcastsPerAgentPerHour: number; sharedBroadcastLimit: number;
    projectRevision: number };
  workDefaults: { involvement: 'with_me' | 'on_own'; appliesTo: 'next_start' };
  personaApplication: 'next_natural_turn_boundary';
  /** Native bridge read time for its turn-frozen persona; no application acknowledgment. */
  personaCapturedAt?: number;
  observedAt: number;
};
