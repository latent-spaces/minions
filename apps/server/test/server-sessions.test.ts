// The self-hosted session provider against an in-memory document store with the operations it uses
// (doc get/set/update/delete, array-contains, transactional create). Store semantics are the
// conformance suite's job; this checks the provider's own token, expiry and revocation rules.
import { beforeEach, expect, test, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../src/firestore.js', () => {
  const doc = (name: string, id: string) => {
    const path = `${name}/${id}`;
    return {
      id, path,
      get: async () => ({ id, exists: store.has(path), data: () => store.get(path) && structuredClone(store.get(path)) }),
      set: async (value: Record<string, unknown>) => { store.set(path, structuredClone(value)); },
      update: async (patch: Record<string, unknown>) => {
        if (!store.has(path)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
        store.set(path, { ...store.get(path), ...patch });
      },
      delete: async () => { store.delete(path); },
    };
  };
  const collection = (name: string) => ({
    doc: (id: string) => doc(name, id),
    where: (field: string, op: string, value: unknown) => ({ limit: (n: number) => ({ get: async () => {
      const matches = (data: Record<string, unknown>) => op === 'array-contains' ? (data[field] as unknown[]).includes(value)
        : op === '<=' ? (data[field] as number) <= (value as number) : (() => { throw new Error(`unsupported ${op}`); })();
      const docs = [...store].filter(([path, data]) => path.startsWith(`${name}/`) && matches(data)).slice(0, n)
        .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => structuredClone(data) }));
      return { docs, size: docs.length, empty: !docs.length };
    } }) }),
  });
  return {
    collection, githubAccounts: collection('githubAccounts'),
    db: { runTransaction: async (work: (tx: unknown) => unknown) => {
      const writes: (() => void)[] = [];
      const result = await work({
        get: async (ref: { get: () => unknown }) => ref.get(),
        set: (ref: { path: string }, value: Record<string, unknown>) => { writes.push(() => store.set(ref.path, structuredClone(value))); },
        update: (ref: { path: string }, patch: Record<string, unknown>) => { writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...patch })); },
        create: (ref: { path: string }, value: Record<string, unknown>) => {
          if (store.has(ref.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
          writes.push(() => store.set(ref.path, structuredClone(value)));
        },
      });
      for (const write of writes) write();
      return result;
    } },
  };
});

const { deleteExpiredSessions, endSession, issueGithubSession, revokeSessions, serverSessionIdentity, SESSION_TTL_MS, setAccountDisabled, subjectForGithub } = await import('../src/identity/server-sessions.js');

let clock = 1_800_000_000_000;
const now = () => clock;
const provider = serverSessionIdentity(now);
const ada = { githubId: '42', login: 'ada', name: 'Ada', avatarUrl: null, emails: ['ada@example.test', 'ada@work.test'] };

beforeEach(() => { store.clear(); clock = 1_800_000_000_000; });

test('a new session verifies as the GitHub account, and auth.ts can resolve it through githubAccounts', async () => {
  const { token, expiresAt } = await issueGithubSession(ada, now);
  expect(expiresAt).toBe(clock + SESSION_TTL_MS);
  expect(await provider.verifySession(token)).toEqual({ subject: 'github-42', signInProvider: 'github.com', authTime: Math.floor(clock / 1000),
    name: 'Ada', email: 'ada@example.test', emailVerified: true, githubId: '42' });
  // The same record the hosted GitHub sign-in writes, keyed to this provider's subject.
  expect(store.get('githubAccounts/42')).toEqual({ firebaseUid: 'github-42', login: 'ada', emails: ada.emails, avatarUrl: null, checkedAt: clock });
});

test('only the token hash is stored', async () => {
  const { token } = await issueGithubSession(ada, now);
  const keys = [...store.keys()].filter(key => key.startsWith('identitySessions/'));
  expect(keys).toHaveLength(1);
  expect(JSON.stringify([...store])).not.toContain(token);
});

test('unknown, malformed and expired tokens are refused without throwing', async () => {
  const { token } = await issueGithubSession(ada, now);
  expect(await provider.verifySession('x'.repeat(43))).toBeNull();
  expect(await provider.verifySession(`${token}.`)).toBeNull();
  expect(await provider.verifySession('')).toBeNull();
  clock += SESSION_TTL_MS - 1;
  expect(await provider.verifySession(token)).not.toBeNull();
  clock += 1;
  expect(await provider.verifySession(token)).toBeNull();
});

test('revocation ends every earlier session; signing in again works', async () => {
  const first = await issueGithubSession(ada, now);
  clock += 10;
  const second = await issueGithubSession(ada, now);
  clock += 10;
  await revokeSessions(subjectForGithub('42'), now);
  expect(await provider.verifySession(first.token)).toBeNull();
  expect(await provider.verifySession(second.token)).toBeNull();
  // Connector checks compare validAfter with the session's sign-in time.
  const account = await provider.account('github-42');
  expect(account!.validAfter).toBeGreaterThan(clock);
  expect(account!.validAfter % 1000).toBe(0);
  clock += 10;
  const third = await issueGithubSession(ada, now);
  expect(await provider.verifySession(third.token)).not.toBeNull();
  expect((await provider.account('github-42'))!.validAfter).toBe(account!.validAfter);
});

test('signing out ends only that session', async () => {
  const first = await issueGithubSession(ada, now);
  const second = await issueGithubSession(ada, now);
  await endSession(first.token);
  await endSession('not-a-token');
  expect(await provider.verifySession(first.token)).toBeNull();
  expect(await provider.verifySession(second.token)).not.toBeNull();
});

test('a disabled account cannot verify or start a session', async () => {
  const { token } = await issueGithubSession(ada, now);
  await setAccountDisabled('github-42', true);
  expect(await provider.verifySession(token)).toBeNull();
  await expect(issueGithubSession(ada, now)).rejects.toMatchObject({ code: 'unauthorized' });
  expect((await provider.account('github-42'))!.disabled).toBe(true);
  await setAccountDisabled('github-42', false);
  expect(await provider.verifySession(token)).not.toBeNull();
  await setAccountDisabled('github-7', true);
  expect(store.has('identityAccounts/github-7')).toBe(false);
});

test('a GitHub account without a verified email cannot sign in', async () => {
  await expect(issueGithubSession({ ...ada, emails: [] }, now)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(store.size).toBe(0);
});

test('a malformed GitHub account ID is refused before any write', async () => {
  for (const githubId of ['', '0', '01', '-1', '4/2', '1'.repeat(21)]) await expect(issueGithubSession({ ...ada, githubId }, now)).rejects.toThrow();
  expect(store.size).toBe(0);
});

test('account and export describe the GitHub account without tokens', async () => {
  const signedInAt = clock;
  await issueGithubSession(ada, now);
  clock += 1_000;
  await issueGithubSession({ ...ada, login: 'ada-renamed', emails: ['ada@work.test'] }, now);
  expect(await provider.account('github-42')).toEqual({ subject: 'github-42', disabled: false, validAfter: 0, primaryProvider: 'github.com',
    githubId: '42', email: 'ada@work.test', emailVerified: true });
  expect(await provider.account('github-7')).toBeNull();
  const exported = await provider.exportAccount('ADA@work.test');
  expect(exported).toMatchObject({ uid: 'github-42', email: 'ada@work.test', disabled: false,
    providers: [{ providerId: 'github.com', uid: '42' }], createdAt: new Date(signedInAt).toISOString(), lastSignInAt: new Date(clock).toISOString() });
  expect(JSON.stringify(exported)).not.toMatch(/token|validAfter/i);
  expect(await provider.exportAccount('ada@example.test')).toBeNull();
});

test('an email held by two accounts exports neither', async () => {
  await issueGithubSession(ada, now);
  await issueGithubSession({ ...ada, githubId: '43', login: 'ada-old' }, now);
  expect(await provider.exportAccount('ada@work.test')).toBeNull();
});

test('revocation never moves validAfter back, and an unknown account is a no-op', async () => {
  await issueGithubSession(ada, now);
  clock += 1_000;
  await revokeSessions('github-42', now);
  const later = (await provider.account('github-42'))!.validAfter;
  clock -= 500;
  await revokeSessions('github-42', now);
  expect((await provider.account('github-42'))!.validAfter).toBeGreaterThanOrEqual(later);
  await revokeSessions('github-7', now);
  expect(store.has('identityAccounts/github-7')).toBe(false);
});

// owner/routes.ts stores signIn.authTime (authTime * 1000) as authenticatedAt and rejects a connection when
// account.validAfter > authenticatedAt (engine-codex's probe).
test('a sign-in in the same second as a revocation still makes a usable connector approval', async () => {
  clock = 1_800_000_000_500;
  const before = await issueGithubSession(ada, now);
  clock += 10;
  await revokeSessions('github-42', now);
  clock += 10;
  const fresh = await issueGithubSession(ada, now);
  expect(await provider.verifySession(before.token)).toBeNull();
  const session = await provider.verifySession(fresh.token);
  expect(session).not.toBeNull();
  const authenticatedAt = session!.authTime * 1000;
  expect((await provider.account('github-42'))!.validAfter > authenticatedAt).toBe(false);
  // A connection approved before the revocation stays revoked.
  expect((await provider.account('github-42'))!.validAfter > Math.floor(1_800_000_000_500 / 1000) * 1000).toBe(true);
});

test('emails are stored as invitations match them: lowercase, trimmed, deduplicated, primary first', async () => {
  const { token } = await issueGithubSession({ ...ada, emails: [' Ada@Example.TEST ', 'ada@example.test', 'ADA@work.test', ''] }, now);
  expect(store.get('githubAccounts/42')!.emails).toEqual(['ada@example.test', 'ada@work.test']);
  expect((await provider.verifySession(token))!.email).toBe('ada@example.test');
  expect((await provider.exportAccount('ada@work.test'))!.uid).toBe('github-42');
  await expect(issueGithubSession({ ...ada, emails: ['  '] }, now)).rejects.toMatchObject({ code: 'unauthorized' });
});

// engine-claude-1's schedule: revoke, sign in, revoke again, all within one second.
test('a second revocation in the same second also ends the session issued between them', async () => {
  clock = 1_800_000_000_500;
  await issueGithubSession(ada, now);
  clock += 10;
  await revokeSessions('github-42', now);
  clock += 90;
  const between = await issueGithubSession(ada, now);
  expect(await provider.verifySession(between.token)).not.toBeNull();
  clock += 100;
  await revokeSessions('github-42', now);
  expect(await provider.verifySession(between.token)).toBeNull();
  // A fresh sign-in afterwards still verifies and still makes a usable connector approval.
  clock += 50;
  const after = await issueGithubSession(ada, now);
  const session = await provider.verifySession(after.token);
  expect(session).not.toBeNull();
  expect((await provider.account('github-42'))!.validAfter > session!.authTime * 1000).toBe(false);
});

test('the sweep deletes only expired sessions, in bounded pages, and is safe to repeat', async () => {
  const tokens = [];
  for (let i = 0; i < 5; i++) { tokens.push((await issueGithubSession(ada, now)).token); clock += 1000; }
  const live = (await issueGithubSession(ada, () => clock + SESSION_TTL_MS)).token;
  const sessionCount = () => [...store.keys()].filter(path => path.startsWith('identitySessions/')).length;
  clock = 1_800_000_000_000 + SESSION_TTL_MS + 2_500; // the first three sessions have expired
  expect(await deleteExpiredSessions(now, { pageSize: 2, maxPages: 1 })).toEqual({ deleted: 2, more: true });
  expect(await deleteExpiredSessions(now, { pageSize: 2, maxPages: 5 })).toEqual({ deleted: 1, more: false });
  expect(await deleteExpiredSessions(now, { pageSize: 2, maxPages: 5 })).toEqual({ deleted: 0, more: false });
  expect(sessionCount()).toBe(3);
  for (const token of tokens.slice(3)) expect(await provider.verifySession(token)).not.toBeNull();
  expect(await provider.verifySession(live)).not.toBeNull();
  // The account and its GitHub link are untouched.
  expect(await provider.account(subjectForGithub('42'))).not.toBeNull();
});
