// The sign-in service that proves who a person is: the engine's single local owner (local-owner.ts; tests
// use a multi-person stand-in in test/server-sessions.ts). Providers report through this interface, so auth.ts applies one set of
// authority checks.

/** A session token the provider accepted. `subject` is the provider's stable account ID. */
export type VerifiedSession = {
  subject: string;
  /** How the person signed in: 'github.com' or 'local-owner'. */
  signInProvider: string;
  /** Unix seconds of the person's latest sign-in. */
  authTime: number;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  /** The GitHub account ID when the session came from a GitHub sign-in. */
  githubId: string | null;
};

/** One sign-in account, without tokens or secrets. */
export type IdentityAccount = {
  subject: string;
  disabled: boolean;
  /** Sessions authenticated before this Unix-ms time are revoked. */
  validAfter: number;
  /** The first linked sign-in method, such as 'github.com'. */
  primaryProvider: string;
  githubId: string | null;
  email: string | null;
  emailVerified: boolean;
};

export interface IdentityProvider {
  /** Null when the provider rejected the token or account. An outage or configuration error throws, so callers can retry. */
  verifySession(token: string): Promise<VerifiedSession | null>;
  /** Null when the account does not exist. */
  account(subject: string): Promise<IdentityAccount | null>;
}
