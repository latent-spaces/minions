import type { PublicProfilePhoto } from '@mlswarm/contracts';
import type { Profile } from '../firestore.js';
const ID = /^[a-f0-9]{64}$/;
export function publicProfilePhoto(profile: Profile, personId: string): PublicProfilePhoto | null {
  const photo = profile.photo;
  return profile.removedAt === null && photo?.publicConsent === true && ID.test(photo.id)
    ? { id: photo.id, url: `/api/profiles/${encodeURIComponent(personId)}/photo/${photo.id}` } : null;
}
