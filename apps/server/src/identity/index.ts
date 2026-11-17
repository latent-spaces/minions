import type { IdentityProvider } from './provider.js';

export type { IdentityAccount, IdentityProvider, VerifiedSession } from './provider.js';
export { localOwnerIdentity, type LocalOwnerIdentity } from './local-owner.js';

// Until the engine installs its sign-in service at startup, nobody is signed in.
const nobody: IdentityProvider = {
  verifySession: async () => null,
  account: async () => null,
};
let current: IdentityProvider = nobody;

/** The sign-in service for this server: GitHub sessions or the single local owner, installed by the engine at startup. */
export const identity = (): IdentityProvider => current;
export function setIdentityProvider(provider: IdentityProvider): void { current = provider; }
