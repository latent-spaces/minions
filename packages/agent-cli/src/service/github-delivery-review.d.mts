import type { DeliveryReviewSubmission, DeliveryReviewRequiredCheck, DeliveryReviewObservation } from '@minions/contracts';

export function observeGitHubDelivery(
  candidate: Pick<DeliveryReviewSubmission, 'repository' | 'pullRequest' | 'headSha'>,
  policy: readonly DeliveryReviewRequiredCheck[],
  options?: { signal?: AbortSignal; now?: () => number },
): Promise<DeliveryReviewObservation>;
