import type { HumanRequest } from '@minions/contracts';

/** Keep an in-progress answer mounted when another client (or an uncertain send)
 * removes it from the open list. The existing versioned answer API reconciles retries. */
export function popupRequestRows(current: HumanRequest[], answered: HumanRequest[], protectedAnswers: HumanRequest[]): HumanRequest[] {
  const rows = new Map<string, HumanRequest>();
  for (const request of [...protectedAnswers, ...current, ...answered]) {
    const prior = rows.get(request.id);
    if (!prior || (request.revision ?? 0) >= (prior.revision ?? 0)) rows.set(request.id, request);
  }
  return [...rows.values()];
}
