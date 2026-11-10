/** Public managed reference only; never a provider URL or private candidate. */
export type PublicProfilePhoto = { id: string; url: string };
export type ProfilePhotoCandidate = { id: string; previewPath: string; expiresAt: number; source: 'upload' | 'github' };
export type MyProfile = { id: string; name: string; bio: string; linkedinProfileUrl: string | null;
  revision: number; photo: PublicProfilePhoto | null; githubPhotoAvailable: boolean;
  // Private, from the GitHub sign-in: the account's username and the verified email MyLittleSwarm knows the person by.
  githubUsername: string | null; email: string };
export type SaveMyProfile = Pick<MyProfile, 'name' | 'bio' | 'linkedinProfileUrl'> & {
  expected_revision: number; client_request_id: string; photo: null | { id: string; publicConsent: true };
};
