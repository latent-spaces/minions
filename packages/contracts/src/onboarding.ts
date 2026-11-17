export const ONBOARDING_STEPS = ['signedIn', 'accepted', 'joined', 'computer', 'github', 'firstVisit', 'firstChat', 'firstSteering', 'agent', 'firstWork'] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export type OnboardingDistribution = { samples: number; medianMs: number | null; p90Ms: number | null; minMs: number | null; maxMs: number | null };
export type OnboardingJourney = {
  id: string; profileId: string; projectId: string; projectTitle: string | null; name: string | null; email: string | null;
  enteredAt: number; source: 'invitation' | 'shared_link' | 'membership'; timingEligible: boolean;
  milestones: Partial<Record<OnboardingStep, number>>; reused: { computer: boolean; github: boolean };
  elapsed: Partial<Record<OnboardingStep, number>>;
  humanActivity: { firstAt: number | null; lastAt: number | null; chatMessages: number; steeringCommands: number };
};
export type OnboardingTimings = {
  observedAt: number; days: '7' | '30' | '90' | 'all'; projectId: string | null; total: number;
  projects: { id: string; title: string | null }[];
  scope: { limit: number; recordsChecked: number; truncated: boolean; removedExcluded: number; historical: number };
  journeys: OnboardingJourney[];
};

/** Use one explicit baseline's elapsed intervals; never pool invitation wait with signed-in setup. */
export function onboardingDistribution(values: number[]): OnboardingDistribution {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b), n = sorted.length;
  return { samples: n, medianMs: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2 : null,
    p90Ms: n ? sorted[Math.ceil(n * .9) - 1] : null, minMs: n ? sorted[0] : null, maxMs: n ? sorted[n - 1] : null };
}
