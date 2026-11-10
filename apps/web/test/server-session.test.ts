import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerSession, SESSION_STORAGE_KEY, SIGN_IN_STATE_KEY, type ServerSessionEnvironment } from '../src/server-session';
import type { SessionUser } from '../src/session-identity';

const TOKEN = 'a'.repeat(43), OTHER = 'b'.repeat(43), NONCE = 'n'.repeat(43);
const account = { subject: 'github-42', email: 'sam@example.test', displayName: 'Sam Example' };

type Exchange = (body: { code: string; client_state: string }) => Response | Promise<Response>;
function environment({ hash = '', saved = null as string | null, started = null as string | null, sessions = { [TOKEN]: account } as Record<string, object>, down = false, exchange = undefined as Exchange | undefined } = {}) {
  const items = new Map<string, string>(saved ? [[SESSION_STORAGE_KEY, saved]] : []);
  const tab = new Map<string, string>(started ? [[SIGN_IN_STATE_KEY, started]] : []);
  const calls: { url: string; method: string; auth: string | null; body?: string }[] = [], urls: string[] = [], navigations: string[] = [];
  let storageListener: ((key: string | null) => void) | undefined;
  const env: ServerSessionEnvironment = {
    fetch: (async (input: string, init: RequestInit = {}) => {
      const auth = new Headers(init.headers).get('authorization');
      calls.push({ url: String(input), method: init.method ?? 'GET', auth });
      if (down) throw new TypeError('fetch failed');
      if (String(input) === '/api/auth/local-owner/exchange') {
        calls[calls.length - 1].body = String(init.body);
        return exchange ? exchange(JSON.parse(String(init.body))) : new Response('{}', { status: 404 });
      }
      const token = auth?.replace(/^Bearer /, '') ?? '';
      if (String(input) === '/api/auth/session/revoke') { delete sessions[token]; return new Response(null, { status: 204 }); }
      const session = sessions[token];
      return session ? Response.json(session) : new Response('{}', { status: 401 });
    }) as typeof fetch,
    storage: { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, removeItem: key => { items.delete(key); } },
    tabStorage: { getItem: key => tab.get(key) ?? null, setItem: (key, value) => { tab.set(key, value); }, removeItem: key => { tab.delete(key); } },
    nonce: () => NONCE,
    location: { hash, pathname: '/viewer/', search: '?view=explore' },
    replaceUrl: url => { urls.push(url); },
    navigate: url => { navigations.push(url); },
    onStorage: listener => { storageListener = listener; return () => { storageListener = undefined; }; },
  };
  return { env, items, tab, calls, urls, navigations, sessions, otherTab: (key: string | null) => storageListener?.(key) };
}
const firstState = (client: ReturnType<typeof createServerSession>) =>
  new Promise<SessionUser | null>(resolve => { const stop = client.onTokenChanged(user => { stop(); resolve(user); }); });

test('a session returned by the engine is saved, removed from the address and confirmed before anyone sees it', async () => {
  const t = environment({ hash: `#mlswarm_session=${TOKEN}&mlswarm_state=${NONCE}`, started: NONCE });
  const client = createServerSession(t.env);
  assert.deepEqual(t.urls, ['/viewer/?view=explore'], 'the token leaves the address before anything else runs');
  assert.equal(t.tab.has(SIGN_IN_STATE_KEY), false, 'a started sign-in is answered once');
  assert.equal(t.items.get(SESSION_STORAGE_KEY), TOKEN);
  assert.equal(client.currentUser(), null, 'not signed in until the engine confirms the session');
  const user = await firstState(client);
  assert.deepEqual({ uid: user?.uid, email: user?.email, displayName: user?.displayName }, { uid: 'github-42', email: 'sam@example.test', displayName: 'Sam Example' });
  assert.equal(await user?.getIdToken(), TOKEN);
  assert.equal(client.currentUid(), 'github-42');
  assert.deepEqual(t.calls, [{ url: '/api/auth/session', method: 'GET', auth: `Bearer ${TOKEN}` }]);
});

test('other fragment parameters stay, and a malformed returned token is never saved', async () => {
  const t = environment({ hash: `#mlswarm_session=not%20a%20token&mlswarm_state=${NONCE}&section=tasks`, started: NONCE });
  const client = createServerSession(t.env);
  assert.deepEqual(t.urls, ['/viewer/?view=explore#section=tasks']);
  assert.equal(t.items.has(SESSION_STORAGE_KEY), false);
  assert.equal(await firstState(client), null);
  assert.equal(t.calls.length, 0);
});

test('a session this tab did not ask for is never saved: crafted links, wrong or replayed state (login CSRF)', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    for (const [hash, started] of [[`#mlswarm_session=${TOKEN}`, null], [`#mlswarm_session=${TOKEN}`, NONCE],
      [`#mlswarm_session=${TOKEN}&mlswarm_state=${NONCE}`, null], [`#mlswarm_session=${TOKEN}&mlswarm_state=${'x'.repeat(43)}`, NONCE]] as const) {
      const t = environment({ hash, started, saved: OTHER, sessions: { [TOKEN]: account, [OTHER]: { ...account, subject: 'github-7' } } });
      const client = createServerSession(t.env);
      assert.deepEqual(t.urls, ['/viewer/?view=explore'], 'the address is cleaned either way');
      assert.equal(t.items.get(SESSION_STORAGE_KEY), OTHER, `${hash} with ${started}: the person's own session stays`);
      assert.equal((await firstState(client))?.uid, 'github-7');
      assert.equal(t.tab.has(SIGN_IN_STATE_KEY), false);
    }
  } finally { console.warn = warn; }
});

test('a sign-in the engine could not finish leaves the address and keeps the saved session', async () => {
  const t = environment({ hash: '#mlswarm_sign_in_error=retry', saved: TOKEN });
  const warn = console.warn; const warned: unknown[] = []; console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    const client = createServerSession(t.env);
    assert.deepEqual(t.urls, ['/viewer/?view=explore']);
    assert.equal((await firstState(client))?.uid, 'github-42');
    assert.equal(warned.length, 1);
  } finally { console.warn = warn; }
});

test('an expired or revoked session signs the person out and forgets the token', async () => {
  const t = environment({ saved: TOKEN, sessions: {} });
  const client = createServerSession(t.env);
  assert.equal(await firstState(client), null);
  assert.equal(t.items.has(SESSION_STORAGE_KEY), false);
  assert.equal(client.currentUid(), undefined);
});

test('an unreachable engine keeps the saved session for the next page view', async () => {
  const t = environment({ saved: TOKEN, down: true });
  const warn = console.warn; console.warn = () => {};
  try {
    const client = createServerSession(t.env);
    assert.equal(await firstState(client), null);
    assert.equal(t.items.get(SESSION_STORAGE_KEY), TOKEN);
  } finally { console.warn = warn; }
});

test('sign-in leaves for the engine; sign-out ends the session there and locally, and old user objects stop issuing it', async () => {
  const t = environment({ saved: TOKEN });
  const client = createServerSession(t.env);
  const user = await firstState(client);
  const seen: (string | null)[] = [];
  client.onUserChanged(next => seen.push(next?.uid ?? null));
  await Promise.resolve();
  void client.signIn();
  void client.signIn({ chooseAccount: true });
  assert.deepEqual(t.navigations, [`/api/auth/github/start?client_state=${NONCE}&return=%2Fviewer%2F%3Fview%3Dexplore`,
    `/api/auth/github/start?client_state=${NONCE}&return=%2Fviewer%2F%3Fview%3Dexplore&prompt=select_account`]);
  assert.equal(t.tab.get(SIGN_IN_STATE_KEY), NONCE, 'the tab remembers the sign-in it started');
  await client.signOut();
  assert.deepEqual(seen, ['github-42', null]);
  assert.equal(t.items.has(SESSION_STORAGE_KEY), false);
  assert.deepEqual(t.calls.at(-1), { url: '/api/auth/session/revoke', method: 'POST', auth: `Bearer ${TOKEN}` });
  assert.equal(TOKEN in t.sessions, false);
  await assert.rejects(user!.getIdToken(), (error: { status?: number }) => error.status === 401);
});

test('another tab signing in as someone else replaces the user object, so requests see the account change', async () => {
  const t = environment({ saved: TOKEN, sessions: { [TOKEN]: account, [OTHER]: { ...account, subject: 'github-7' } } });
  const client = createServerSession(t.env);
  const first = await firstState(client);
  const seen: (string | null)[] = [];
  client.onTokenChanged(next => seen.push(next?.uid ?? null));
  await Promise.resolve();
  t.items.set(SESSION_STORAGE_KEY, OTHER); t.otherTab(SESSION_STORAGE_KEY);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(seen, ['github-42', 'github-7']);
  assert.notEqual(client.currentUser(), first);
  await assert.rejects(first!.getIdToken());
  t.otherTab('unrelated'); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(seen, ['github-42', 'github-7'], 'unrelated storage changes do not re-announce the session');
});

const CODE = 'c'.repeat(43);
const quiet = async (run: () => Promise<void>) => { const warn = console.warn; console.warn = () => {}; try { await run(); } finally { console.warn = warn; } };

test('an owner link is traded once for a session bound to this page, then confirmed like any sign-in', async () => {
  const t = environment({ hash: `#mlswarm_owner_code=${CODE}&section=tasks`,
    exchange: body => body.code === CODE ? Response.json({ token: TOKEN, client_state: body.client_state }) : new Response('{}', { status: 400 }) });
  const client = createServerSession(t.env);
  assert.deepEqual(t.urls, ['/viewer/?view=explore#section=tasks'], 'the code leaves the address before anything else runs');
  assert.equal((await firstState(client))?.uid, 'github-42');
  assert.equal(t.items.get(SESSION_STORAGE_KEY), TOKEN);
  assert.deepEqual(t.calls.map(call => `${call.method} ${call.url}`), ['POST /api/auth/local-owner/exchange', 'GET /api/auth/session']);
  assert.deepEqual(JSON.parse(t.calls[0].body!), { code: CODE, client_state: NONCE });
  assert.equal(t.calls[0].auth, null, 'the exchange carries no credential');
});

test('the single owner’s signed session survives the exchange, a reload and every request', async () => {
  // The shape identity/local-owner.ts issues: lo1.<base64url JSON claims>.<base64url HMAC-SHA256>.
  const owner = `lo1.${Buffer.from(JSON.stringify({ sub: 'local-owner', iat: 1, exp: 43201 })).toString('base64url')}.${'m'.repeat(43)}`;
  const sessions = { [owner]: { ...account, subject: 'local-owner' } };
  const t = environment({ hash: `#mlswarm_owner_code=${CODE}`, sessions,
    exchange: body => Response.json({ token: owner, client_state: body.client_state }) });
  const signedIn = await firstState(createServerSession(t.env));
  assert.equal(signedIn?.uid, 'local-owner');
  assert.equal(t.items.get(SESSION_STORAGE_KEY), owner);
  assert.equal(await signedIn!.getIdToken(), owner);
  // The next page view keeps the saved session.
  const reloaded = environment({ saved: owner, sessions });
  assert.equal((await firstState(createServerSession(reloaded.env)))?.uid, 'local-owner');
  assert.equal(reloaded.items.get(SESSION_STORAGE_KEY), owner);
  // Near misses stay refused: another prefix, a missing part, or a short signature.
  for (const bad of [owner.replace(/^lo1/, 'lo2'), owner.split('.').slice(0, 2).join('.'), `${owner.slice(0, -1)}`, `${owner}.extra`]) {
    const t2 = environment({ saved: bad, sessions: { [bad]: account } });
    let state: SessionUser | null | undefined;
    await quiet(async () => { state = await firstState(createServerSession(t2.env)); });
    assert.equal(state, null, bad);
    assert.equal(t2.items.get(SESSION_STORAGE_KEY), undefined);
  }
});

test('an owner exchange answered for another state, refused, or malformed never signs anyone in', async () => quiet(async () => {
  for (const [hash, exchange] of [
    [`#mlswarm_owner_code=${CODE}`, () => Response.json({ token: TOKEN, client_state: 'x'.repeat(43) })],
    [`#mlswarm_owner_code=${CODE}`, () => Response.json({ token: TOKEN })],
    [`#mlswarm_owner_code=${CODE}`, () => new Response('{"message":"expired"}', { status: 410 })],
    ['#mlswarm_owner_code=short', () => Response.json({ token: TOKEN, client_state: NONCE })],
  ] as [string, Exchange][]) {
    const t = environment({ hash, exchange });
    const client = createServerSession(t.env);
    assert.equal(await firstState(client), null, hash);
    assert.equal(t.items.has(SESSION_STORAGE_KEY), false);
    assert.deepEqual(t.urls, ['/viewer/?view=explore']);
  }
}));

test('an owner link never replaces a saved session', async () => quiet(async () => {
  let exchanges = 0;
  const t = environment({ hash: `#mlswarm_owner_code=${CODE}`, saved: OTHER, sessions: { [TOKEN]: account, [OTHER]: { ...account, subject: 'github-7' } },
    exchange: body => { exchanges++; return Response.json({ token: TOKEN, client_state: body.client_state }); } });
  const client = createServerSession(t.env);
  assert.equal((await firstState(client))?.uid, 'github-7');
  assert.equal(exchanges, 0, 'the code stays unused for a later sign-in');
  assert.deepEqual(t.urls, ['/viewer/?view=explore']);
}));

test('an owner link replaces a saved session the engine no longer accepts', async () => quiet(async () => {
  let exchanges = 0;
  const t = environment({ hash: `#mlswarm_owner_code=${CODE}`, saved: OTHER,
    exchange: body => { exchanges++; return Response.json({ token: TOKEN, client_state: body.client_state }); } });
  const client = createServerSession(t.env);
  assert.equal((await firstState(client))?.uid, 'github-42');
  assert.equal(exchanges, 1);
  assert.equal(t.items.get(SESSION_STORAGE_KEY), TOKEN);
}));

test('an owner link leaves the saved session alone while the engine cannot be reached', async () => quiet(async () => {
  const t = environment({ hash: `#mlswarm_owner_code=${CODE}`, saved: OTHER, down: true });
  const client = createServerSession(t.env);
  assert.equal(await firstState(client), null);
  assert.equal(t.items.get(SESSION_STORAGE_KEY), OTHER, 'kept for the next page view');
  assert.ok(!t.calls.some(call => call.url === '/api/auth/local-owner/exchange'));
}));

test('a lost exchange response is retried once with the same code and state', async () => {
  const bodies: string[] = [];
  const t = environment({ hash: `#mlswarm_owner_code=${CODE}`, exchange: body => {
    bodies.push(JSON.stringify(body));
    if (bodies.length === 1) throw new TypeError('connection reset');
    return Response.json({ token: TOKEN, client_state: body.client_state });
  } });
  const client = createServerSession(t.env);
  assert.equal((await firstState(client))?.uid, 'github-42');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});
