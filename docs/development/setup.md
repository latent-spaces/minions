# Development setup

Use Node.js 24+, Git and a local filesystem. From the repository root, start a
separate development engine using an absolute data path and a free port:

On macOS/Linux:

```sh
MINIONS_ENGINE_HOME=/absolute/path/to/minions-dev MINIONS_ENGINE_PORT=8788 npm run setup
```

On Windows PowerShell:

```powershell
$env:MINIONS_ENGINE_HOME = 'C:\path\to\minions-dev'
$env:MINIONS_ENGINE_PORT = '8788'
npm run setup
```

Use an absolute Windows path on Windows. Keep `MINIONS_ENGINE_HOME` and
`MINIONS_ENGINE_PORT` set to the same values for subsequent commands. Isolated setup
skips client registration and command linking. Keep development data separate from
your everyday engine and start no models without explicit approval.

The engine serves the built app. For frontend iteration, rebuild it from the
repository root, then reload the page at the isolated engine's own address:

```sh
npm run build:web
```

The running engine serves the updated files without a restart. Use the exact
`http://127.0.0.1:PORT/` address printed by setup for integrated checks.
`npm --prefix apps/web run dev` starts Vite, but its separate origin cannot obtain
the standalone owner's session. Setting `KARMA_LOCAL_API_URL` forwards API requests
without changing that sign-in restriction. See the
[engine guide](../self-hosted-engine.md) for configuration.

Run focused checks from the repository root:

```sh
npm run build:web
npm run typecheck:backend
npm run test:all
```

[Tests](../../tests/README.md) describes the fast core and disposable data isolation.
Before running `npm ci`, stop affected engines and services: it replaces workspace
dependency folders. GitHub Actions runs the core checks on pull requests and pushes
to `main`.
