import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerSession, SESSION_STORAGE_KEY, type ServerSessionEnvironment } from '../src/server-session';
import type { SessionUser } from '../src/session-identity';

const OWNER = `lo1.${'p'.repeat(20)}.${'s'.repeat(43)}`, NEXT = `lo1.${'q'.repeat(20)}.${'t'.repeat(43)}`;
const account = { subject: 'local-owner-1', email: 'sam@example.test', displayName: 'Sam Example' };

function environment({ saved = null as string | null, sessions = { [OWNER]: account } as Record<string, object>, issue = [OWNER] as (string | number)[], down = false } = {}) {
  const items = new Map<string, string>(saved ? [[SESSION_STORAGE_KEY, saved]] : []);
  const calls: { url: string; method: string; auth: string | null }[] = [];
  let storageListener: ((key: string | null) => void) | undefined;
  const env: ServerSessionEnvironment = {
    fetch: (async (input: string, init: RequestInit = {}) => {
      const auth = new Headers(init.headers).get('authorization');
      calls.push({ url: String(input), method: init.method ?? 'GET', auth });
      if (down) throw new TypeError('fetch failed');
      if (String(input) === '/api/auth/local-owner/session') {
        const next = issue.shift();
        return typeof next === 'number' ? new Response('{}', { status: next }) : Response.json({ token: next });
      }
      const session = sessions[auth?.replace(/^Bearer /, '') ?? ''];
      return session ? Response.json(session) : new Response('{}', { status: 401 });
    }) as typeof fetch,
    storage: { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, removeItem: key => { items.delete(key); } },
    onStorage: listener => { storageListener = listener; return () => { storageListener = undefined; }; },
  };
  return { env, items, calls, sessions, storageChanged: (key: string | null) => storageListener?.(key) };
}
const first = (client: ReturnType<typeof createServerSession>) => new Promise<SessionUser | null>(resolve => { const stop = client.onUserChanged(user => { stop(); resolve(user); }); });

test('a first visit opens the owner session with no sign-in step', async () => {
  const f = environment();
  const user = await first(createServerSession(f.env));
  assert.equal(user?.uid, 'local-owner-1');
  assert.equal(user?.displayName, 'Sam Example');
  assert.equal(f.items.get(SESSION_STORAGE_KEY), OWNER);
  assert.equal(await user!.getIdToken(), OWNER);
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.url}`), ['POST /api/auth/local-owner/session', 'GET /api/auth/session']);
});

test('a saved session the engine accepts is reused without opening another', async () => {
  const f = environment({ saved: OWNER, issue: [] });
  assert.equal((await first(createServerSession(f.env)))?.uid, 'local-owner-1');
  assert.deepEqual(f.calls.map(call => call.url), ['/api/auth/session']);
});

test('an expired or malformed saved session is replaced by a new one', async () => {
  for (const saved of [NEXT, 'not a token']) {
    const f = environment({ saved });
    assert.equal((await first(createServerSession(f.env)))?.uid, 'local-owner-1');
    assert.equal(f.items.get(SESSION_STORAGE_KEY), OWNER);
  }
});

test('an engine that refuses, is down, or answers an invalid token leaves the page without a session', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    for (const f of [environment({ issue: [403] }), environment({ down: true }), environment({ issue: ['short'] })]) {
      assert.equal(await first(createServerSession(f.env)), null);
      assert.equal(f.items.get(SESSION_STORAGE_KEY), undefined);
    }
  } finally { console.warn = warn; }
});

test('another tab replacing the session is followed, and a session ended by the engine refuses its old token', async () => {
  const f = environment({ saved: OWNER, sessions: { [OWNER]: account, [NEXT]: { ...account, subject: 'local-owner-2' } } });
  const client = createServerSession(f.env);
  const user = await first(client);
  const changed = new Promise<SessionUser | null>(resolve => { let seen = 0; client.onUserChanged(next => { if (++seen === 2) resolve(next); }); });
  f.items.set(SESSION_STORAGE_KEY, NEXT); f.storageChanged(SESSION_STORAGE_KEY);
  assert.equal((await changed)?.uid, 'local-owner-2');
  await assert.rejects(user!.getIdToken(), /session ended/);
});
