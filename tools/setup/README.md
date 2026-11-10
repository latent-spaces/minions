# One-command engine setup

`npm run setup` takes a fresh clone to a running standalone engine with this
computer connected, as [the engine instructions](../../docs/self-hosted-engine.md)
describe: dependencies, builds, database initialization, engine start, the
owner sign-in link and the connector's `setup`, then it supervises the engine
until Ctrl+C. It reuses the existing engine CLI (`apps/server/dist/self-hosted-main.js`),
the connector CLI (`packages/agent-cli/src/cli.mjs`), each package's own build
script and the npm resolution in `tools/setup/npm-cli.mjs`; it adds no second
implementation of any of them.

Every child the script starts is Node itself (npm's JS entry, the engine, the
connector) without a shell, so checkout paths with spaces and Windows work alike;
npm runs the package build scripts as any `npm run` does. The engine runs with an
IPC channel and is stopped with `mlswarm-stop`, the same graceful request on every
platform. Platform decisions live in [engine-plan.mjs](engine-plan.mjs) with no side
effects; `npm run test:setup` checks them for Windows and POSIX, and runs the
command's early refusals, which stop before anything is installed or started.
Install and build output is kept and shown only when a step fails; the engine's
routine output goes to `engine.log` in the engine directory. When the port is busy,
the command asks it for an owner sign-in link with the existing `owner-link`
command: only the engine running with this owner file can issue one, so success
means the engine is already running, and the command opens the local app and runs
the connector's `setup` instead of starting anything. A macOS pass of the command is not Windows acceptance: run it natively
there too.
