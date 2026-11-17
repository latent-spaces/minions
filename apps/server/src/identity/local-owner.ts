import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IdentityAccount, IdentityAccountExport, IdentityProvider, VerifiedSession } from './provider.js';

// The sign-in service for a single-owner self-hosted engine. There is no outside account service: the engine signs
// a session for its one owner with a secret only it holds, and the owner's email is the one they configured.
// Nothing installs this provider yet; a later change wires it into a self-hosted startup that serves loopback only.

export const LOCAL_OWNER_PROVIDER = 'local-owner';

export type LocalOwner = { subject: string; email: string; name: string | null };
export type LocalOwnerOptions = {
  /** At least 32 random bytes. Replacing it signs out every session. */
  secret: Buffer;
  owner: LocalOwner;
  /** Sessions issued before this Unix-ms time are refused. */
  validAfter?: number;
  /** Session lifetime in ms; 12 hours unless set. */
  sessionMs?: number;
  now?: () => number;
};
export type LocalOwnerIdentity = IdentityProvider & {
  /** A new session token for the owner. Hand it out only to a request the engine trusts as the owner. */
  issueSession(): string;
};

const PREFIX = 'lo1';
const providers = new WeakMap<IdentityProvider, string>();

/** Whether this provider vouches for its owner's email itself. Firebase and other account services never do. */
export const vouchesForOwnerEmail = (provider: IdentityProvider): boolean => providers.has(provider);
/** The one account whose email this provider vouches for, or null when it is not a local owner provider. */
export const localOwnerSubject = (provider: IdentityProvider): string | null => providers.get(provider) ?? null;

export function localOwnerIdentity(options: LocalOwnerOptions): LocalOwnerIdentity {
  const { secret, sessionMs = 12 * 60 * 60_000, now = Date.now } = options;
  if (secret.length < 32) throw new Error('The local owner secret must be at least 32 bytes.');
  const owner = { ...options.owner, email: options.owner.email.trim().toLowerCase() };
  if (!owner.subject || !owner.email.includes('@')) throw new Error('The local owner needs a subject and an email.');
  const validAfter = options.validAfter ?? 0;
  const sign = (payload: string) => createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest();

  const account = (): IdentityAccount => ({ subject: owner.subject, disabled: false, validAfter, primaryProvider: LOCAL_OWNER_PROVIDER,
    githubId: null, email: owner.email, emailVerified: true });

  const provider: LocalOwnerIdentity = {
    issueSession() {
      const iat = Math.floor(now() / 1000);
      const payload = Buffer.from(JSON.stringify({ sub: owner.subject, iat, exp: iat + Math.floor(sessionMs / 1000) })).toString('base64url');
      return `${PREFIX}.${payload}.${sign(payload).toString('base64url')}`;
    },
    async verifySession(token: string): Promise<VerifiedSession | null> {
      if (typeof token !== 'string' || token.length > 1024) return null;
      const [prefix, payload, mac, extra] = token.split('.');
      if (prefix !== PREFIX || !payload || !mac || extra !== undefined) return null;
      const given = Buffer.from(mac, 'base64url'), expected = sign(payload);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let claims: { sub?: unknown; iat?: unknown; exp?: unknown } | null;
      try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
      const { sub, iat, exp } = claims ?? {};
      if (sub !== owner.subject || typeof iat !== 'number' || typeof exp !== 'number' || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
      const nowSeconds = now() / 1000;
      // A session from the future, or one longer than the current lifetime, was not issued under today's settings.
      if (iat > nowSeconds + 1 || exp - iat > Math.floor(sessionMs / 1000)) return null;
      if (exp <= nowSeconds || iat * 1000 < validAfter) return null;
      return { subject: owner.subject, signInProvider: LOCAL_OWNER_PROVIDER, authTime: iat, name: owner.name,
        email: owner.email, emailVerified: true, githubId: null };
    },
    async account(subject: string) { return subject === owner.subject ? account() : null; },
    async exportAccount(email: string): Promise<IdentityAccountExport | null> {
      if (email.trim().toLowerCase() !== owner.email) return null;
      return { uid: owner.subject, email: owner.email, emailVerified: true, displayName: owner.name, photoURL: null, phoneNumber: null,
        disabled: false, providers: [{ providerId: LOCAL_OWNER_PROVIDER, uid: owner.subject, email: owner.email, displayName: owner.name,
          photoURL: null, phoneNumber: null }], createdAt: null, lastSignInAt: null };
    },
  };
  providers.set(provider, owner.subject);
  return provider;
}
