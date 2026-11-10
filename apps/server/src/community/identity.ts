import { prepareOnboardingProgress } from '../onboarding/progress.js';
import { publicProfilePhoto } from './profile-photo-ref.js';
import { platformSettings } from '../platform/settings.js';
import type { Transaction } from '../firestore.js';
import { Refusal } from '../errors.js';
import { db, profiles, type Profile, type WithId } from '../firestore.js';
import { platformOwnership } from './records.js';

// A signed-in person. Coding agents reach proposals through the person's approved computer (owner/routes.ts).
export type CommunityActor = { kind: 'person'; operatorId: string; adminAuthenticated?: boolean; verifiedGithubSession?: boolean; firebaseUid?: string };

export async function assertCommunityActor(tx: Transaction, actor: CommunityActor) {
  const [operator, settings, platform] = await Promise.all([tx.get(profiles.doc(actor.operatorId)), tx.get(platformOwnership), tx.get(platformSettings)]);
  if (!operator.exists || operator.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your MyLittleSwarm account is no longer active.');
  return { operator: { id: operator.id, ...operator.data()! } as WithId<Profile>,
    isOwner: settings.data()?.ownerProfileId === actor.operatorId,
    canAdminPlatform: actor.adminAuthenticated === true,
    canReview: actor.adminAuthenticated === true || (actor.verifiedGithubSession === true
      && (platform.data()?.reviewerEmails ?? []).includes(operator.data()!.email.toLowerCase())) };
}

export async function communityAccount(actor: CommunityActor, now: () => number = Date.now) {
  return db.runTransaction(async tx => {
    const { operator, canReview, canAdminPlatform } = await assertCommunityActor(tx, actor);
    const progress = await prepareOnboardingProgress(tx, operator.id, now()); progress(['signedIn']);
    return { person: { id: operator.id, name: operator.name, photo: publicProfilePhoto(operator, operator.id) }, canReviewProposals: canReview, canAdminPlatform, canInvite: true };
  });
}
