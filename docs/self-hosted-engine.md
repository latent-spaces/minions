# Run the standalone engine locally

The standalone entry runs the API and delivery worker in one process, backed by
one local SQLite database and a private media directory. It serves the local app
on `http://127.0.0.1:8787/` and accepts loopback connections only. Use
Node.js 24 or newer, Git and a local filesystem; a network share is not supported.
It needs no cloud account. This engine is the only way Minions runs.

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

1. checks the engine port: 8787 (or a port saved by an earlier run, or an explicit
   `MINIONS_ENGINE_PORT`). When another program holds it, setup stops, names that
   program and stops nothing; it never moves to another port. On a first run it also checks the owner identity (below) before
   installing anything;
2. installs development and optional build dependencies with `npm ci` when needed.
   Reuse requires a setup receipt matching both lockfiles and the current Node,
   operating system and architecture, the recorded packages and a valid dependency
   tree; interrupted, outdated or externally pruned installs are redone;
3. builds the contracts, engine, local app and connector
   with each package's own `npm run build` script;
4. initializes the database on the first run, and keeps it on later runs;
5. starts the engine and opens the local app in your browser;
6. runs the connector's `setup` for this computer, then registers its shared MCP
   server and installs the bundled Minions skill for the Claude Code and Codex
   clients it finds, preserving customized skills.
   It also links the `minions` command when eligible (below).

Install and build output is shown only when a step fails. The engine's routine
activity and errors go to `engine.log` in the engine directory; if the engine stops
during startup, the command shows what it wrote there. The engine runs detached in
the background, so it keeps running after the command, the terminal or the coding
session that ran it ends; `minions stop` stops it. The port it ran on is saved in
`engine-settings.json`, so later runs reuse it unless `MINIONS_ENGINE_PORT` names
another. Running it again later rebuilds, keeps the existing database and connector
installation, starts the engine and opens the local app again. Running it while
the engine already runs (from another window) starts nothing: it opens the local
app and runs the connector's `setup` again, which finishes at once when the
connector is already set up. It starts no model.

The local app has one person, the owner, so it opens without a sign-in step. A
page the engine serves at its own loopback address gets the owner's session from
the engine; other websites and other hosts are refused. Without a desktop (over
SSH, in CI, or with `MINIONS_NO_BROWSER=1`) the command prints the address to open.

The connector's `setup` signs in with no human step: it asks the engine for the
owner's local session the same way and reads the owner's name. The engine's
computer is its only computer, so there is no computer connection, approval page
or code, and the connector saves no computer credential. If the connector fails,
the engine keeps running; run `npm run setup` again.

The final registration command writes one shared `minions` HTTP entry for each
client it finds. It registers Claude Code through `claude mcp add-json` when its
command is available and adds Minions to Claude's tool allowlist. It updates
Codex's `config.toml` when its home exists (`CODEX_HOME` when absolute, otherwise
`~/.codex`), preserving unrelated settings. Older `mlswarm` MCP entries are retired.
It runs clients without a shell; on Windows an npm `.cmd` shim runs its JavaScript
entry with Node.

Pass `--no-register` (`npm run setup -- --no-register`) to skip client registration
and skill installation;
an isolated engine selected with `MINIONS_ENGINE_HOME` also skips it. Isolated
engines and Git worktrees skip command linking. See the
[setup tool guide](../tools/setup/README.md) for details. A failed registration is a
warning and setup carries on.
Restart an existing coding chat to load the tools. Until then, the summary prints the
connector's `tool` command, with which a coding agent calls the same tools from a
terminal (`tool --list`, then `tool TOOL_NAME '{"field":"value"}'`).

The short closing summary gives the local app's address, says the engine runs in the
background until `minions stop`, the client registration result, and the `tool`
fallback or manual `mcp-config` command. On an everyday main checkout, setup links
the `minions` command with `npm link --ignore-scripts`; a failed link prints the
manual command. The engine wrapper selects a separate connector installation,
so connector setup skips its usual client and GitHub steps. The wrapper installs
the skill through `register --install-skill`; its customization checks and skill
records use this engine's selected service home. GitHub sign-in is not changed.
The summary reminds you to
sign in with `gh auth login` for repository work. Setup starts no model.

The owner's name and email come from `--owner-name` and `--owner-email`
(`npm run setup -- --owner-name 'Your Name' --owner-email you@example.com`), or
from Git's `user.name` and `user.email` when the options are omitted; the command
prints which identity it used. They are only needed on the first run.

### Where the files are

Engine files and the connector's separate credentials live in one private
directory: `~/.minions/engine` on macOS and Linux, `%USERPROFILE%\.minions\engine`
on Windows. Set `MINIONS_ENGINE_HOME` to an absolute path to choose another, and
`MINIONS_ENGINE_PORT` to use a port other than 8787 (or the port a first run chose and
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
`MINIONS_ENGINE_HOME`) and run the command again.

## Owner sessions

The local app asks the engine for an owner session when it opens, and again when
its session has expired or been refused. The engine issues one only to a JSON
request from this computer whose `Host` is `127.0.0.1` or `localhost` at the
engine's port and whose `Origin` is that same address, and to at most 30 requests
a minute. Sessions last twelve hours. To end every issued session, replace the
private signing secret or advance its `validAfter` timestamp and restart the engine.

`node apps/server/dist/self-hosted-main.js check-running --url http://127.0.0.1:8787`,
with the same `MINIONS_*` settings the engine was started with, exits 0 only when
the engine at that address signs sessions with this owner file's secret. `npm run
setup` uses it to recognize that a busy port is its own engine.

## What this protects against

Minions treats the processes your account runs on this computer as trusted. The
loopback-only listener, the `Host` and `Origin` checks on owner sessions and the
signed stop request keep other computers and other websites out: a web page in
your browser cannot get an owner session or stop the engine. They do not stop a
program running as your own account. Such a program can send those same headers,
read the private owner file (`owner.json`) and database (`engine.sqlite`), and act as the owner. The same holds for
code in a checkout you run setup in, and for any account that can read your Minions
home. Do not run setup in a checkout you do not trust, and do not share the account.

Background agents' commands run in their coding client's sandbox, which keeps their
writes to their checkout. For Claude Code it also keeps the Minions private folders
unreadable to the worker's shell and Read tool, including custom engine, service and
credential folders (the Windows rules are not yet verified on native Windows).
Codex also denies these folders to sandboxed commands through a named permission
profile, checked before each start and resume. This is verified on native macOS;
Linux and Windows remain unverified. Windows Codex workers may refuse to start
where the native sandbox cannot enforce the policy; there is no unrestricted
fallback. Either sandbox can still reach this engine over loopback, so it does not stop a hostile model
from asking for an owner session. Treat per-agent permissions, Pause and the
connector's mission and checkout checks as workflow controls, not as protection from
a hostile model or program running under your account.

## Stopping and recovery

Run `minions stop` (or `npm run stop`). It first stops the connector's shared
service, letting turns in progress finish (up to 10 minutes; `--now` ends them at
once), and leaves the engine running when turns are still finishing. Then it asks the engine at its saved address to stop, proving itself
with a key derived from the owner file's signing secret, so only someone who can
read that file can stop the engine and no web page can. Windows has no graceful
signal for a detached process, so every platform uses this same request. Shutdown
drains held HTTP requests and the delivery worker before closing SQLite, then
removes the `.lock` file; the stop waits up to 20 seconds for the engine to
release that lock. The next start replaces a lock left behind by a crash or a computer
restart only when its recorded process no longer exists. If that process ID now
belongs to another program, startup refuses the lock and requires the inspection
described below. A file timestamp cannot safely distinguish a reboot from a clock
adjustment. This rule also applies to locks written by older engine versions.
`minions start` starts both again without rebuilding.

A second engine on the same database is refused by its `.lock` file, and the
refusal names that file. An engine can hold the lock while starting or stopping
without answering at its saved address, so a failed stop request does not prove
that the lock is stale. Wait and retry first. Remove the named lock only after
inspecting its recorded PID and confirming in the system process list that no
engine process is using this database. Nothing
stops or signals another process to recover a lock. The engine runs its delivery
worker in the same process. Live views follow the engine's own writes at once; a write that
another program commits to the database file reaches them within about a second,
so make changes through the engine where you can.

Stale-lock recovery uses a private `.lock.recovery` guard so concurrent starts
cannot both replace the stale lock. A crash during recovery can leave that guard
behind; `minions start` does not automatically remove it. Wait and retry first, then inspect
its recorded PID and confirm no engine is starting or recovering this database
before removing only the guard named in the error.

An engine started by hand (`self-hosted-main.js start`, without the setup command)
keeps the default SIGHUP behavior on macOS and Linux, so one started with `nohup`
survives a closed terminal.

## Connector commands for this installation

The connector installation created by the command keeps its service state and
credentials apart from a default connector installation in `~/.minions/service` and
`~/.minions/mcp`, in the two directories above. It is not fully separate: its project
folders use the same workspace as a default installation, `~/minions/main` and
`~/minions/projects/<project>` (under `%USERPROFILE%` on Windows), because only an
enrolled HTTPS origin gets its own `~/minions/instances/<id>` workspace. None of these
folders is shared with an everyday Karma42 install (`~/.karma42`, `~/karma42`), the
product's earlier name; nothing is read from or moved out of those folders. Address the installation with the same
two settings the command prints:

macOS or Linux:

```sh
export MINIONS_SERVICE_HOME="$HOME/.minions/engine/connector-service"
export MINIONS_CREDENTIAL_HOME="$HOME/.minions/engine/connector-credentials"
node packages/agent-cli/src/cli.mjs mcp-config --client claude
```

Windows PowerShell:

```powershell
$env:MINIONS_SERVICE_HOME = Join-Path $env:USERPROFILE '.minions\engine\connector-service'
$env:MINIONS_CREDENTIAL_HOME = Join-Path $env:USERPROFILE '.minions\engine\connector-credentials'
node packages/agent-cli/src/cli.mjs mcp-config --client claude
```

Use `--client codex` or `--client other` as appropriate and follow the printed
instructions to add the `minions` connection (a test engine in its own
`MINIONS_ENGINE_HOME` is not registered by setup, so this replaces your everyday one). Preserve your
other connections, including an everyday Karma42 install's `karma42` entry, and never
copy credential-file contents into client settings. Client registration does not approve a background mission; model
execution still requires its own approval. `service-status` and `service-stop`
inspect or stop only this installation. Leave `MINIONS_SELF_HOSTED_ORIGIN` unset:
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
