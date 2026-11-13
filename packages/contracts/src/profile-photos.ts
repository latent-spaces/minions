/** Public managed reference only; never a provider URL or private candidate. */
export type PublicProfilePhoto = { id: string; url: string };
export const PERSON_CHARACTERS = ['person-01', 'person-02', 'person-03', 'person-04', 'person-robot', 'person-alien'] as const;
export type PersonCharacter = typeof PERSON_CHARACTERS[number];
export type ProfilePhotoCandidate = { id: string; previewPath: string; expiresAt: number; source: 'upload' | 'github' };
export type MyProfile = { id: string; name: string; bio: string; linkedinProfileUrl: string | null;
  revision: number; photo: PublicProfilePhoto | null; githubPhotoAvailable: boolean; character?: PersonCharacter | null;
  // Private, from the GitHub sign-in: the account's username and the verified email MyLittleSwarm knows the person by.
  githubUsername: string | null; email: string };
export type SaveMyProfile = Pick<MyProfile, 'name' | 'bio' | 'linkedinProfileUrl'> & {
  expected_revision: number; client_request_id: string; photo: null | { id: string; publicConsent: true };
  character?: PersonCharacter | null;
};
