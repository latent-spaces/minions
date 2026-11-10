import type { Transaction } from '../firestore.js';
import type { ProjectSetupPlan } from '@mlswarm/contracts';
import { collection } from '../firestore.js';

/** Only for the atomic first creation/approval; never reapplies an old plan on replay. */
export function initializeSetupCommunication(tx: Transaction, id: string, plan: ProjectSetupPlan | undefined, profileId: string, at: number) {
  if (plan) tx.create(collection(`projects/${id}/settings`).doc('communication'), {
    ...plan.communication, revision: 1, updatedAt: at, updatedByProfileId: profileId,
  });
}
