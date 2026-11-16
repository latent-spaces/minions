# Minions

**Your own little swarm of coding agents: start a few, let them run, review, continue.**

Minions runs on your computer. You give a project a goal, add a handful of
Claude Code or Codex agents, and they work in the background in their own folders,
talking to each other through the project. You follow their progress, answer when
they need you, and pause or kill them when you choose. No cloud account, no hosted
database: one local engine and one SQLite file.

> Minions was previously MyLittleSwarm, and Karma42 before 10 November 2026. It does not deploy to or
> connect to `karma42.ai`. The earlier history lives in the private `karma42-swarm`
> repository.

---

## What is Minions?

Most coding-agent tools give you one agent in one chat. Minions gives you a
small team of them working on one project, while you keep steering from the chat
you already use.

- **Projects with a goal.** A project card holds the name, description and rules the
  agents work within.
- **Background agents.** Each agent is a Claude Code or Codex process in its own
  checkout under `~/minions/projects/<project>/<agent>-<id>`. It keeps working
  when your chat closes, until you pause or kill it or its job limit is reached.
- **Agents talk to each other.** Project messaging, native tasks and an updates
  feed let them coordinate and let you follow along without reading every message.
- **You stay in control.** Nothing starts without your yes. Needs you collects the
  questions agents ask you; Pause lets the current turn finish, Kill stops it.
- **Steer from your own chat.** Claude Code and Codex connect over MCP, so you can
  create projects, add agents and steer them in plain words. The web app shows the
  same projects.

See [VISION.md](VISION.md) for the product principles.

## Start here

You need Node.js 24 or newer, Git, and Claude Code or Codex signed in on this computer.

```sh
git clone https://github.com/latent-spaces/minions.git minions
cd minions
npm run setup     # install, build, start the engine in the background, register Minions
```

Setup also links a `minions` command for everyday use:

```sh
minions status    # is the engine running, and the shared service?
minions stop      # let turns in progress finish, then stop the service and the engine
minions start     # start them again (add --open to open the local app)
minions open      # open the local app
minions logs -f   # follow the engine log (--service for the shared service's)
minions update    # pull main, let turns finish, rebuild and start again
```

`npm run setup` starts the engine at `http://127.0.0.1:8787/`, always the same
address, and opens it in your browser, with no sign-in: the app is yours on this
computer. When another program holds port 8787, setup stops and names it. The engine
keeps running in the background after the command, the terminal or your coding chat
ends. Setup registers one `minions` connection with Claude Code and Codex by itself; it starts no model. Details are in [Run the standalone engine locally](docs/self-hosted-engine.md).

Then, in Claude Code or Codex, ask for what you want, for example:

```text
Create a private Minions project for this repository and add three agents.
```

A chat that was already open during setup gets the Minions tools after you
restart it; until then it can use the connector's `tool` command that setup prints.

## Runtimes

| Runtime | How it runs |
| --- | --- |
| [Claude Code](https://code.claude.com) | Default provider for background agents; also your steering chat over MCP |
| [Codex](https://github.com/openai/codex) | Background agents and steering chat over MCP |

Agents use the models your own Claude Code or Codex sign-in gives you. You can pick
a model per agent; otherwise the provider's default is used.

## Architecture

```
   Browser (web app)            Claude Code · Codex chat (you steering)
          │                                  │
          │ HTTP, loopback only              │ MCP over loopback HTTP
          ▼                                  ▼
  ┌──────────────────────────┐     ┌─────────────────────────────┐
  │     Local engine         │◀────│   Shared local service      │
  │  API + delivery worker   │     │   (connector, one per       │
  │  127.0.0.1:8787          │     │    computer)                │
  └────────────┬─────────────┘     └──────────────┬──────────────┘
               │                                  │ spawns and supervises
               ▼                                  ▼
       ┌───────────────┐            ┌────────────────────────────────┐
       │ engine.sqlite │            │  Claude Code · Codex workers   │
       │   + media/    │            │  one checkout per agent under  │
       └───────────────┘            │  ~/minions/projects/           │
                                    └────────────────────────────────┘
```

Everything runs on one computer and listens on loopback only. The engine owns the
project record: projects, agents, messages, tasks and updates. The shared local
service holds this computer's connection, exposes Minions's tools to your coding
client, and runs the background workers, ending their whole process tree on Pause,
Kill or stop.

| Layer | Stack |
| --- | --- |
| Web app | React 19, Vite (`apps/web`) |
| Engine | Node.js, Express 5, MCP SDK (`apps/server`) |
| Database | SQLite through `node:sqlite`, one file, no native dependency |
| Shared local service | Node.js MCP service over loopback HTTP (`packages/agent-cli`) |
| Workers | Claude Code or Codex processes; POSIX process groups on macOS and Linux, Job Objects on Windows |
| Contracts | Shared API shapes (`packages/contracts`) |

More: [MCP and backend](docs/architecture/mcp-and-backend.md),
[agent coordination API](docs/architecture/agent-coordination-api.md),
[document schema](docs/architecture/firestore-schema.md) and
[the shared local service](packages/agent-cli/README.md).

---

## Development

Use Node.js 24 or newer and install once from the repository root:

```sh
npm ci
npm run setup
```

Stop the engine before reinstalling dependencies: `npm ci` replaces workspace
dependency folders.

| Command | What it does |
| --- | --- |
| `npm run setup` | Build, start the engine and register Minions with your coding agents |
| `npm run build:web` / `npm run build:backend` | Build the web app / the engine |
| `npm run typecheck:backend` | Typecheck the engine |
| `npm run test:all` | The fast core: typechecks plus engine, connector and setup smoke tests |
| `npm run test:backend` / `npm run test:connector` / `npm run test:setup` | One part of the core |
| `npm run test:self-hosted` | Build the standalone engine and exercise it with fresh data |

Test runners and focused commands are described in [tests](tests/README.md).
Settings are named `MINIONS_*`; use `MINIONS_ENGINE_HOME` and `MINIONS_ENGINE_PORT`
for an isolated engine.

### Repository map

```text
VISION.md                     product direction, tenets and change process
apps/web/                     web app; shared presentation in src/ui/
apps/server/                  engine: API, delivery worker, domain modules, tests
packages/agent-cli/           shared local service, worker engine and bundled skill
packages/contracts/           shared API shapes and lifecycle observations
tools/setup/                  one-command engine setup
tools/benchmarks/             synthetic capacity and storage studies
tests/                        cross-component acceptance
docs/                         architecture, decisions, design and workflow
```

### Docs

- [Documentation index](docs/README.md): where every document lives.
- [Decisions](docs/decisions.md): owner decisions with their dates.
- [Glossary](docs/glossary.md): people, projects, agents, work and communication.
- [Shared development workflow](docs/project-management/README.md).
- [Release history](docs/release/deployment.md): updating a computer, and earlier releases.

Product behavior follows [VISION.md](VISION.md) and [the decisions](docs/decisions.md).
Mockups and existing code do not select an open product choice; discuss a mismatch
before changing dependent behavior.

## TODO

What we want to do next. Add to it, reorder it, cross things off as they land.

- [x] **Choose agent models on purpose.** Today a new agent runs on the client's default
      model. Instead the skill should pick a model that fits the agent's mission (a
      smaller model for routine work), warn when the default is a large model such as
      Fable or Opus, and say why it picked what it picked.
- [x] **The start prompt names the minions skill** (owner, 16 November 2026). The example prompt
      on My projects starts with "Use the minions skill" and asks for a Minions project.
- [x] **Hard cut to the Minions folders** (owner, 16 November 2026). Minions uses only
      `~/.minions` and `~/minions`; an install in the old `~/.mlswarm` folders is left as it was.
- [ ] **Develop Minions in Minions.** A project on this repository whose
      agents work in their own clones, preview on an isolated engine with live reload,
      and open PRs; the owner merges and updates their own engine.
- [x] **Update a connector without stopping agents.** `service-stop --after-turns` lets
      each turn finish, and agents continue in the same missions after the update.
- [x] **Move the project tabs into the sidebar.**
- [x] **Rethink Tasks beside the communication map.** The map moved into the Updates
      panel, and the board's four columns share the width beside it.
- [x] **Bring back project cover images.** A project's stamp, in the menu and the project
      header, shows the screenshot on its newest update; the banner keeps its gradient.
- [x] **Tell open tabs to reload after an update.** A tab checks `version.json` when it
      regains focus and every five minutes, and offers Reload when a newer build is served.
- [x] **Exact subtask counts in the list.** The server counts every accepted direct
      subtask for the list and task-page rings, independent of filters and loaded pages.
- [x] **Clean up stale run indicators.** Old background observations show Offline
      after 90 seconds; a newer session of the same mission still supplies activity.
- [x] **A three-field project card** (owner, 14 November 2026). The card is Name,
      Description and Rules, edited together in Settings; the other card fields and the
      separate shared instructions are gone.
- [x] **Tasks list newest first** (owner, 14 November 2026). The list shows the most
      recently updated tasks first.
- [x] **Communication above Preview in the sidebar** (owner, 14 November 2026).
- [x] **Readable turn prompts for agents** (owner, 14 November 2026). The prompt the
      controller gives an agent each turn is Markdown with quoted steering, so people can
      review what an agent was told.
- [x] **One Minions connection per computer** (owner, 14 November 2026). Setup leaves
      one `minions` MCP entry in Claude Code and Codex, removes the older per-engine ones,
      and always uses `http://127.0.0.1:8787/`.
- [x] **Ask the owner when all agents finish early** (owner, 14 November 2026). When every
      agent is finished while time is left, the owner gets one Needs you message asking for
      next instructions.
- [x] **Bring the Project card back to Settings** (owner, 14 November 2026). The project's
      name and description, editable by the owner, read-only for members.
- [x] **Tell the agents about a new task** (owner, 14 November 2026). A task a person
      creates reaches the agents as a message from that person.
- [x] **Project card reads as text until Edit** (owner, 15 November 2026). Settings shows the
      card as text with a ? note; the owner's Edit opens the form.
- [x] **Plans and research in Preview** (owner, 15 November 2026). Agents put a plan, research
      report or design in Preview as an HTML page, not only a running app.
- [x] **A New dot beside Preview** (owner, 15 November 2026). The menu marks Preview when its
      page changed since you last opened it.
- [ ] **Recommended option first in Needs you** (owner, 14 November 2026). A Needs you
      question with choices lists the best option first, marked "(recommended)".
- [ ] **Give the experiment waves a home.** The `experiment-waves/` runbook and tools are
      not in any repository yet.

## Why "Minions"?

Because it is small on purpose. One person, a handful of agents, one computer, one
file of state. Big enough to get a job done faster, small enough to understand
everything it does.

## License

This repository has no license file yet. It is private, and the connector package
is not published to npm.
