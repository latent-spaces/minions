# Tests

The suite is a small, fast core (owner decision, 15 November 2026): typechecks plus a
handful of smoke tests per package. After root `npm ci`, use Node.js 24+:

```sh
npm run test:all        # everything below, one log per step
npm run test:backend    # engine smoke tests on a disposable store
npm run test:connector  # connector smoke tests
npm run test:setup      # setup tool checks
```

`run.mjs` builds the connector, then owns a unique disposable test session: a fresh
temporary folder with the session's SQLite store and media, and local sign-in. It
never imports or exports the engine's saved state and drops inherited cloud, provider
and GitHub credentials and model-execution flags. Your engine may remain running.

| Folder | What it covers |
| --- | --- |
| `apps/server/test` | Standalone engine smoke, HTTP flow, owner session, owner routes, web agent starts |
| `packages/agent-cli/test` | Owner client, service bootstrap, MCP configuration, setup screen, Windows command quoting |
| `tools/setup/test` | Engine setup plan and npm launching |
| `tests/support` | The disposable session, loopback-only network and process-tree helpers the runners use |

Add a test only when it guards something the typecheck cannot, and keep it fast.
