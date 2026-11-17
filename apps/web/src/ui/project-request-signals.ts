import type { HumanRequestPage } from '@minions/contracts';

/** Count the visible bounded page, including shared decisions; mark agents with visible outstanding requests. */
export function projectRequestSignals(page: HumanRequestPage, profileId: string) {
  const requests = page.items.filter(item => item.visibility !== 'moderators' && item.status === 'open');
  const waiting = requests.filter(item => item.assigneeProfileId === profileId);
  return { count: page.items.length, more: !!page.next, agentIds: [...new Set(requests.map(item => item.agentId))], waiting, requests };
}
