import type { Transaction } from '../firestore.js';
import { collection } from '../firestore.js';
export type AccountStep = 'signedIn' | 'computer' | 'github';
export type OnboardingProgress = { trackingStartedAt: number; milestones: Partial<Record<AccountStep, number>> };
export const onboardingProgress = collection<OnboardingProgress>('onboardingProgress');
/** Prepare during the read phase, then commit with the accepted account action. */
export async function prepareOnboardingProgress(tx: Transaction, profileId: string, at: number) {
  const ref = onboardingProgress.doc(profileId), saved = (await tx.get(ref)).data();
  return (steps: readonly AccountStep[]) => {
    const milestones = { ...saved?.milestones };
    let changed = !saved;
    for (const step of steps) if (milestones[step] === undefined) { milestones[step] = at; changed = true; }
    if (changed) tx.set(ref, { trackingStartedAt: saved?.trackingStartedAt ?? at, milestones });
  };
}
/** A turn phase is preflight, so require actual model-call or token completion evidence. */
export function reportsModelWork(turn: import('../v2/records.js').LastTurn | undefined) {
  const tokens = turn?.usage?.tokens;
  return !!tokens && ((tokens.modelCalls ?? 0) > 0 || (tokens.input ?? 0) > 0 || (tokens.output ?? 0) > 0);
}
