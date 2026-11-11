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

1. refuses to continue when the engine port is held by another program, and stops
   nothing; on a first run it also checks the owner identity (below) before
   installing anything;
2. runs `npm ci` unless npm's record of a finished install
   (`node_modules/.package-lock.json`) is at least as new as `package-lock.json`,
   so an interrupted or outdated install is redone;
3. builds the contracts, engine, local app and connector
   with each package's own `npm run build` script;
4. initializes the database on the first run, and keeps it on later runs;
5. starts the engine and opens the local app in your browser;
6. runs the connector's `setup` for this computer.

Install and build output is shown only when a step fails. The engine's routine
activity goes to `engine.log` in the engine directory; its errors stay on the
console. The command keeps the engine running in the foreground until you press
Ctrl+C. Running it again later rebuilds, keeps the existing database and connector
installation, starts the engine and opens the local app again. Running it while
the engine already runs (from another window) starts nothing: it opens the local
app and runs the connector's `setup` again, which finishes at once for an
approved computer. It starts no model.

The local app has one person, the owner, so it opens without a sign-in step. A
page the engine serves at its own loopback address gets the owner's session from
the engine; other websites and other hosts are refused. Without a desktop (over
SSH, in CI, or with `MLSWARM_NO_BROWSER=1`) the command prints the address to open.

One step stays in your browser, because it is your own yes: **approve this
computer.** The connector shows the approval page with its code, opens the page
when you press Enter, and waits up to ten minutes. Check the code and approve in
the local app. If the wait runs out or the connector fails, the engine keeps
running; run `npm run setup` again, in another terminal window or after Ctrl+C, to
connect.

The command then prints the connector's `mcp-config` command for registering this
installation in your coding client, and reminds you to sign in to GitHub with
`gh auth login` for project work. This separate installation never changes
coding-client settings or GitHub sign-in on its own.

The owner's name and email come from `--owner-name` and `--owner-email`
(`npm run setup -- --owner-name 'Your Name' --owner-email you@example.com`), or
from Git's `user.name` and `user.email` when the options are omitted; the command
prints which identity it used. They are only needed on the first run.

### Where the files are

Engine files and the connector's separate credentials live in one private
directory: `~/.mlswarm/engine` on macOS and Linux, `%USERPROFILE%\.mlswarm\engine`
on Windows. Set `MLSWARM_ENGINE_HOME` to an absolute path to choose another, and
`MLSWARM_ENGINE_PORT` to use a port other than 8787. Keep both settings the same on
later runs: the connector installation is bound to the engine address.

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

Press Ctrl+C once in the setup terminal, also while the connector waits for the
approval. Closing the terminal window stops the engine the same way (SIGHUP on
macOS and Linux; on Windows a closed console, and Ctrl+Break, too; Windows ends
the process about 10 seconds after the window closes). The command asks the engine
to stop; shutdown drains held HTTP requests and the delivery worker before closing
SQLite, then removes the `.lock` file. The command exits with status 0 only after
a clean stop; if the engine fails to stop, or has to be killed after 15 seconds,
it exits non-zero and the lock remains for inspection. Stopping the engine does not
stop the connector's shared service; use the connector's `service-stop` (below)
for that.

A second engine on the same database is refused by its `.lock` file. After a
crash, confirm that no engine is running before explicitly removing that lock;
startup never guesses that a lock is stale, and the command names the lock file
when the engine refuses to start because of it. The engine runs its delivery
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
