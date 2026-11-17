// A disposable test session signs people in with the test-only GitHub session stand-in (see idTokenFor in helpers.ts).
// Files that run outside one (tests/self-hosted.mjs) install their own sign-in, or none.
// The sessions module loads on first use, inside the test file, so a test's own module mocks apply to it.
import { deploymentKind } from '../src/deployment.js';
import { setIdentityProvider, type IdentityProvider } from '../src/identity/index.js';

if (deploymentKind() === 'test') {
  const sessions = async () => (await import('./server-sessions.js')).serverSessionIdentity();
  setIdentityProvider({
    verifySession: async token => (await sessions()).verifySession(token),
    account: async subject => (await sessions()).account(subject),
  } satisfies IdentityProvider);
}
