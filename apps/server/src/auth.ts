import { createHash, randomBytes } from 'node:crypto';
import { approvedAdminSession, trustedReviewerSession } from './admin-auth.js';
import { Refusal } from './errors.js';
import { githubAccounts, profiles, type Profile, type WithId } from './firestore.js';
import { identity, type IdentityAccount } from './identity/index.js';
import { LOCAL_OWNER_PROVIDER, localOwnerSubject } from './identity/local-owner.js';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

// What to tell someone whose request carries no accepted session: the local app opens a new owner session on reload.
export const SIGN_IN_REQUIRED = 'Reload MyLittleSwarm on this computer.';

export type SignIn = { firebaseUid: string; provider: 'github.com' | 'local-owner'; authTime: number; name: string | null; emails: string[]; githubUsername: string | null };

// The emails a sign-in account has proven: for GitHub, those GitHub verified at the latest sign-in;
// for the owner of a single-owner engine, the email the engine itself vouches for.
export async function verifiedEmails(user: Pick<IdentityAccount, 'subject' | 'email' | 'emailVerified' | 'githubId'>): Promise<string[]> {
  if (user.githubId) {
    const account = (await githubAccounts.doc(user.githubId).get()).data();
    return account?.firebaseUid === user.subject ? account.emails : [];
  }
  const ownerSubject = localOwnerSubject(identity());
  return ownerSubject !== null && user.subject === ownerSubject && user.email && user.emailVerified ? [user.email.toLowerCase()] : [];
}

export async function signInFromIdToken(idToken: string): Promise<SignIn> {
  const session = await identity().verifySession(idToken);
  const provider = session?.signInProvider, githubId = session?.githubId ?? null;
  let emails: string[] = [], githubUsername: string | null = null;
  if (session && githubId) {
    const account = (await githubAccounts.doc(githubId).get()).data();
    if (account?.firebaseUid === session.subject) { emails = account.emails; githubUsername = account.login; }
  } else if (session && provider === LOCAL_OWNER_PROVIDER && session.subject === localOwnerSubject(identity()) && session.email && session.emailVerified) emails = [session.email.toLowerCase()];
  if (!session || !emails.length) throw new Refusal('unauthorized', SIGN_IN_REQUIRED);
  return { firebaseUid: session.subject, provider: provider as SignIn['provider'], authTime: session.authTime * 1000, name: session.name, emails, githubUsername };
}

// The one active profile whose email the sign-in has verified.
export async function profileForEmails(emails: string[]): Promise<WithId<Profile> | null> {
  const found = await profiles.where('email', 'in', emails.slice(0, 30)).where('removedAt', '==', null).limit(2).get();
  return found.size === 1 ? { id: found.docs[0].id, ...found.docs[0].data() } : null;
}

// The signed-in person's MyLittleSwarm account.
export async function personIdentityFromIdToken(idToken: string): Promise<{ person: WithId<Profile>; adminAuthenticated: boolean; verifiedGithubSession: boolean; firebaseUid: string }> {
  const signIn = await signInFromIdToken(idToken);
  const person = await profileForEmails(signIn.emails);
  if (!person) throw new Refusal('unauthorized', 'You need an invitation to use MyLittleSwarm. Ask someone who already uses it to invite you.');
  const verified = { provider: signIn.provider, email: person.email };
  return { firebaseUid: signIn.firebaseUid, person, adminAuthenticated: approvedAdminSession(verified), verifiedGithubSession: trustedReviewerSession(verified) };
}
export async function personFromIdToken(idToken: string): Promise<WithId<Profile>> {
  return (await personIdentityFromIdToken(idToken)).person;
}
