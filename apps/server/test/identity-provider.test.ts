import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { personIdentityFromIdToken, signInFromIdToken, verifiedEmails } from '../src/auth.js';
import { identity, setIdentityProvider, type IdentityProvider } from '../src/identity/index.js';
import { githubAccounts } from '../src/firestore.js';
import { resetEmulator, seed } from './helpers.js';

const installed = identity();

const session = { subject: 'self-hosted-1', signInProvider: 'github.com', authTime: 1_700, name: 'Ada', email: null, emailVerified: false, githubId: '42' };
const provider: IdentityProvider = {
  verifySession: vi.fn(async (token: string) => token === 'good' ? session : null),
  account: vi.fn(async () => null),
  exportAccount: vi.fn(async () => null),
};

beforeEach(async () => { await resetEmulator(); setIdentityProvider(provider); });
afterEach(() => { setIdentityProvider(installed); });

test('the installed sign-in service is the one every sign-in consults', () => {
  expect(identity()).toBe(provider);
});

test('an installed sign-in service resolves the invited person through the same verified GitHub emails', async () => {
  const { personIds } = await seed({ profiles: [{ name: 'Ada', email: 'ada@example.test' }] });
  await githubAccounts.doc('42').set({ firebaseUid: 'self-hosted-1', login: 'ada', emails: ['ada@example.test'], avatarUrl: null, checkedAt: 0 });
  const signIn = await signInFromIdToken('good');
  expect(signIn).toEqual({ firebaseUid: 'self-hosted-1', provider: 'github.com', authTime: 1_700_000, name: 'Ada', emails: ['ada@example.test'], githubUsername: 'ada' });
  expect((await personIdentityFromIdToken('good')).person.id).toBe(personIds[0]);
});

test('a rejected session or a GitHub account linked to another subject is refused', async () => {
  await expect(signInFromIdToken('bad')).rejects.toMatchObject({ code: 'unauthorized' });
  await githubAccounts.doc('42').set({ firebaseUid: 'someone-else', login: 'ada', emails: ['ada@example.test'], avatarUrl: null, checkedAt: 0 });
  await expect(signInFromIdToken('good')).rejects.toMatchObject({ code: 'unauthorized' });
  expect(await verifiedEmails({ subject: 'self-hosted-1', email: null, emailVerified: false, githubId: '42' })).toEqual([]);
});
