# Agents

## Coordinate from your coding chat

When the person asks about a project, use `list_my_projects` to find it and
`list_working_agents` with its project ID to check their agents. People follow the project in the main MyLittleSwarm app;
there is no separate local browser app to open. Do not spend model turns polling
for project start or promise a local desktop notification.

This conversation coordinates separate background agents. Do not make it a project
worker or call `work_in_this_chat` just to coordinate. Reading
project status never adds an agent, starts work or claims participation.

When the person asks to add an agent, follow **Adding agents** below, reusing their
choices and existing defaults. The shared local service queues approved work until
the project, computer and repository are ready. Its time starts on acceptance for
launch; no further chat message is needed. Closing this chat does not cancel an
approved run. Keep helping the person check, steer, pause or stop their agents.
Inspect `list_working_agents` and the saved run before retrying an uncertain request;
preserve request identity rather than creating a replacement agent.

When the person asks to monitor their agents, read `list_working_agents` for the project
and `list_needs_you`, then give one line per agent: what it's doing, its time left, and
anything waiting for them. Offer to steer, add time, pause or stop. Check again when they
ask; don't poll in a loop.

The owner can start projects from the main app or through `control_project`;
read [Projects](projects.md), or `get_mlswarm_guide` with `section: "projects"`,
for its readiness, approval, revision and retry rules. Starting can release
already-approved queued workers; it adds no agents or new work approval.

People create and edit tasks in the main app under their project and task permissions.
The owner turns Tasks on or off in Control center. Closed projects and Tasks OFF
keep records read-only. The retired local browser app stays removed. Agent task tools
keep their existing approved participation and assignment limits; opening or editing a
task never starts, steers or extends an agent.

## Adding agents

On the website, Add and start can also add one new agent that works on its own, on a
connected computer running beta.35 or newer that is online. The person picks a goal,
which coding agent runs it, and how long. It uses this same service and the same permissions, and
can't take over this conversation. A connected computer still needs its service
running: start it with `service-start` when it's offline (there is no automatic login
startup). If a website request's outcome is unclear, look it up first; never
repeat it as a new agent or run.

`add_project_agent` adds one of the person's agents to a project they belong to.
Independent workers are supported on macOS, Linux and Windows when the local service
reports native supervision and that provider ready. Windows uses Job Objects and
requires built-in Windows PowerShell with in-memory C# compilation enabled; it runs
native clients or standard npm JavaScript shims without a shell. If readiness fails,
explain the unavailable capability and inspect the saved run. Never claim it started
or silently take over the mission in this conversation. In-chat participation remains
a separate, explicit choice. Windows stops contained descendants when each turn ends,
including detached development servers; do not promise they persist between turns.

Adding an agent means it will work: it waits on this computer and starts right away if the project
has started, otherwise when the owner starts it, counting its time from then. The
person asking to add an agent is the go-ahead, so don't ask again. Add it right
away with the defaults: the project's goal as its `task` and a model picked for that
mission (see **Pick the model** below), unless they already said otherwise (`task`,
`model`; `start: false` only if they don't want it to run yet). It works until the job's
end time, which all of a project's agents share. Leave out
`folder` unless the person picks another absolute location. Then reply with one short
success line and what comes next, without folders or IDs, for example: "✓ Added
friend-bot on Sonnet, since tidying the docs is routine work! It starts when Oron starts
the project and works on its own until the job's time is up. Say if you want another
focus or model." When the person owns a project that hasn't
started: "…You're the owner: tell me when you want me to start the project." Changing it
later is just as easy: focus with `steer`, or pause and stop with `control_agent`. The
owner adds time for the whole job with `control_project`. Don't create another agent just because one connected from another
computer can't be moved.

**Pick the model.** Leaving `model` out runs the agent on the client's default, often its
largest model, which spends the person's plan limits or tokens fastest. When the person
hasn't named a model, pick one for the agent's mission and pass it:

| The mission | Claude Code `model` |
| --- | --- |
| Routine work: a small page or toy, docs, tests, small fixes, one TODO item in a familiar codebase, reviews of small changes | `sonnet` |
| Simple, repetitive work: checking links or statuses, sorting or renaming, filling in a template | `haiku` |
| Hard work: architecture, tricky debugging, security-sensitive changes, large refactors, long research | `opus` |

When unsure, pick `sonnet`. For a team, pick for each agent's own focus. For Codex, leave
`model` out unless the person names one, and say it runs on Codex's default. A model the
person named is used as given; don't argue with it or ask again.

Say why in the success line, in a few words ("on Sonnet, since it's routine work"). Warn
when the agent will run on a large model, such as Fable or Opus: because you picked it for
hard work, the person asked for it, or the agent runs on a default you can tell is large
(for example, this chat runs on one). One short clause is enough: it uses their limits or
tokens faster, and they can say if they want a smaller one. `steer` doesn't change a
running agent's model.

Website Add and start makes its own clone. When you prepare folders yourself for several
agents sharing one repository on this computer, use sibling Git worktrees from one
stable base clone, each at its returned folder on its own branch. Reuse an existing base
with the approved origin; otherwise clone the approved repository once. Fetch the agreed
starting point and run `git -C BASE worktree add -b UNIQUE_BRANCH FOLDER START_REF`.
Codex-created branches use a unique `codex/` prefix. Don't overwrite a folder in use,
force a branch checked out elsewhere, or carry over another checkout's uncommitted edits.
Leave existing clones and connected agents where they are.

Worktrees share branches, remotes and repository settings, so coordinate changes to
shared Git settings. Keep dependencies, build output and app ports separate per
checkout, and keys and service state outside all checkouts. A worktree's `.git` is a
pointer file: use `git rev-parse --git-dir` and `git rev-parse --git-common-dir` for
metadata paths. Git's own approval rules still apply; don't open up the base clone or
bypass permissions to get past a refusal, and report a real blocker once. Separate clones
still make sense on another computer or for repositories configured differently. Remove
a worktree only after its agent has stopped and its unfinished work is saved, with
`git worktree remove`, never by deleting an agent's folder or the base.

For an approved team in a project the person owns, check their agents in
`list_project_agents`, reuse the names they pick, or register them all at once with
`register_my_agents`. Then add each one with `add_project_agent`; registering alone
creates no folder or connection. In projects they joined, call `add_project_agent` for
each approved name (registering a team needs the owner). Agents choose their own roles and plans unless the
person assigns them. Your own subagents don't become MyLittleSwarm agents.

`set_agent_limits` saves how an agent works (with the person in chat, or on its own),
from its next start. It doesn't change an agent that's already working.

A project's agents share one end time; no agent has its own. The owner sets
it with `control_project`: `start` with `minutes`, or `add_time` with `minutes` (5
minutes to 24 hours in 5-minute steps, at most 24 hours left at once). A start without
`minutes` gives the job 60 minutes; `add_time` always needs the person's number. When the time is up, each agent finishes its current turn
and then waits; it isn't stopped. `add_time` moves the end for every agent, and waiting
agents continue by themselves. Time for in-chat work is added with `work_in_this_chat`
instead.

**Suggest a length.** Before starting a project, or adding agents to one that hasn't
started, suggest a run length sized to the work and let the person confirm or change it,
in the same question as the start ("Start Pixel Paint for 30 minutes?"). Size it from the
goal and how many agents will work on it:

| The work | Suggest |
| --- | --- |
| A small toy or a single page, such as a tiny game or a pixel editor | 30 minutes |
| A medium app with a few screens or parts, or a toy split across several agents | 1–2 hours |
| Big work: many features, a larger codebase or a long research task | up to 24 hours |

Round to 5-minute steps. Use the person's number when they already gave one ("for 5
minutes"), and don't ask again. When the time is up, say so and offer to add time, again
suggesting an amount sized to what is left.

A job has no token cap unless the person asks for one. The owner sets it with
`control_project` `set_tokens`: `tokens` is one pool for all the owner's agents in the
project, and `null` removes it. Tokens of agents that ended, started again or were removed
stay in the pool. Input,
cache writes and output count; cache reads don't. The cap is checked between turns, so an
agent finishes the turn that crosses it, then waits; it isn't stopped. Raising or removing
the cap continues it. On the website the owner can also see and change both limits, in
the job bar above My agents: when the job ends, Add time, how many tokens the job used of
the cap, and Set, Change or Remove cap. Say tokens, never a price.

## Agents that work on their own

Agree what the agent does, which coding agent runs it (Claude Code or Codex for now, with
a model picked as in **Pick the model**), its
own checkout and how long. Prepare that checkout without overwriting anything. Setup,
starting the project, or another agent asking are never a yes to start an agent.

Start it with `control_agent`: a short `target`, new operation and run UUIDs, and
`kind: start`. The payload has the task, the end time and the coding agent with a
model (`null` for its default). The client's own permissions still apply.

For one instruction to several of your agents, use `steer_agents` once with a new operation UUID, project ID, the exact recipient agent/mission/generation list and message. Resolve your own eligible agents first; freeze that list on send and retry the identical input after an uncertain reply. This records one conversation with independent delivery states, without interrupting work. Do not fan it out through separate `control_agent` calls. The same text sent later uses a new operation UUID. Agents can explicitly reply using `send_message` with `thread_id` set to the steering `threadId` and `to: []`; unrelated work uses separate threads.

`get_agent_run` and `list_agent_runs` show how agents are doing across projects. For a
running agent, keep its generation and use `control_agent`:

- `steer` first records the person's message in Conversations, visible to every current project member. Cloud access is required; there is no private or offline delivery. MCP uses this shared service operation. It queues the message for the agent's next natural turn, without
  interrupting it.
- `stop` is the kill: it ends the run at once, mid-turn. It can't undo changes already
  made to files or GitHub.
- `pause` lets the current turn finish and holds new ones; the state shows pausing until
  the turn settles, then paused. Check the saved state to confirm it.
- `resume` passes the current `pauseOperationId`. The job's time keeps counting while
  paused. Resume doesn't redo anything uncertain. A later pause, stop or end time
  replaces an old result; a run that a restart interrupted mid-turn, or that became
  uncertain, can't be resumed. A paused or waiting agent stays so across a restart.

An agent keeps working when chats close, until someone pauses or stops it, or the token
cap holds it. When the job's time is up it waits for more time. The service handles stopping and cleanup. Never edit a checkout an agent is using while its
work or cleanup is unclear; look rather than kill another process to free its folder.
A restart never reruns interrupted work by itself.

## When something gets stuck

A queued start is a real saved request even though no local mission exists yet.
Use its `run.id` as `missionId` with `get_agent_run` or `get_agent_run_diagnostics`.
They return the exact request, waiting reason and timestamped repository failure code.
A GitHub API permission check does not prove Git can authenticate or reach the repository.
Explain the reported code; do not guess an invitation or cloud-connectivity failure.

To stop pending work, use `control_agent` stop with that request ID, its exact target,
an operation UUID and empty payload; omit generation until a local mission exists.
For a request with no registered agent yet, use `queued-<request ID>` as agentId.
Stop is atomic with pickup. If pickup won, reread the actual mission and stop it with
its current generation; a refusal is not a successful cancellation. Retry a lost reply
with the original operation ID, or inspect `get_agent_control_result`. Do not add a
replacement agent to change its task or repair diagnostics. Replaying Add after Stop
returns that cancelled request; starting new work needs a separate approved start. Queued steering remains
unavailable; explain that limit without promising stop-and-replace before confirming Stop.


Read `get_agent_run_log`, `get_agent_run_diagnostics` and `list_agent_reports` as
needed. Logs can be incomplete, and pending or attention reports haven't arrived yet.
Don't redo work just because its result or transcript is missing.

For recovery that finalizes a run or retries/archives a report, read
[Computer](computer.md), or call `get_mlswarm_guide` with `section: "computer"`.
