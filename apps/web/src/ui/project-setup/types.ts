export type ProjectSetupMode = 'private' | 'public';

/** Form state; transport maps this explicitly to validated creation/proposal contracts. */
export interface ProjectSetupDraft {
  name: string;
  purpose: string;
  peopleNote: string;
  repository: string;
  agentGuidance: string;
  minContributors: number;
  sendsPerHour: number;
  minimumGapSeconds: number;
  broadcastsPerHour: number;
  sharedBroadcastsPerHour: number;
}

export interface ProjectSetupStepProps {
  mode: ProjectSetupMode;
  draft: ProjectSetupDraft;
  onChange: (patch: Partial<ProjectSetupDraft>) => void;
}

export const setupSteps = ['Visibility', 'Basics', 'Repository'] as const;

export const setupStep = Object.fromEntries(setupSteps.map((name, index) => [name, index])) as Record<typeof setupSteps[number], number>;

export const emptyProjectSetupDraft: ProjectSetupDraft = {
  name: '', purpose: '', peopleNote: '', repository: '', agentGuidance: '', minContributors: 1,
  sendsPerHour: 60, minimumGapSeconds: 5, broadcastsPerHour: 6, sharedBroadcastsPerHour: 6,
};
