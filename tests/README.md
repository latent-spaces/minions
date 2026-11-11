# Test ownership

After root `npm ci`, use Node.js 24+:

```sh
npm run test:guards
npm --workspace @mlswarm/web exec -- playwright install --with-deps chromium
npm run test:backend
# Selectors are relative to apps/server, the Vitest configuration owner:
node tests/run.mjs ../../tests/integration/web-route.test.ts
```

`run.mjs` builds the connector, then owns a unique disposable test session: a fresh
temporary folder with the session's SQLite store and media, and local sign-in. It
never imports or exports the engine's saved state. It forwards shutdown signals,
retains diagnostics and supplies only runtime-discovery variables. It drops inherited
cloud, provider and GitHub credentials and model-execution flags. Your engine may
remain running.

Browser acceptance uses the production components in an isolated Vite page and
Chromium, against the real API started in the same session (`apps/server/test/api-process.ts`).
Tests sign in with server sessions issued for synthetic GitHub accounts; image
screening is a fake moderator, and non-loopback browser requests are blocked. Install
Chromium with the command above (also done in CI); no personal browser profile or
model is used. Alternate local browser locations can be supplied as
`MLSWARM_TEST_BROWSER_EXECUTABLE` / `MLSWARM_TEST_BROWSER`.

Reset helpers require a matching disposable session (`NODE_ENV=test`, a
`MLSWARM_TEST_SESSION` name and no `MLSWARM_ENGINE`) and clear only that session's own
store. Bare Vitest without a valid disposable environment cannot reset records.

| Owner | Cases and runner |
| --- | --- |
| `apps/server/test` | Server/domain cases; serial Vitest via disposable launcher |
| `tests/integration` | Cross-component acceptance; same launcher/config |
| `tests/support` | Disposable-session, network and process guards; Node test runner |
| `packages/agent-cli/test` | Connector credential and origin guards; Node runner |

Benchmark studies are explicit
operator actions, not startup or default tests. Moving tests grants no model, GitHub or cloud authority.

Project start is covered by `npm run test:backend -- test/access-matrix.test.ts test/web-agent-starts.test.ts test/start-announcement.test.ts test/scheduled-start.test.ts`.
