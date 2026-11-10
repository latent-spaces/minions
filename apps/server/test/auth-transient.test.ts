import { afterEach, expect, test } from 'vitest';
import { signInFromIdToken } from '../src/auth.js';
import { Refusal } from '../src/errors.js';
import { identity, setIdentityProvider, type IdentityProvider } from '../src/identity/index.js';

const installed = identity();
afterEach(() => { setIdentityProvider(installed); });
const provider = (verifySession: IdentityProvider['verifySession']): IdentityProvider =>
  ({ verifySession, account: async () => null, exportAccount: async () => null });

test('only a token the sign-in service rejected becomes a sign-in refusal', async () => {
  setIdentityProvider(provider(async () => null));
  await expect(signInFromIdToken('token')).rejects.toMatchObject({ code: 'unauthorized' });
});

test('sign-in lets outages and configuration errors through as server errors', async () => {
  const outage = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  setIdentityProvider(provider(async () => { throw outage; }));
  const failure = await signInFromIdToken('token').catch((error: unknown) => error);
  expect(failure).toBe(outage);
  expect(failure).not.toBeInstanceOf(Refusal);
});
