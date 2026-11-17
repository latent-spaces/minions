# One-command engine setup

`npm run setup` takes a fresh clone to a running standalone engine with the
connector signed in and its shared service started, as [the engine instructions](../../docs/self-hosted-engine.md)
describe: dependencies, builds, database initialization, engine start, opening
the local app, the connector's `setup` and the connector's `register --install-skill`, which
registers one `minions` entry with Claude Code and Codex where they are installed
and installs their bundled Minions skill, preserving customized files. Both are
skipped with `--no-register` or for a test engine in its own `MINIONS_ENGINE_HOME`;
a failure is a warning. The engine runs detached in the
background, with its output in `engine.log`, so it keeps running after the
command, the terminal or the coding session that ran it ends; `minions stop`
stops it. The port it ran on is saved in
`engine-settings.json` and reused by later `setup` and `stop` runs unless
`MINIONS_ENGINE_PORT` names another; otherwise it is 8787. When another program
holds the port, setup stops and names that program; it never moves to another port. The summary
names the connector's `tool` command, which calls the service's MCP tools until the
coding agent is restarted and loads them. It reuses the existing engine CLI (`apps/server/dist/self-hosted-main.js`),
the connector CLI (`packages/agent-cli/src/cli.mjs`), each package's own build
script and the npm resolution in `tools/setup/npm-cli.mjs`; it adds no second
implementation of any of them.

Setup includes development and optional dependencies even when npm's `omit`
setting excludes them: source builds need development tools, and Sharp/esbuild
need optional platform binaries. A successful install records the lockfile hashes
and Node/platform identity in `node_modules/.minions-setup.json`. Setup reuses it
only while those match and the recorded packages and dependency tree are present.
An older or externally changed install gets a fresh `npm ci` once.

Every child the script starts is Node itself (npm's JS entry, the engine, the
connector) without a shell, so checkout paths with spaces and Windows work alike;
npm runs the package build scripts as any `npm run` does. Windows has no graceful
signal for a detached process, so `stop` uses the engine CLI's `stop` on every
platform: a loopback request carrying a key derived from the owner file's signing
secret, which only the person who can read that file can make. If the listener is
gone but the database lock remains, stop reports an unconfirmed shutdown and
update leaves the checkout unchanged. A starting or stopping engine can hold the
lock; wait and retry stop. If a crash or computer restart left a stale lock, run
`minions start` to recover it, then retry stop or update. A lock left by an
engine that crashed or a computer that restarted is replaced only if its recorded
process no longer exists. A reused PID or an uncertain process check requires the
manual inspection described by the startup error; timestamps alone never authorize
replacement. Platform decisions live in [engine-plan.mjs](engine-plan.mjs) with no side
effects; `npm run test:setup` checks them for Windows and POSIX, and runs the
command's early refusals, which stop before anything is installed or started.
Install and build output is kept and shown only when a step fails; when the engine
stops during startup, the command shows what it wrote to `engine.log`. When the port is busy,
the command runs the engine CLI's `check-running`, which asks the engine for an
owner session and verifies it with this owner file's secret: only the engine
running with this owner file can sign one, so success means the engine is already
running, and the command opens the local app and runs
the connector's `setup` instead of starting anything.

## The `minions` command

[minions.mjs](minions.mjs) is the root package's `minions` bin. At the end of a
successful run, setup links it onto PATH with `npm link --ignore-scripts`, so npm
writes the Windows `.cmd` and PowerShell shims; a test engine (`MINIONS_ENGINE_HOME`)
and a Git worktree keep the computer's existing command. Its commands:

- `start [--open]` starts the engine detached and the connector's `service-start`. When
  nothing is built or initialized yet it runs setup instead. It never rebuilds:
  after pulling yourself, run `minions update`, which rebuilds when the build is older
  than the checked-out commit.
- `stop [--now] [--wait-minutes N]` runs the connector's `service-stop --after-turns`
  (up to 10 minutes by default), then the engine CLI's `stop`. When turns are still
  finishing, the engine is left running so they can complete. `--now` ends them at once.
  `npm run stop` runs it.
- `status [--json]`, `open`, `logs [--service] [--lines N] [--follow]`.
- `setup [...]` runs this setup; `update` checks `main` for updates (refusing
  another branch, uncommitted tracked changes or divergent history), stops as `stop`
  does, then pulls fast-forward only and runs setup. A fresh build with no update
  leaves the running service alone. If turns are still draining, the checkout stays unchanged.
  An interrupted or failed update keeps an ignored marker in the backend build
  directory, so the next update retries setup even if the backend was already emitted.

At a terminal it draws a few ASCII critters and colors; when piped or called by an
agent, or with `MINIONS_PLAIN=1`, it prints plain lines, and `NO_COLOR` drops the
colors. Both commands share [engine-control.mjs](engine-control.mjs) for finding the
installation and starting, checking and stopping the engine.

A macOS pass of the command is not Windows acceptance: run it natively
there too.
