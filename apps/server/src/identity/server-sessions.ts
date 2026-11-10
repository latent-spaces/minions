// Self-hosted sign-in: the engine itself confirms a GitHub account (OAuth, see the sign-in routes) and issues an
// opaque session token. Only the token's sha256 is stored, like agent tokens. The session reports the same
// 'github.com' provider and GitHub account ID as a hosted Firebase session, and issuing one records
// githubAccounts/{githubId} exactly as the hosted GitHub sign-in does, so auth.ts applies one set of rules:
// verified GitHub emails, invitation by email and the GitHub username.
import { createHash, randomBytes } from 'node:crypto';
import { Refusal } from '../errors.js';
import { collection, db, githubAccounts } from '../firestore.js';
import { normalizeEmails } from './emails.js';
import type { IdentityAccount, IdentityAccountExport, IdentityProvider, VerifiedSession } from './provider.js';

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
// Sessions report their sign-in time in whole seconds (VerifiedSession.authTime), and connector approvals compare
// that with validAfter. Revocation therefore moves validAfter to a whole second, as Firebase's tokensValidAfterTime does.
const nextSecond = (ms: number) => Math.ceil(ms / 1000) * 1000;

/** One subject per GitHub account, so signing in again reaches the same MyLittleSwarm person. */
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

/** Signs one session out. An unknown token is not an error. */
export async function endSession(token: string): Promise<void> {
  if (TOKEN.test(token)) await sessions().doc(hash(token)).delete();
}

/** Revokes every session of the account issued so far, like Firebase's revokeRefreshTokens. Never moves validAfter back. */
export async function revokeSessions(subject: string, now: () => number): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = accounts().doc(subject), account = (await tx.get(ref)).data();
    if (!account) return;
    // A sign-in after an earlier revocation in this second counts from that revocation's validAfter, so a second
    // revocation in the same second moves one more second ahead to cover it.
    const next = nextSecond(now() + 1);
    tx.update(ref, { validAfter: account.validAfter >= next ? account.validAfter + 1000 : next });
  });
}

export const SESSION_SWEEP = { pageSize: 100, maxPages: 10 } as const;

/**
 * Deletes sessions that have already expired, at most pageSize × maxPages per call so one reconcile round stays
 * bounded; `more` asks the next round to continue. verifySession already refuses expired sessions, so this only
 * reclaims storage. A session's expiresAt is fixed at creation, so a deleted row can never have become valid again.
 */
export async function deleteExpiredSessions(now: () => number, limits: { pageSize: number; maxPages: number } = SESSION_SWEEP): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  for (let page = 0; page < limits.maxPages; page++) {
    const expired = await sessions().where('expiresAt', '<=', now()).limit(limits.pageSize).get();
    await Promise.all(expired.docs.map(row => sessions().doc(row.id).delete()));
    deleted += expired.size;
    if (expired.size < limits.pageSize) return { deleted, more: false };
  }
  return { deleted, more: true };
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
