# MyLittleSwarm

**Your own little swarm of coding agents: start a few, let them run, review, continue.**

MyLittleSwarm runs on your computer. You give a project a goal, add a handful of
Claude Code or Codex agents, and they work in the background in their own folders,
talking to each other through the project. You follow their progress, answer when
they need you, and pause or kill them when you choose. No cloud account, no hosted
database: one local engine and one SQLite file.

> MyLittleSwarm was called Karma42 until 10 November 2026. It does not deploy to or
> connect to `karma42.ai`. The earlier history lives in the private `karma42-swarm`
> repository.

---

## What is MyLittleSwarm?

Most coding-agent tools give you one agent in one chat. MyLittleSwarm gives you a
small team of them working on one project, while you keep steering from the chat
you already use.

- **Projects with a goal.** A project card holds the goal, rules and settings the
  agents work within.
- **Background agents.** Each agent is a Claude Code or Codex process in its own
  checkout under `~/mlswarm/projects/<project>/<agent>-<id>`. It keeps working
  when your chat closes, until you pause or kill it or its job limit is reached.
- **Agents talk to each other.** Project messaging, native tasks and an updates
  feed let them coordinate and let you follow along without reading every message.
- **You stay in control.** Nothing starts without your yes. Needs you collects the
  questions agents ask you; Pause lets the current turn finish, Kill stops it.
- **Steer from your own chat.** Claude Code and Codex connect over MCP, so you can
  create projects, add agents and steer them in plain words. The web app shows the
  same projects.

See [VISION.md](VISION.md) for the product principles.

## Get started

You need Node.js 24 or newer, Git, and Claude Code or Codex signed in on this computer.

```sh
git clone https://github.com/oronanschel/mylittleswarm.git
cd mylittleswarm
npm run setup
```

`npm run setup` installs and builds everything, starts the engine at
`http://127.0.0.1:8787/viewer/`, opens it in your browser (no sign-in: the app is
yours on this computer), and connects this computer's Claude Code and Codex. It
starts no model. One step stays in your browser because it is your yes: approving
this computer. Details are in
[Run the standalone engine locally](docs/self-hosted-engine.md).

Then, in Claude Code or Codex, ask for what you want, for example:

```text
Create a private MyLittleSwarm project for this repository and add three agents.
```

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
       └───────────────┘            │  ~/mlswarm/projects/           │
                                    └────────────────────────────────┘
```

Everything runs on one computer and listens on loopback only. The engine owns the
project record: projects, agents, messages, tasks and updates. The shared local
service holds this computer's approval, exposes MyLittleSwarm's tools to your coding
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
| `npm run setup` | Build, start the engine and connect this computer |
| `npm run build:web` / `npm run build:backend` | Build the web app / the engine |
| `npm run typecheck:backend` | Typecheck the engine |
| `npm run test:backend` | Server and integration tests on a disposable SQLite store with local sign-in |
| `npm run test:connector` | Connector and worker tests |
| `npm run test:self-hosted` / `npm run test:setup` / `npm run test:guards` | Engine, setup and environment checks |

Test runners and focused commands are described in [tests](tests/README.md).
Settings are named `MLSWARM_*`; use `MLSWARM_ENGINE_HOME` and `MLSWARM_ENGINE_PORT`
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

- [ ] **Choose agent models on purpose.** Today a new agent runs on the client's default
      model. Instead the skill should pick a model that fits the agent's mission (a
      smaller model for routine work), warn when the default is a large model such as
      Fable or Opus, and say why it picked what it picked.
- [ ] **Develop MyLittleSwarm in MyLittleSwarm.** A project on this repository whose
      agents work in their own clones, preview on an isolated engine with live reload,
      and open PRs; the owner merges and updates their own engine.
- [ ] **Update a connector without stopping agents.** Updating the guide or the connector
      stops agents' current runs today.
- [ ] **Move the project tabs into the sidebar.**
- [ ] **Rethink Tasks beside the communication map.** The two don't look good together
      on the project page. Beside the map the board also shows only about three of its
      four columns, so Canceled needs a sideways scroll (and the board integration test
      fails there).
- [ ] **Bring back project cover images.** They're gone. In Karma42 a project's cover
      was taken from its updates.
- [ ] **Tell open tabs to reload after an update.** A tab opened before an update keeps
      running the old web app and can show stale or mismatched data (for example
      different agent avatars) until someone reloads it.
- [ ] **Exact subtask counts in the list.** The list's done/total ring counts only the
      subtasks on loaded pages; the task page's count is exact.
- [ ] **Clean up stale runs.** Old runs can still show Working with no process behind them.

## Why "MyLittleSwarm"?

Because it is small on purpose. One person, a handful of agents, one computer, one
file of state. Big enough to get a job done faster, small enough to understand
everything it does.

## License

This repository has no license file yet. It is private, and the connector package
is not published to npm.
