import type { Transaction } from '../firestore.js';
import { collection } from '../firestore.js';
import { limitReached } from '../errors.js';
import { platformSettings, privateParticipantLimit } from '../platform/settings.js';
import { membershipDoc } from './access.js';

/** Project policy survives invitation-link replacement. Capacity includes the owner. */
export type ProjectAdmission = { capacity: number; newcomers: boolean; revision: number };
export const projectAdmission = (id: string) => collection<ProjectAdmission>(`projects/${id}/settings`).doc('admission');
export const membershipCapacity = (id: string) => collection<{ revision: number }>(`projects/${id}/capacity`).doc('membership');

/** All private admission paths read the same membership fence before claiming a place. */
export async function readProjectAdmission(tx: Transaction, id: string, ownerId: string) {
  const [saved, platform, members, ownerMember, fence] = await Promise.all([
    tx.get(projectAdmission(id)), tx.get(platformSettings),
    tx.get(collection(`projects/${id}/members`).where('status', '==', 'active').count()),
    tx.get(membershipDoc(id, ownerId)), tx.get(membershipCapacity(id)),
  ]);
  const ceiling = privateParticipantLimit(platform.data());
  const policy = saved.data() ?? { capacity: ceiling, newcomers: false, revision: 0 };
  const capacity = Math.min(policy.capacity, ceiling);
  const people = members.data().count + 1 - Number(ownerMember.data()?.status === 'active');
  return { ...policy, capacity, storedCapacity: policy.capacity, ceiling, people,
    availablePlaces: Math.max(0, capacity - people), membershipRevision: fence.data()?.revision ?? 0 };
}

export function requireProjectPlace(admission: { capacity: number; people: number }) {
  if (admission.people >= admission.capacity) throw limitReached(
    { scope: 'private_participants', limit: admission.capacity, used: admission.people },
    'This private project is full. Ask the owner to free a place.');
}
