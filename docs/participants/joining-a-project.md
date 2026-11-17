# Working on a project

Start with the [quick start](../../README.md#quick-start). Your coding chat helps
you choose a project, agent missions, providers and time limits. Approve the plan
before starting agents. Each agent works in a separate checkout using your own
Claude Code or Codex account.

Follow progress in the local app or steering chat. Agents coordinate through
messages and native tasks. Use Needs you to answer questions, and Pause or Kill to
control execution. Repository access is checked separately from project settings.
See the [connector guide](../../packages/agent-cli/README.md) for the exact tool contracts.

## Prepare a new agent's checkout


When your coding agent prepares folders for several agents that share one
repository on this computer, it uses Git worktrees. Keep one stable base clone for that
repository and put each worktree in the exact agent folder returned when the agent is
added. Each agent gets its own unique branch and working files. Leave existing clones,
connected agents and active work where they are. Another computer or a repository
needing independent Git configuration uses its own clone.

Your computer clones only into an empty folder, so create the worktree before the
agent's run is picked up: add the agent with `start: false`, create the worktree in the
returned folder, then add the same agent again to queue its run. Verify the base's
origin is the approved repository's `https://github.com/` address, then fetch the agreed
starting ref. If no suitable base exists, clone the approved repository once at a stable
location outside agent worktrees. Do not use a temporary agent folder as the base. After
selecting real values for these shell variables, the creation command is:

```sh
git -C "$BASE" worktree add -b "$UNIQUE_BRANCH" "$AGENT_FOLDER" "$START_REF"
```

Use a unique `codex/` branch for Codex-created branches. Preserve an occupied folder
and inspect it rather than using force or resetting it. Committed source comes
from the selected ref; another checkout's uncommitted edits are not copied.

Worktrees share Git objects, branch names, remotes and ordinary repository settings.
Coordinate repository-wide configuration and maintenance. `.git` in a linked worktree is
a pointer file; use `git rev-parse --git-dir` and `--git-common-dir` rather than
assuming it is a directory. Install dependencies, build and run each checkout's app on
its own ports. If you work on Minions itself, give another checkout's engine its own
`MINIONS_ENGINE_HOME` and `MINIONS_ENGINE_PORT` (see [the engine
instructions](../self-hosted-engine.md)). Keys and service state stay outside all
checkouts.

Your coding agent's own approval rules still apply to Git. Don't open up the whole base
clone, turn on full access or rewrite client settings to get past a refusal; report a
real blocker once and continue other work. Remove a worktree only after its agent has
stopped and its unfinished work is saved, with `git worktree remove`; never delete an
agent's folder or the shared base to do it.
