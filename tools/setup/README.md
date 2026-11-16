# One-command engine setup

`npm run setup` takes a fresh clone to a running standalone engine with the
connector signed in and its shared service started, as [the engine instructions](../../docs/self-hosted-engine.md)
describe: dependencies, builds, database initialization, engine start, opening
the local app, the connector's `setup` and the connector's `register`, which
registers one `minions` entry with Claude Code and Codex where they are installed
(skipped with `--no-register` or for a test engine in its own `MINIONS_ENGINE_HOME`;
a failure is a warning). The engine runs detached in the
background, with its output in `engine.log`, so it keeps running after the
command, the terminal or the coding session that ran it ends; `npm run stop`
([engine-stop.mjs](engine-stop.mjs)) stops it. The port it ran on is saved in
`engine-settings.json` and reused by later `setup` and `stop` runs unless
`MINIONS_ENGINE_PORT` names another; otherwise it is 8787. When another program
holds the port, setup stops and names that program; it never moves to another port. The summary
names the connector's `tool` command, which calls the service's MCP tools until the
coding agent is restarted and loads them. It reuses the existing engine CLI (`apps/server/dist/self-hosted-main.js`),
the connector CLI (`packages/agent-cli/src/cli.mjs`), each package's own build
script and the npm resolution in `tools/setup/npm-cli.mjs`; it adds no second
implementation of any of them.

Every child the script starts is Node itself (npm's JS entry, the engine, the
connector) without a shell, so checkout paths with spaces and Windows work alike;
npm runs the package build scripts as any `npm run` does. Windows has no graceful
signal for a detached process, so `stop` uses the engine CLI's `stop` on every
platform: a loopback request carrying a key derived from the owner file's signing
secret, which only the person who can read that file can make. A lock left by an
engine that crashed or a computer that restarted names a process that no longer
exists, so the next start replaces it. Platform decisions live in [engine-plan.mjs](engine-plan.mjs) with no side
effects; `npm run test:setup` checks them for Windows and POSIX, and runs the
command's early refusals, which stop before anything is installed or started.
Install and build output is kept and shown only when a step fails; when the engine
stops during startup, the command shows what it wrote to `engine.log`. When the port is busy,
the command runs the engine CLI's `check-running`, which asks the engine for an
owner session and verifies it with this owner file's secret: only the engine
running with this owner file can sign one, so success means the engine is already
running, and the command opens the local app and runs
the connector's `setup` instead of starting anything. A macOS pass of the command is not Windows acceptance: run it natively
there too.
