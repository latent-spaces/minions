import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';

// A self-hosted engine's owner signs in without GitHub.
import { personIdentityFromIdToken, signInFromIdToken, verifiedEmails } from '../src/auth.js';
import { setIdentityProvider, type IdentityProvider } from '../src/identity/index.js';
import { localOwnerIdentity, localOwnerSubject, vouchesForOwnerEmail } from '../src/identity/local-owner.js';
import { serverSessionIdentity } from '../src/identity/server-sessions.js';
import { resetEmulator, seed } from './helpers.js';

let clock = 1_800_000_000_000;
const now = () => clock;
const secret = randomBytes(32);
const owner = { subject: 'owner-1', email: 'Ada@Example.test', name: 'Ada' };
const local = localOwnerIdentity({ secret, owner, now });
// The GitHub sign-in service, which an engine without a local owner uses.
const github = serverSessionIdentity();

beforeEach(async () => { await resetEmulator(); setIdentityProvider(local); clock = 1_800_000_000_000; });
afterEach(() => { setIdentityProvider(github); });

test('the owner signs in as the invited profile with their configured email, without admin or reviewer authority', async () => {
  const { personIds } = await seed({ profiles: [{ name: 'Ada', email: 'ada@example.test' }] });
  const token = local.issueSession();
  expect(await signInFromIdToken(token)).toEqual({ firebaseUid: 'owner-1', provider: 'local-owner', authTime: 1_800_000_000_000,
    name: 'Ada', emails: ['ada@example.test'], githubUsername: null });
  const signedIn = await personIdentityFromIdToken(token);
  expect(signedIn.person.id).toBe(personIds[0]);
  expect(signedIn).toMatchObject({ adminAuthenticated: false, verifiedGithubSession: false });
});

test('a forged, altered, foreign or expired token is refused', async () => {
  const token = local.issueSession();
  const [prefix, payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'owner-1', iat: 1_800_000_000, exp: 9_999_999_999 })).toString('base64url');
  const other = localOwnerIdentity({ secret: randomBytes(32), owner, now }).issueSession();
  for (const bad of [`${prefix}.${forged}.${mac}`, `${prefix}.${payload}.${mac}x`, `${token}.extra`, other, 'not-a-token', ''])
    expect(await local.verifySession(bad)).toBeNull();
  // Reloading the local app opens a new owner session.
  await expect(signInFromIdToken(other)).rejects.toMatchObject({ code: 'unauthorized', message: 'Reload MyLittleSwarm on this computer.' });
  clock += 12 * 60 * 60_000;
  expect(await local.verifySession(token)).toBeNull();
});

test('a correctly signed token from the future, longer than the session lifetime, or with odd claims is refused', async () => {
  const signed = (claims: object) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `lo1.${payload}.${createHmac('sha256', secret).update(`lo1.${payload}`).digest('base64url')}`;
  };
  const iat = clock / 1000;
  expect(await local.verifySession(signed({ sub: 'owner-1', iat, exp: iat + 60 }))).not.toBeNull();
  for (const claims of [{ sub: 'owner-1', iat: iat + 60, exp: iat + 120 }, { sub: 'owner-1', iat, exp: iat + 13 * 60 * 60 },
    { sub: 'owner-1', iat: iat + 0.5, exp: iat + 60 }, { sub: 'owner-1', iat: String(iat), exp: iat + 60 }, { sub: 'owner-2', iat, exp: iat + 60 }])
    expect(await local.verifySession(signed(claims))).toBeNull();
  expect(await local.verifySession(`lo1.${Buffer.from('null').toString('base64url')}.${createHmac('sha256', secret).update(`lo1.${Buffer.from('null').toString('base64url')}`).digest('base64url')}`)).toBeNull();
  expect(await local.verifySession(undefined as unknown as string)).toBeNull();
  expect(await local.verifySession('x'.repeat(2000))).toBeNull();
});

test('sessions issued before validAfter are revoked, and the account reports it', async () => {
  const token = local.issueSession();
  const rotated = localOwnerIdentity({ secret, owner, now, validAfter: clock + 1_000 });
  expect(await rotated.verifySession(token)).toBeNull();
  expect(await rotated.account('owner-1')).toMatchObject({ disabled: false, validAfter: clock + 1_000, primaryProvider: 'local-owner' });
  expect(await rotated.account('someone-else')).toBeNull();
});

test('only the installed local owner provider vouches for the owner email', async () => {
  const account = (await local.account('owner-1'))!;
  expect(await verifiedEmails(account)).toEqual(['ada@example.test']);
  // Only for the configured owner: another subject with the same email gets nothing.
  expect(await verifiedEmails({ ...account, subject: 'owner-2' })).toEqual([]);
  expect(localOwnerSubject(local)).toBe('owner-1');
  expect(localOwnerSubject(github)).toBeNull();
  expect(vouchesForOwnerEmail(github)).toBe(false);
  // Another service's session claiming the local-owner provider is not trusted for its email.
  const impostor: IdentityProvider = { account: async () => null, exportAccount: async () => null,
    verifySession: async () => ({ subject: 'x', signInProvider: 'local-owner', authTime: 1, name: null, email: 'ada@example.test', emailVerified: true, githubId: null }) };
  setIdentityProvider(impostor);
  await expect(signInFromIdToken('anything')).rejects.toMatchObject({ code: 'unauthorized', message: 'Reload MyLittleSwarm on this computer.' });
});

test('the export contains only the owner account', async () => {
  expect(await local.exportAccount('ada@example.test')).toMatchObject({ uid: 'owner-1', email: 'ada@example.test', providers: [{ providerId: 'local-owner' }] });
  expect(await local.exportAccount('bob@example.test')).toBeNull();
});

test('a short secret or missing owner email is a configuration error', () => {
  expect(() => localOwnerIdentity({ secret: randomBytes(16), owner })).toThrow();
  expect(() => localOwnerIdentity({ secret, owner: { ...owner, email: '' } })).toThrow();
});
