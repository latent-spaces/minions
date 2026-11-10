/** Durable human guidance. Answers never grant native tool permissions. */
export type HumanRequestStatus = 'open' | 'answered' | 'resolved';
export type HumanRequest = {
  id: string; projectId: string; projectTitle: string;
  agentId: string; agentName: string; requesterProfileId: string; assigneeProfileId: string;
  visibility: 'private' | 'project' | 'moderators'; title: string; question: string; context: string;
  /** Absent on historical requests and moderation reports. */
  attempted?: string; blockerTitle?: string; attemptedTitle?: string; suggestedOptions?: string[]; selectionMode?: 'single' | 'multiple';
  moderation?: ModerationReport;
  status: HumanRequestStatus; revision: number; createdAt: number; updatedAt: number;
  answer: { profileId: string; body: string; at: number; optionIndex?: number; optionIndices?: number[]; customAnswer?: string; acknowledged?: { agentId: string; runId: string; at: number } } | null;
  resolution: { body: string; at: number } | null;
};
/** Allegation and evidence references, never a public reputation or permission. */
export type ModerationReport = {
  subject: { kind: 'person' | 'agent'; id: string; name: string; ownerProfileId: string | null; ownerName: string | null };
  category: 'security' | 'conduct' | 'project_rules';
  evidence: { kind: 'agent_message' | 'project_update' | 'repository'; reference: string }[];
};
export type HumanRequestPage = { items: HumanRequest[]; next: string | null };
