// Test-only stand-in for sign-in: issues opaque session tokens for several GitHub accounts so tests can act as different people.
// The engine itself installs only the single local owner (src/identity/local-owner.ts). Only the token's sha256 is stored.
import { createHash, randomBytes } from 'node:crypto';
import { Refusal } from '../src/errors.js';
import { collection, db, githubAccounts } from '../src/firestore.js';
import type { IdentityAccount, IdentityAccountExport, IdentityProvider, VerifiedSession } from '../src/identity/provider.js';

/** Sign-in emails as invitations match them: trimmed, lowercase, without duplicates, in the given order, at most 30. */
const normalizeEmails = (emails: readonly string[]): string[] =>
  [...new Set(emails.map(email => email.trim().toLowerCase()).filter(email => email.length > 0 && email.length <= 254))].slice(0, 30);

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

// Times are Unix milliseconds.
export type ServerIdentityAccount = {
  githubId: string; login: string; name: string | null; avatarUrl: string | null;
  /** The emails GitHub reported verified at the latest sign-in, primary first. */
  emails: string[];
  disabled: boolean;
  /** Sessions created before this time are revoked. */
  validAfter: number;
  createdAt: number; lastSignInAt: number;
};
export type ServerSession = { subject: string; createdAt: number; expiresAt: number };

const accounts = () => collection<ServerIdentityAccount>('identityAccounts');
const sessions = () => collection<ServerSession>('identitySessions');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
/** One subject per GitHub account, so signing in again reaches the same Minions person. */
export const subjectForGithub = (githubId: string) => `github-${githubId}`;

/** `emails` are the ones GitHub reported verified, primary first; they are stored normalized. */
export type GithubSignIn = { githubId: string; login: string; name: string | null; avatarUrl: string | null; emails: string[] };

/** Records a sign-in GitHub has just confirmed and returns a new session token. The token is never stored. */
export async function issueGithubSession(signIn: GithubSignIn, now: () => number): Promise<{ token: string; expiresAt: number }> {
  if (!/^[1-9][0-9]{0,19}$/.test(signIn.githubId)) throw new Error('Invalid GitHub account ID.');
  const emails = normalizeEmails(signIn.emails);
  if (!emails.length) throw new Refusal('unauthorized', 'Verify an email on your GitHub account, then sign in again.');
  const subject = subjectForGithub(signIn.githubId);
  const token = randomBytes(32).toString('base64url');
  const at = now(), expiresAt = at + SESSION_TTL_MS;
  await db.runTransaction(async tx => {
    const accountRef = accounts().doc(subject);
    const existing = (await tx.get(accountRef)).data();
    if (existing?.disabled) throw new Refusal('unauthorized', 'This account is disabled.');
    tx.set(accountRef, {
      githubId: signIn.githubId, login: signIn.login, name: signIn.name, avatarUrl: signIn.avatarUrl, emails,
      disabled: false, validAfter: existing?.validAfter ?? 0, createdAt: existing?.createdAt ?? at, lastSignInAt: at,
    });
    tx.set(githubAccounts.doc(signIn.githubId), { firebaseUid: subject, login: signIn.login, emails, avatarUrl: signIn.avatarUrl, checkedAt: at });
    // A sign-in in the same second as a revocation counts from the revocation, so it is neither refused nor older than it.
    tx.create(sessions().doc(hash(token)), { subject, createdAt: Math.max(at, existing?.validAfter ?? 0), expiresAt });
  });
  return { token, expiresAt };
}

/** A disabled account's sessions stop verifying and it cannot start new ones until re-enabled. */
export async function setAccountDisabled(subject: string, disabled: boolean): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = accounts().doc(subject);
    if ((await tx.get(ref)).exists) tx.update(ref, { disabled });
  });
}

const accountOf = (subject: string, account: ServerIdentityAccount): IdentityAccount => ({
  subject, disabled: account.disabled, validAfter: account.validAfter, primaryProvider: 'github.com',
  githubId: account.githubId, email: account.emails[0] ?? null, emailVerified: account.emails.length > 0,
});

export function serverSessionIdentity(now: () => number = Date.now): IdentityProvider {
  return {
    async verifySession(token: string): Promise<VerifiedSession | null> {
      if (!TOKEN.test(token)) return null;
      const session = (await sessions().doc(hash(token)).get()).data();
      if (!session || session.expiresAt <= now()) return null;
      const account = (await accounts().doc(session.subject).get()).data();
      if (!account || account.disabled || session.createdAt < account.validAfter) return null;
      return { subject: session.subject, signInProvider: 'github.com', authTime: Math.floor(session.createdAt / 1000), name: account.name,
        email: account.emails[0] ?? null, emailVerified: account.emails.length > 0, githubId: account.githubId };
    },
    async account(subject: string): Promise<IdentityAccount | null> {
      const account = (await accounts().doc(subject).get()).data();
      return account ? accountOf(subject, account) : null;
    },
    async exportAccount(email: string): Promise<IdentityAccountExport | null> {
      // Two accounts can hold the same email if it moved between GitHub accounts; export neither rather than guess.
      const found = await accounts().where('emails', 'array-contains', email.toLowerCase()).limit(2).get();
      const row = found.size === 1 ? found.docs[0] : null;
      if (!row) return null;
      const account = row.data();
      return { uid: row.id, email: account.emails[0] ?? null, emailVerified: account.emails.length > 0, displayName: account.name,
        photoURL: account.avatarUrl, phoneNumber: null, disabled: account.disabled,
        providers: [{ providerId: 'github.com', uid: account.githubId, email: account.emails[0] ?? null, displayName: account.name, photoURL: account.avatarUrl, phoneNumber: null }],
        createdAt: new Date(account.createdAt).toISOString(), lastSignInAt: new Date(account.lastSignInAt).toISOString() };
    },
  };
}
