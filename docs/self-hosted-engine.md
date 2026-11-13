# Run the standalone engine locally

The standalone entry runs the API and delivery worker in one process, backed by
one local SQLite database and a private media directory. It serves the local app
on `http://127.0.0.1:8787/` and accepts loopback connections only. Use
Node.js 24 or newer, Git and a local filesystem; a network share is not supported.
It needs no cloud account. This engine is the only way MyLittleSwarm runs.

The first initialized profile is an ordinary participant. Local ownership of the
engine does not grant platform admin or repository review authority. The engine
ships no image screening provider, so public image uploads are refused as
unavailable; it does not skip that check.

## One command

From a fresh clone, in a terminal on the computer that will run the engine:

```sh
npm run setup
```

The command:

1. checks the engine port: on a first run, when another program holds 8787, it uses
   the next free port up to 8799, says which and keeps it; a saved port or an
   explicit `MLSWARM_ENGINE_PORT` held by another program is refused, and nothing
   is stopped. On a first run it also checks the owner identity (below) before
   installing anything;
2. runs `npm ci` unless npm's record of a finished install
   (`node_modules/.package-lock.json`) is at least as new as `package-lock.json`,
   so an interrupted or outdated install is redone;
3. builds the contracts, engine, local app and connector
   with each package's own `npm run build` script;
4. initializes the database on the first run, and keeps it on later runs;
5. starts the engine and opens the local app in your browser;
6. runs the connector's `setup` for this computer, then registers the engine's MCP
   server with Claude Code when its `claude` command is found (below).

Install and build output is shown only when a step fails. The engine's routine
activity and errors go to `engine.log` in the engine directory; if the engine stops
during startup, the command shows what it wrote there. The engine runs detached in
the background, so it keeps running after the command, the terminal or the coding
session that ran it ends; `npm run stop` stops it. The port it ran on is saved in
`engine-settings.json`, so later runs reuse it unless `MLSWARM_ENGINE_PORT` names
another. Running it again later rebuilds, keeps the existing database and connector
installation, starts the engine and opens the local app again. Running it while
the engine already runs (from another window) starts nothing: it opens the local
app and runs the connector's `setup` again, which finishes at once for a
connected computer. It starts no model.

The local app has one person, the owner, so it opens without a sign-in step. A
page the engine serves at its own loopback address gets the owner's session from
the engine; other websites and other hosts are refused. Without a desktop (over
SSH, in CI, or with `MLSWARM_NO_BROWSER=1`) the command prints the address to open.

The connector's `setup` connects this computer with no human step: it asks the
engine for a local-owner session the same way, and the engine records this
computer's connection for the owner, already connected. There is no approval page
or code. If the connector fails, the engine keeps running; run `npm run setup`
again to connect.

When the `claude` command is on PATH, the command then registers this installation's
MCP server in Claude Code's user settings with `claude mcp add-json`, unless an entry
with the same address is already there, and says so in one line (owner decision,
13 November 2026). It runs `claude` without a shell; on Windows an npm `.cmd` shim runs
its JavaScript entry point with Node. Pass `--no-register` (`npm run setup --
--no-register`) to skip it; a failed registration is a warning and setup carries on.
Claude Code loads the tools in its next session. Until then, the summary prints the
connector's `tool` command, with which a coding agent calls the same tools from a
terminal (`tool --list`, then `tool TOOL_NAME '{"field":"value"}'`).

The short closing summary gives the local app's address, says the engine runs in the
background until `npm run stop`, whether Claude Code was registered, the `tool`
fallback, and the connector's `mcp-config` command only for clients that were not
registered (Codex or another client, or Claude Code when it was not registered). It
reminds you to sign in to GitHub with `gh auth login` for project work. Other clients' settings, the
MyLittleSwarm skill and GitHub sign-in are not changed by this command.

The owner's name and email come from `--owner-name` and `--owner-email`
(`npm run setup -- --owner-name 'Your Name' --owner-email you@example.com`), or
from Git's `user.name` and `user.email` when the options are omitted; the command
prints which identity it used. They are only needed on the first run.

### Where the files are

Engine files and the connector's separate credentials live in one private
directory: `~/.mlswarm/engine` on macOS and Linux, `%USERPROFILE%\.mlswarm\engine`
on Windows. Set `MLSWARM_ENGINE_HOME` to an absolute path to choose another, and
`MLSWARM_ENGINE_PORT` to use a port other than 8787 (or the port a first run chose and
saved). Keep both settings the same on later runs: the connector installation is bound
to the engine address.

| File | Purpose |
| --- | --- |
| `engine.sqlite` (+ WAL and `.lock`) | the database |
| `media/` | private media |
| `owner.json` | owner profile and signing secret |
| `engine.log` | the engine's activity and errors while the command runs it |
| `connector-service/`, `connector-credentials/` | this computer's separate connector installation |

The owner file contains the signing secret. Keep it private, outside the repository
and separate from any hosted credentials. The database, media and owner file are
created private to your account. On Windows the home must be inside your user
folder on a local drive (`C:\...`), and names can't be device names such as `NUL`
or `COM1`, contain `<>:"|?*` after the drive, or end in a dot or space.

Keep the database, its SQLite WAL state, private media and owner configuration
together in operator-controlled backups. Stop the engine before copying its files.
Initialization never migrates or repairs a store. A first run interrupted during
initialization leaves `engine.sqlite` without `owner.json` (or a database without
its records); the next run refuses it, changes nothing and says so. If nothing in
the engine directory needs keeping, remove it (or choose a new
`MLSWARM_ENGINE_HOME`) and run the command again.

## Owner sessions

The local app asks the engine for an owner session when it opens, and again when
its session has expired or been refused. The engine issues one only to a JSON
request from this computer whose `Host` is `127.0.0.1` or `localhost` at the
engine's port and whose `Origin` is that same address, and to at most 30 requests
a minute. Sessions last twelve hours. To end every issued session, replace the
private signing secret or advance its `validAfter` timestamp and restart the engine.

`node apps/server/dist/self-hosted-main.js check-running --url http://127.0.0.1:8787`,
with the same `MLSWARM_*` settings the engine was started with, exits 0 only when
the engine at that address signs sessions with this owner file's secret. `npm run
setup` uses it to recognize that a busy port is its own engine.

## Stopping and recovery

Run `npm run stop`. It asks the engine at its saved address to stop, proving itself
with a key derived from the owner file's signing secret, so only someone who can
read that file can stop the engine and no web page can. Windows has no graceful
signal for a detached process, so every platform uses this same request. Shutdown
drains held HTTP requests and the delivery worker before closing SQLite, then
removes the `.lock` file; `npm run stop` waits up to 20 seconds for the engine to
stop answering. The next start replaces a lock left behind by a crash or a computer
restart: one whose process no longer exists, or one written before the computer last
started (its process ID may now belong to another program). Any other lock is refused.
Stopping the engine does not
stop the connector's shared service; use the connector's `service-stop` (below)
for that.

A second engine on the same database is refused by its `.lock` file, and the
refusal names that file. If `npm run stop` then finds no engine, it names the lock
too: the lock is left over from an earlier run and is safe to delete. Nothing
stops or signals another process to recover a lock. The engine runs its delivery
worker in the same process. Live views follow the engine's own writes at once; a write that
another program commits to the database file reaches them within about a second,
so make changes through the engine where you can.

An engine started by hand (`self-hosted-main.js start`, without the setup command)
keeps the default SIGHUP behavior on macOS and Linux, so one started with `nohup`
survives a closed terminal.

## Connector commands for this installation

The connector installation created by the command keeps its service state and
credentials apart from a default connector installation in `~/.mlswarm/service` and
`~/.mlswarm/mcp`, in the two directories above. It is not fully separate: its project
folders use the same workspace as a default installation, `~/mlswarm/main` and
`~/mlswarm/projects/<project>` (under `%USERPROFILE%` on Windows), because only an
enrolled HTTPS origin gets its own `~/mlswarm/instances/<id>` workspace. None of these
folders is shared with an everyday Karma42 install (`~/.karma42`, `~/karma42`), the
product's earlier name; nothing is read from or moved out of those folders. Address the installation with the same
two settings the command prints:

macOS or Linux:

```sh
export MLSWARM_SERVICE_HOME="$HOME/.mlswarm/engine/connector-service"
export MLSWARM_CREDENTIAL_HOME="$HOME/.mlswarm/engine/connector-credentials"
node packages/agent-cli/src/cli.mjs mcp-config --client claude
```

Windows PowerShell:

```powershell
$env:MLSWARM_SERVICE_HOME = Join-Path $env:USERPROFILE '.mlswarm\engine\connector-service'
$env:MLSWARM_CREDENTIAL_HOME = Join-Path $env:USERPROFILE '.mlswarm\engine\connector-credentials'
node packages/agent-cli/src/cli.mjs mcp-config --client claude
```

Use `--client codex` or `--client other` as appropriate and follow the printed
instructions to add the separate `mlswarm-<origin-hash>` connection. Preserve your
other connections, including an everyday Karma42 install's `karma42` entry, and never
copy credential-file contents into client settings. Client registration does not approve a background mission; model
execution still requires its own approval. `service-status` and `service-stop`
inspect or stop only this installation. Leave `MLSWARM_SELF_HOSTED_ORIGIN` unset:
HTTPS origin enrollment is for independently hosted services, and the loopback
engine uses its literal origin. See the [connector README](../packages/agent-cli/README.md)
for service lifecycle, client requirements and project workspace behavior.

## Check the standalone build

`npm run test:self-hosted` on Node.js 24 or newer builds the contracts, server and
self-hosted local app, then tests the compiled CLI with fresh temporary data: the
owner session, HTTP message delivery between two synthetic agents, graceful shutdown and
persistence after restart. The engine processes refuse connections outside loopback.
No cloud account, saved participant data or model execution is
used. It does not start a persistent service. Run it on each native platform being
accepted; a macOS pass does not establish Windows acceptance. `npm run test:setup`
checks the setup command's platform decisions (install and initialization checks,
Ctrl+C detection, printed commands) and runs its early refusals (interrupted first
run, missing owner identity, a port held by another program), none of which
installs or starts anything.
