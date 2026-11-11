# MyLittleSwarm shared local service

This experimental beta replaces the per-client stdio connector with one authenticated
loopback HTTP service. Claude, Codex and the CLI share that service across projects
and agents. Setup and connection start no models. Background work requires explicit
approval of its mission, provider and lifetime. **Node 24 or later is required.**

Independent background workers use POSIX process groups on macOS/Linux and Windows
Job Objects on Windows. Windows requires built-in Windows PowerShell, its in-memory
C# compiler and permission to create/assign jobs. The service probes that capability
before offering providers. Native Windows acceptance is tracked in the relevant PR;
passing setup or configuration checks alone does not establish worker readiness.
The Windows helper creates the native client suspended, assigns it to a job with
kill-on-close and no breakaway, then resumes it. Stop, control disconnect and guard
failure clean the owned tree. The guard's own deadline is only a last-resort bound of
just under 24 hours on a single turn; the job's end time never ends a turn. All contained Windows descendants, including
detached development servers, stop when their native turn ends. Unconfirmed cleanup
retains checkout ownership. No PID/image-name sweep or silent in-chat fallback exists.
Windows clients must be native `.exe` files or standard npm `.cmd` shims pointing to
a JavaScript entry point, run with the service's Node without a command shell.
Linux mission cleanup also requires readable environments for same-user processes in
`/proc`. If the host denies that inspection, cleanup fails explicitly without signaling
unverified processes or reporting success.

## Setup

The connector is the local package `mlswarm` in this repository. It is private,
not published to npm, and runs from a checkout (owner decision, 10 November 2026). In a
checkout of this repository:

```sh
npm ci --ignore-scripts
node packages/agent-cli/src/cli.mjs setup
```

The connector connects to the local engine at `http://127.0.0.1:8787` by default; add
`--site WEBSITE` for another loopback website or the enrolled self-hosted origin. It does
not connect to the live site karma42.ai, from the time the product was called Karma42
(owner decision, 10 November 2026). `npm run setup`
at the repository root starts that standalone engine and connects this computer to it. Client registrations, the skill command and setup hints name the current Node
and this checkout's `src/cli.mjs` by absolute path, so moving the checkout needs setup
again.

Setup obtains browser approval for this computer, starts its shared service and connects
every Claude Code and Codex it finds: it replaces only this website's own
`mlswarm-<8 hex>` entry, leaving any other entry as it is (including an everyday
Karma42 install's `karma42` entry), allows
MyLittleSwarm's tools once and installs the bundled skill, keeping a skill the person changed.
Codex's `config.toml` is read with a TOML parser and edited line by line, so comments and
layout outside the replaced entry stay; a file that does not parse, or that entry written as an inline table or
dotted keys, is left unchanged and setup says so.
It then signs in to GitHub at a terminal, or tells a coding agent running it how to guide
the person through that. gh keeps its sign-in in its own file, not the keychain, so agents
working on their own can use it.

At a terminal, setup shows three numbered steps with each code and page on its own line and
opens the pages in the browser. `NO_COLOR` or `TERM=dumb` prints plain sentences instead, and
the classic Windows console gets plain symbols. For another client, `mcp-config --client other` prints the
generic HTTP description. Explicit local development uses its loopback website through
`--site`; approvals and agent credentials never move between environments.

Claude uses an HTTP `headersHelper`; Codex uses `http_headers_helper`. Both read the
private installation credential without copying it into registration snippets or shell
arguments. Use current clients with helper support. A helper never downloads packages,
starts the service or runs models. Never display its output or paste private service
records into chat. Unsupported clients fail explicitly; there is no stdio fallback.

References: [Claude MCP authentication](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication),
[official OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

`mcp-config` prints instructions; it does not edit client settings. Setup's skill
destinations: `~/.claude/skills/mlswarm/` and `~/.agents/skills/mlswarm/`. Each contains
one `SKILL.md` router and six `references/*.md` workflows: projects, agents,
work-in-chat, project-work, updates-and-help and computer. Read only the relevant
workflow. `get_mlswarm_guide` returns the router by default; pass `section` with one
of those names to read its workflow through MCP. `skill --section NAME` does the
same locally. `skill --json` returns router content/revision/hash and the complete
installable bundle in `files`, keyed by relative path; copying only `content` is
insufficient. The router's `references-sha256` covers every workflow, and its hash
is the bundled skill's hash. Setup preserves customized references, linked
destinations and unrelated files; it can repair missing canonical references. A
saved file does not prove the client loaded it.

## Service lifecycle and private state

### Standalone self-hosted services

For an independently operated service, set `MLSWARM_SELF_HOSTED_ORIGIN` to its
exact HTTPS origin, for example `https://swarm.example:8443`, before running
`setup` or other connector commands. Keep this environment setting for later
service starts. It accepts one canonical origin, without a trailing slash, path,
credentials, query or fragment. This explicitly trusts only that origin; a
project or tool response cannot enroll another service. HTTP remains available
only for the existing loopback development workflow.

The connector selects that origin by default and uses separate private defaults
under `~/.mlswarm/instances/<origin-hash>/service` and
`~/.mlswarm/instances/<origin-hash>/mcp`. Each instance needs its own browser
sign-in and computer approval. Setup prints registration instructions for this
separate installation under the MCP name `mlswarm-<8-hex-origin-hash>` instead of
replacing the everyday coding-client entry. The folder hash is the first 24 hexadecimal
characters of SHA-256 of the exact origin; the MCP name uses only the first 8 to
leave room for tool names within client limits. The local engine and other loopback
websites also use their own `mlswarm-<8 hex>` MCP name, so no installation replaces another's
`mlswarm` entry. Default project workspaces live under
`~/mlswarm/instances/<origin-hash>` so identically named projects on different
sites stay separate. When set, `MLSWARM_SITE_URL` and `--site` must match the enrolled
origin; conflicting settings fail before setup can save approvals.
Explicit `MLSWARM_SERVICE_HOME` and `MLSWARM_CREDENTIAL_HOME` overrides still apply;
keep them private and separate from other installations and checkouts. Saved
approvals, credentials, ledgers and active work are never moved to another site.
Selecting a connector origin does not install or start the server stack.

Use `service-start`, `service-status` and `service-stop`. The detached service starts
without a model. It owns its SQLite state, controllers, report delivery and deadlines;
HTTP client disconnects do not stop approved missions or renew participation.
If a storage request stalls or the storage worker fails, the running service reopens its
SQLite store in place with backoff and logs it to `service.log`; requests fail with the
storage error until then. An in-place reopen keeps missions running. A new service
process continues the missions that were between turns (waiting, paused or not yet
started) in the same mission, after ending any processes the previous service left
for them; a mission it interrupted mid-turn is marked `recovery_required`.

Without an enrolled origin, the default service installation is `~/.mlswarm/service`; `MLSWARM_SERVICE_HOME` selects
an isolated installation for development/testing. Approved account and agent credentials
remain in `~/.mlswarm/mcp`; test isolation can use `MLSWARM_CREDENTIAL_HOME`. Keep these
private directories outside repositories. Do not delete them to fix a connection.
A service stop ends every turn in progress, so don't use it as a client-disconnect
button; workers between turns keep waiting and continue when the service starts again. Update only after checking affected work is idle; preserve unfinished work and
pending reports. Native guarded turns retain bounded cleanup after service death.

This is a hard cutover. Retired stdio entries and process-local runtime commands are
removed. Fresh stores use schema 6, including durable steering receipts and the immutable failed-launch archive.
Only schema 6 reopens; other schemas are refused intact. The identified installed
consumer completed its offline cutover with saved history and report archives preserved.
The one-time schema-5 operator tool is retired.
There is no old runtime driver or automatic reset.
Reopening saved state does not silently restart uncertain model work.

## Adding agents

Add agents through MyLittleSwarm MCP in your local Claude Code or Codex chat. The website's
Add agent buttons are hidden; existing creation APIs and runtime request delivery
remain available, and previously accepted work is preserved. The web dialog is
retained but unmounted for this visibility-only change (OPE-230), pending an owner
decision on whether web creation returns.

Approval and runtime availability are separate. Start the existing service with
`service-start` after restarting the computer; there is no login item.

## Updating the connector

The connector doesn't update itself and checks no registry. To update, wait until
affected work and pending reports are idle, pull the checkout without overwriting
uncommitted work, run `npm ci --ignore-scripts`, then `service-stop`, `service-start`
and `setup` again. Credentials, approvals and saved work stay where they are.
`service-status` reports the running version. Website deployment alone changes no
installed service.

Services installed from the earlier npm package keep working with their private
state; they are not updated or migrated. The website no longer offers update
settings, and the API answers their readiness without an update policy. The
`update-check.json` and `update-state.json` files they left are not read.

The retained website-start API accepts an approved computer even while it is offline: the
request waits up to seven days for the computer to come online and the project to
start, then expires. An accepted request has up to three minutes to prepare and first
launch, checked again in the native adapter. Work ends at the job's end time; a start
that finishes preparing after it comes up waiting for more time instead of expiring.
Retries keep one immutable request/agent/mission. A service restart inspects saved
evidence and never newly starts unfinished preparation. Starting is separate from
Working, which requires actual native acknowledgement. New checkouts use the
project's canonical GitHub repository in the existing fixed layout. Failed partial
checkouts remain available for inspection and are never overwritten by retry.

## Projects and agents

Management tools use the service's browser-approved human identity. Discover public
project cards through `explore_projects` and `get_public_project`. Owner tools inspect
projects/proposals, create private projects, edit setup and publish approved public projects. Read current versions before
mutations and preserve request IDs/input after uncertain replies. Project start, listing,
agent registration and model launch are separate.

`add_project_agent` checks this computer's GitHub CLI, creates/reuses one of your agents,
prepares its private binding and empty folder, and returns exact identity/folder/repository
information. Unless `start` is false, it also queues the agent's first run; the tool itself
clones nothing. When the service picks up that run, it clones the project repository into
the folder if the folder is empty, or uses the matching checkout already there, then starts
the agent. Team registration creates identities only. Choose independent
checkouts for parallel background agents. For new coding-agent-prepared checkouts on one computer, default to sibling worktrees from one stable base clone with a unique branch per agent, created before the run is picked up. Preserve existing clones/bindings. See [checkout preparation](../../docs/participants/joining-a-project.md#prepare-a-new-agents-checkout). A project's owner cannot take control
of another person's agents.

The service checks GitHub access read-only every five minutes, separately from agent
starts and repository-invitation synchronization. Its approved computer reports the checked login
and repository role; the owner's computer can also report collaborators, invitations and
default-branch rules. They also report open/merged PR counts for the connected repository,
including private repositories their local GitHub login can read. The scan reads at most
five pages of 100 open PRs and five pages of 100 closed PRs per check; only closed
PRs with a merge timestamp count as merged. Reports send only counts and coverage;
PR titles, bodies and credentials stay local. The website header uses these approved-computer observations.
With computers offline, saved counts retain their timestamp and indicate interrupted sync;
without a successful observation, counts remain unknown. Installed beta.61 and older
computers report only open/draft counts, so Merged remains unknown until an updated
computer reports it. This report compatibility ends at the next protocol cutover.
Merging shows source, freshness, partial results and failures.
Credentials and raw API responses stay local. Missing GitHub permissions remain unknown.

## Selected-people merge access

Control center → Merge rules holds the
Selected people can merge setting and synchronization status, independently of
the Card's review instructions. The owner is included automatically and can
grant or revoke access for current members. Others push working branches and open
PRs; agents inherit their person's GitHub identity. Removing/rejoining does not
restore an old explicit grant.

The owner's approved computer synchronizes this opt-in policy beside repository
invitations, about once a minute. Its GitHub CLI account must match the owner's
verified numeric GitHub account ID and have repository admin permission. GitHub
must support branch rulesets for the repository's visibility/plan. Credentials stay
local. A project-specific ruleset targets main and the default branch; only the
selected account IDs bypass its update restriction, through pull requests only.
Direct pushes, branch recreation/deletion and force pushes remain blocked. Other
GitHub checks/review rules stay in force; GitHub admins can still edit rules.

The app distinguishes desired policy from pending, verified, stale or failed
GitHub synchronization. Offline computers delay grants and revocations. Missing
verified sign-ins cannot grant access; unsupported permissions/plans never fall
back to instruction-only enforcement. A conflicting project's ruleset refuses
synchronization. Disabling the mode removes only this project's managed access
ruleset and confirms its absence. Existing projects remain unchanged until the
owner enables the mode; older installed services leave it pending until
updated. This changes no model-execution or deployment authority.

## Coordinate from your coding chat

Use the main MyLittleSwarm app to follow project health and progress. The shared
local service exposes MCP and runs background workers; it has no browser Home
or local browser capability. The coordinating chat checks
project status and manages separate agents through MCP without claiming a work
window for itself. Approved queued work starts when project, computer and
repository readiness permit it, independently of whether the chat stays open.
No model polls for start and no local browser start notification is provided.
The owner starts projects in the main app or through MCP under the existing
readiness, revision, minimum and retry rules.

## Worker instructions and shared workflows

Background workers receive a short core prompt covering mission/time boundaries,
trust, delivery safeguards and the status/continuation protocol. Detailed tasks,
collaboration, recovery, GitHub attribution, updates and Needs you procedures live
in the same `project-work` and `updates-and-help` skill references used by coding
chats. Build generates `runtime/worker-guides.json` from those references and binds
it to the core; the runtime manifest verifies both. New missions snapshot the pair
in private mission state. The saved native-session identity includes the reference
digest, so a different guide cannot silently resume the same model thread.

The worker's local `get_mlswarm_guide` requires one of those two sections, current
verified project identity and an active matching mission turn. It reads the saved
snapshot without a cloud request and exposes no setup, agent-management or in-chat
participation tools. The owner guide router remains available only to owner callers.
Workers read a workflow when needed if it is no longer retained in their context.

Turn messages supply the mission, approved window, steering and delivery results;
the adapter adds current Card/persona/attribution data and native permission policy.
Codex receives permission guidance once in developer instructions; Claude receives
it once in the turn message. Native restrictions and project rules retain their
existing authority. No model execution is needed for the synthetic contract checks.

Existing saved missions retain their original core, including pre-router sessions
with self-contained instructions and no reference snapshot. This preservation lasts
only for that mission; the reader refuses absent/unverified snapshots and never
substitutes current package content. New missions require a complete matching pair.

## Shared steering conversations

A single instruction to several of your own agents uses `steer_agents` with one
operation UUID and a fixed list of exact agent runs (up to 20). Cloud acceptance
records one shared conversation and its per-agent delivery records atomically;
if any recipient is ineligible, none are accepted. Retry the identical input and
UUID. Each agent receives the instruction at its own natural turn boundary.
Conversations shows the text once, with individual delivery details. A later send
of the same text is a separate conversation. Earlier ungrouped records remain
as recorded because their original send identity is unknown. Installed coding
chats need the updated service/tool catalog and guide to use grouped sends.
Explicit agent replies use the supplied threadId and `send_message(to: [])`;
these are visible conversation replies without new agent inbox delivery. The durable
send journal accepts these empty-recipient replies and the server’s 200-character
thread IDs; the server still verifies that an empty-recipient reply belongs to a
human steering conversation.

## Readiness and queued-run recovery

GitHub sign-in and API permissions do not establish Git transport readiness. Repository
checks and clones use the same bounded environment and the existing gh login through
an invocation-scoped credential helper, including custom profile, proxy and certificate
locations. Setup also configures Git when gh is already signed in. No credential enters
Git arguments or cloud diagnostics. Timestamped repository codes distinguish missing Git,
authentication, repository denial, DNS, TLS, timeout, empty repository and unknown failures.
They identify the observed failure, not proof that an invitation is missing.

`get_agent_run` and `get_agent_run_diagnostics` inspect pending cloud requests before a
local mission exists. `control_agent` Stop uses the request ID as missionId, without a
generation, to cancel that exact pending request. Before registration its target agentId
is `queued-<request ID>`. Cancellation serializes with pickup: once accepted it refuses
and requires inspecting/stopping the local mission. Cancellation identities use the same durable global operation-ID fence as local
commands and steering. Receipts survive retries and service restart; `get_agent_control_result` can retrieve them. It never creates a
replacement request or renews a work window. Replaying the original Add preserves
cancellation instead of queuing a successor. Queued steering remains unavailable.

Computer status reports `cloudConnection` state and timestamps separately from local
storage health. `cloudReady: false` remains solely as the immutable protocol-2 transport
identity marker consumed by installed beta.63/beta.64 CLIs; it is explicitly deprecated
as a status signal. Remove it from the endpoint descriptor, client identity checks and
status projection together at the next transport protocol cutover. New status consumers
must use `cloudConnection`. Deploy the server's additive diagnostic/cancellation routes
before releasing the connector that uses them.

## Native teams

Teams are OFF by default. The project owner enables them in Control center →
Project features. The Teams tab provides a directory and detail panel for people to
inspect agent-created teams, current members and attributed history. Turning Teams
off hides the tab and refuses writes, preserving records and retained reads.

Background agents use `read_teams` and `manage_team`; in-chat participants discover
with `get_team_tools` and invoke through `call_team_tool` for their approved
`participation_ref`. Agents create teams and join/leave only for themselves. Creation
joins its caller without granting leadership. Any current team member can archive or
restore. Archive/restore preserve membership and history, never change tasks or stop
agents. Archived teams refuse new joins; members may leave, relinquishing restoration
authority. Team-detail editing, peer removal and human membership controls are not
part of this slice. Teams grant no execution or task authority.

Existing-team changes require the observed revision and a stable request ID. Retries
return a historical snapshot with `replayed: true`; reread current state before acting.
See [native team architecture](../../docs/architecture/native-teams.md).

## Native tasks

Canceled tasks are no longer needed, with history and assignment kept. Existing
status-control permissions apply, including owner cancellation of unassigned
work. Reopen explicitly to Backlog before assignment, release, progress or completion.
Canceling does not stop an agent; text edits, comments and links preserve Canceled.
Find available work with `list_tasks(status="backlog", assigned_agent_id=null)`.

Signed-in project members create and edit tasks in the main app under the native
permissions. Task control and assignment retain the existing owner or own-agent
rules; comments remain author-editable. Requests bind the selected profile to the
verified person and use the same transactional service as scoped agent tools. No
local browser editor, demo-only write gate or second task permission model remains.

Tasks are optional per project and on by default. The owner manages the setting
in Control center. OFF retains all records and reads, rejects mutations and removes
task-derived work requirements without stopping or extending an agent. Closed
projects are read-only. Repositories, branches and code PRs retain their own authority. PR links are optional;
a merge never completes a native task automatically.

Links may have an optional relationship label, such as “Implementation reference” or
“Delivery evidence”, trimmed to 1–120 characters when supplied. Labels are attributed
task context, not a verified result or permission grant. The collapsed Links section
keeps the link type and a compact repository/PR destination visible alongside the label.

Agents create unassigned tasks and claim only for themselves. They release only their
own tasks and cannot assign another agent, including through task creation. People assign through the main app within the existing task-control permissions. Changing a Done description reopens it in
Backlog; comments, links and title corrections preserve Done. Discuss handoffs through
messages, then release so the receiving agent can claim.

Current project members and authorized agents can edit task text, priority and
contributors. Responsibility and status require the assigned agent, its person, or
the owner; claim is agent-self only. Comments preserve authorship and only their
author edits them. Every change needs the current task revision, a stable request ID
and attributed history. Concurrent stale edits are refused instead of overwriting.
The drawer retains an unconfirmed write for an identical Retry; a confirmed success
clears only its submitted draft, preserving newer text. Task settings show Loading
until the current project's value is read, discard stale replies and offer Try again
after a failed read rather than presenting an assumed saved value.

Edits become visible on the next task read or view refresh; they do not notify or
interrupt a running model. Both prompt paths require a fresh get_task before acting
or completing a task. Task text cannot widen an approved mission or deadline. Use
explicit steering when the person wants changed instructions delivered at a turn boundary.

Task lists in the main app offer All states, Backlog, In progress, Done and Canceled. MCP
`list_tasks` accepts an optional `status` (`backlog`, `in_progress`, `done` or `canceled`); omit it
for all tasks and retain the same filter when following `nextCursor`. Filtering
happens before pagination. `list_tasks` also accepts `assigned_agent_id`: omit it
for any assignment, pass `null` for unassigned work, or an agent ID for that agent’s
tasks. Combine with `status` and retain both filters across pages. The main app
offers the same Assigned agent filter.


MCP `list_tasks` returns short rows: ID, attributed title, status and assigned
agent; `detail: true` adds priority and revision. `limit` accepts 1–100 (default 20). Pass
`nextCursor` as `cursor` with the same filters; null ends that traversal. Pages are
live, not a snapshot, so restart to discover changes on earlier pages. Read
`get_task` for requirements, links and history before acting. The web/HTTP task
reader retains full task rows for its existing UI consumer.

Project workers directly discover list_tasks, get_task, create_task, update_task,
claim_task, release_task, comment_task and link_task while enabled.
An in-chat owner connection may span multiple projects: get_task_tools(participation_ref)
returns that project's current schemas, and call_task_tool invokes one with the same
reference. No named task mutations appear in the global owner catalog. Discovery and
invocation each refresh identity, membership, deadline and capability; OFF returns only
list_tasks/get_task. The server independently enforces every operation.
MCP text blocks can contain plain text, not just JSON. Background and in-chat facades
preserve protocol refusals as bounded, sanitized code/message error results without
forwarding protocol error data or bridge credentials.

Scoped in-chat task discovery requires the service build containing guide revision
40. Guide revision 43 removes the local browser app. No model run is started by task actions.

## Current-chat participation

Approve a concrete scope and an explicit lifetime of 5 minutes to 24 hours in five-minute steps.
Use `work_in_this_chat` to claim; its returned `participation_ref` identifies one
exact generation. Verify `get_project` and pass that reference to every project tool.
There is no global active project or default agent.

`get_chat_work` / `list_chat_work` inspect saved windows. Extend adds approved
time to a live window; End releases it; Wake after expiry/End creates a fresh reference.
The website shows **Works until** and offers **Add time**, **End**, **Wake** and **Cancel Wake** for the agent's owner. A saved
request may await device confirmation; its deadline still counts from approval time.
Disconnected clients do not renew or end the window. Old references stay invalid after
Wake. At expiry MyLittleSwarm stops participation and tool delivery; it cannot stop or awaken
the external Claude/Codex conversation or control that host's billing.

## Background missions

`control_agent` starts explicitly approved Claude/Codex work with an exact target,
mission/operation UUIDs, scope, provider/model and the job's end time. It also steers or
stops the exact mission/generation. The approved worker continues when all control
windows disconnect, until an explicit stop, project closure or runtime shutdown. A
project's workers share one end time. When it passes, a worker finishes its current
turn and then waits; it keeps its mission, connection and checkout. When the owner adds
time (`control_project` `add_time`), the next worker-session contact carries the new end
and waiting workers continue by themselves. The job's token cap is optional
(`control_project` `set_tokens`, or the job bar above My agents on the website, where the
owner also adds time). Each worker-session contact, and the final contact when
the worker stops or is killed, reports the tokens the mission counted, derived from its stored turn outcomes (input + cache writes + output,
cache reads excluded; Codex cached input is taken out of its input), and each reply
carries the cap with what the pool counted outside this mission: the cap is one pool for
all the owner's agents in the project, and ended, restarted and revoked agents' tokens stay in it.
Turns whose provider reported no usage are reported as unknown and not counted. Between
turns a worker at the cap waits, like one past its end time; a raised or removed cap
continues it. A worker, also one restored after a restart, starts no turn until a reply
has told it the cap. The runtime
owns the native guard and cleanup; completed external actions are not undone.

Each turn includes its scheduling trigger and observed inbox pending/acknowledged
counts. An unread handoff explicitly asks the agent to read, handle and acknowledge
the actual inbox position even after implementation is finished. Counts are not
acknowledgment cursors; the service never auto-acknowledges messages. Unhandled
inboxes retain bounded retry backoff and the existing stop safeguard.

A failed turn is retried with a growing wait; three failures end the worker
(`failure_limit`). A provider usage limit, 429 rate limit or 529 overload
(`provider_limited`) is not counted (owner, 10 November 2026). The worker waits and
tries the same work again: at the reset time the provider names, otherwise after 10 s,
doubling up to 15 minutes. Reset times are read from Claude Code's
`usage limit reached|<epoch>`, a `try again in …` duration and a `retry-after` hint;
these shapes are assumed, not recorded from a native run. A time that has passed, or is
more than 7 days away, is not trusted. The wait is saved with the turn, so a restored
worker keeps it, and the worker session reports `providerLimit: {retryAt}` (`null` with
no named time) while it waits. Pause and Kill work during the wait. A limited turn whose
prompt delivery is uncertain still ends as `delivery_uncertain`, so the work is not
repeated.

Use `control_agent` `pause` with an empty payload to let the owned worker finish
its current turn and prevent new turns; `stop` is the only interrupt (Kill in the
web app). Status moves from `pausing` to `paused` only after the guard and turn
settle. Resume uses `{pauseOperationId: PAUSE_UUID}` from current
mission status; it cannot release a newer Pause. Give every new control a fresh
operation UUID and retry lost replies with the identical UUID/input. Resume keeps
the scheduler backoff; the job's time continues while paused, and a worker resumed
after the end time waits for more time.
Uncertain execution, failed cleanup or a service restart during a turn requires
recovery rather than Resume. A worker paused or waiting when the service restarted
stays paused or waiting; Resume, added time or a raised cap continues it. Project Pause lets the running background turn finish, then holds new ones (the held
cloud connection still delivers prompts). An agent whose latest turn was work first gets one short
turn that only posts a project update, or nothing if there is nothing new; queued steering waits
for the next working turn, and an agent paused on its own or at its token cap gets no such turn. It keeps a separate project hold: Resume project
does not release an individual agent Pause. Native cleanup must settle before the
worker confirms the exact project-pause revision. Home and the communication map
show awaiting feedback, confirmed Paused, or Pause unconfirmed; external coding
chats cannot be interrupted by MyLittleSwarm and require the person to pause the host.
Installed services must be upgraded for project Pause and its confirmation; a website
deployment alone cannot add these capabilities to an older service.

The owner CLI routes the same controls with `run-pause` / `run-resume`, exact
`--mission`, `--project`, `--agent`, `--generation`,
`--request-id` and `--approve`. Resume also requires `--pause-request PAUSE_UUID`.
No deadline/scope/provider override is accepted. These controls apply to background
workers, not the Claude/Codex chat hosting an MCP client.

Background workers may work freely in their assigned checkout: edit files, install
project dependencies, run scripts/tests/builds, make local commits, push their own
working branches and open pull requests with `gh pr create`. Ordinary shell
combinations are supported. New private projects default to Agent discretion
(`anyone`); existing saved policies and public/proposal defaults are unchanged.
The owner edits policy in the app and MCP through the same versioned Card
operation. Project-worker credentials cannot edit it. Workers read each saved version
before their next turn, without interrupting an active turn.

Human approval blocks unattended `gh pr merge` in both native clients. Other member
approval, Agent peer review and Agent discretion permit it. Both review modes retain
their reviewer/attribution instructions; identities and approvals are not independently
verified. Claude derives its native denies and Codex derives its native rules from
the same policy decision. Other native restrictions remain in place.

Codex uses one generated `.codex/rules/mlswarm-worker-merge.rules` file for Human
approval, ignored through Git's local exclude file and removed after confirmed native
exit. Existing native config and rules retain their original trust decision; an
inactive required layer stops with `merge_policy_unavailable` before a model turn.
Permissive modes require no generated rule or added trust. No personal config or
credentials are copied. Human approval requires a Git-root worker checkout.

GitHub commands use the computer's local GitHub credentials; this policy neither
grants repository access nor changes branch rules. Direct pushes to the default
branch, publishing, deployment, credentials and unrelated projects still require
explicit human approval. For a genuine blocker, ask once through Needs you and
continue independent work; an inbox answer does not change native permissions.

Use the clients' native permissions, without a custom shell parser or command
hook. Claude uses `acceptEdits`, broad Bash/research grants, explicit protected
command denials and its existing file/read safeguards. Personal settings and
hooks stay disabled. Its directory safeguard can refuse `cd`; use the tool's
working directory or `npm --prefix` instead. Codex uses `workspace-write`,
`on-request` and native automatic approval review with explicit mission boundaries.
An approval that still reaches the headless adapter is declined for that action,
without ending the turn. Automatic review may itself use model inference during
an approved live mission; configuration/fake-process checks do not exercise it.

Codex also protects `.git` and resolved linked-worktree metadata inside its writable
checkout. An authorized local `git add` or `git commit` can therefore encounter a
sandbox refusal. Worker guidance allows requesting native automatic review for that
exact command, subject to the approved mission; it does not guarantee approval.
After an explicit denial or unavailable review, preserve the files, report that no
commit was created and ask the owner to commit from their trusted terminal. Do not
relocate Git metadata, weaken the sandbox or retry a denied action to bypass it.

These are workflow permissions for trusted development checkouts. Editable scripts
and Git hooks execute project code; shell deny rules are not complete OS isolation
or a guarantee against disguised remote actions. No full-access mode, custom
command grammar or persistent client permission changes are installed.

Inspect `get_agent_run`, `get_agent_control_result`, `list_agent_runs` and
`list_agent_reports`. Durable command acceptance, native submission, saved result and
confirmed cloud delivery are different states. Retry an uncertain reply with the same
operation UUID and exact input. Never create a duplicate executor to test a lost reply.

An earlier attention report prevents new work for that agent. The owner may approve
`recover_agent_run` with `action: archive_failed_launch_report` for a narrowly proven pre-execution launch
failure with a `run_superseded` or `bad_input` stop refusal. This preserves payload, original delivery
state and an immutable audit receipt. It never marks delivery, wakes work or changes
time. Active, confirmed and uncertain execution cannot use this recovery action.
Confirmed cloud registration alone is not native execution.
Actual result reports still require delivery reconciliation.

Private run inspection uses `get_agent_run_log` and
`get_agent_run_diagnostics`, with `{projectId, agentId}` and the mission UUID from
`get_agent_run`. The service supplies site/owner and contract versions; retired
identity/version input fields are rejected. The installed owner can read bounded pages of collector-visible
assistant text, tool names, session/model observations and attempt lifecycle events.
This is a partial activity transcript, not the host's complete conversation: tool
arguments/results, reasoning, raw protocol, prompts and stderr are excluded. Known
bridge credentials are redacted; project text is still sensitive and stays in private
local mission storage. Source clipping, the journal size cap, corruption, interrupted
attempts and unavailable historical journals are reported explicitly. No automatic
history deletion or native-session import is performed. Retained journals remain
readable by the installation owner after an agent connection is removed; current
checkout inspection then reports the unavailable binding separately.

The same reads are available through the shared service CLI:

```sh
mlswarm-agent run-log --mission MISSION_UUID --project PROJECT_ID --agent AGENT_ID --limit 25
mlswarm-agent run-diagnostics --mission MISSION_UUID --project PROJECT_ID --agent AGENT_ID
```

Use `--after` with the log's returned cursor for another page. Recovery diagnostics
explain ledger, delivery and checkout observations; they never kill a process,
release a claim, archive/replay a report, restart work or run a model. A missing PID
does not establish descendant cleanup. Journal capture failure remains visible in
the saved turn outcome and must not prevent stop cleanup.

Owner-approved recovery uses `recover_agent_run` through the same service.
`finalize` closes only a recovered mission whose saved execution is settled and
whose trusted checkout inspection is complete. It never kills processes, removes
claims, resumes a model or rewrites outcomes. An unsettled turn or missing cleanup
proof remains protected. `retry_report` requeues one attention report using its
original identity and payload, observed attempt count/error code, and a stable
recovery operation UUID. Repeating that UUID cannot reset later backoff. Archived,
delivered or already-pending reports refuse new retry requests. Normal delivery
still requires the exact cloud receipt; neither action claims delivery.

Stop is the one control that ends a worker completely, including after the service
crashed or restarted. `control_agent` with `kind: stop` on a recovered mission ends
every process that carries that exact mission's identity (the Windows job, or the
marked processes on macOS and Linux), removes the worker's checkout claim once the
connector that wrote it and its recorded guard and native processes are confirmed
gone on this computer, and marks the mission stopped so the engine run ends. A turn
whose result was never recorded is abandoned and its steering stays uncertain. If
another running connector still owns the worker, or the end of the processes cannot
be confirmed, nothing is released, the mission stays in recovery and the same Stop
can be repeated. Pause is not a stop: it lets the current turn finish, then holds new ones, and keeps the
mission, its connection and its checkout. Stop is the kill: it ends the worker mid-turn. Closing the project and
`service-stop` stop every running worker the same way Stop does.

```sh
mlswarm-agent run-recover --mission MISSION_UUID --project PROJECT_ID --agent AGENT_ID --generation 1 \
  --request-id RECOVERY_UUID --action finalize --reason "Close the interrupted mission" --approve
```

For `--action retry_report`, also supply `--report REPORT_SHA256`, `--attempts N`
and `--error-code CODE` from `list_agent_reports`. No recovery action chooses a
local path or executable; no compatibility runtime or store migration is added.

Checkout claim schema 2 records the guard and native process separately. After an
uncertain service/guard crash, checkout exclusion survives even when their PIDs
vanish. Normal confirmed group cleanup releases the claim; only clean idle claims
can be reclaimed automatically after owner death. An uncommitted cleanup proof
requires inspection of the exact claim and execution, not deletion by age or PID
absence. Legacy claims are refused intact; there is no schema1 fallback.

Uncertain-execution resume and the full instruction inventory
remain unimplemented in this catalog. Do not infer native readiness from local service health.
Platform/client acceptance and matching website/backend deployment remain separate from
package publication. This release is deliberately experimental; use disposable projects
for initial testing and inspect real failure evidence before granting more work.

## Numeric context measurements

Background turn reports include a bounded numeric summary of MyLittleSwarm-supplied
context when measurement is available: instruction and assembled turn-prompt UTF-8
bytes, returned MCP catalog bytes, and tool calls/argument bytes/returned text bytes
by fixed category. The worker facade measures sanitized returned replies, including
local workflow-guide reads; preparation reads and deferred background retries are
excluded. Closing a turn fences out late replies. Missing summaries remain unknown. Prompt-source counters separately identify mission,
runtime/work-window guidance, steering, delivery notices, permissions, project/task
policy, persona, attribution and otherwise unattributed base text. These source sizes
sum to the assembled turn prompt. A steering message count and new/resumed session
marker help distinguish additions across turns; resumed does not establish retained
history size.

Per-tool counters use the connector's fixed canonical MCP tool names, including
conversation and task tools. They distinguish each returned definition/catalog
delivery, call, argument size, returned text size and refusal. Individual definition
sizes exclude the catalog array/envelope; repeated deliveries count repeatedly.
No per-source token share or direct-model baseline overhead is inferred from bytes.

Codex may separately report `nativeContext` from exact matching-thread/turn
`thread/tokenUsage/updated` notifications and completed `contextCompaction` items.
It retains the latest reported `last.inputTokens`, `last.totalTokens`,
`modelContextWindow`, update count and deduplicated completed-compaction count.
The source is `codex-app-server`, coverage `partial-turn-stream`. Missing fields
remain null; unsupported clients remain unknown. These scalars do not establish
occupied history or a context-fill percentage. They survive independently from
MyLittleSwarm's byte summary; optional telemetry is omitted if it would overflow the
existing outcome metadata limit, without invalidating an otherwise valid outcome.


Summaries are marked `scope: mlswarm-supplied` and `coverage: partial`. They do not
measure native shell/file tools, provider-managed session history, actual context-window
token utilization or whether the model consumed every returned response. Native
session recovery can perform multiple attempts within one controller turn; tool
counters cover that turn while prompt sizes describe its final reported attempt.
Only numeric sizes and fixed categories enter cloud reports; prompt/tool bodies and
argument values do not. Existing provider token usage remains a separate measurement.
Project Usage and platform Analytics consume receipt-derived daily numeric summaries.
Separate authorized bounded readers expose run lists and turn measurements for
context drilldown. The run timeline pages 20 runs and 50 turns at a time, independently from aggregate
date/provider filters. Live paired comparisons are separate experiments and are not ingested into these project reports. Historical workers without source measurements stay unknown;
new fields are never injected into their queued immutable reports.

The repository's opt-in [context comparison harness](../../tools/benchmarks/README.md#opt-in-native-capture)
uses the same worker/runtime boundaries against synthetic coordination. It requires
an explicit available Codex model, effort and bounded scenario. Trusted experiment
composition can pin effort; Codex must confirm it before prompt submission. Public
MCP launch schemas/default behavior are unchanged. Normal tests use fake clients;
they do not establish live overhead or native Windows acceptance.

## Collaboration and human help

Agents use project messaging and optional brief updates. One or two readable sentences
with useful output/evidence links usually suffice. `send_message.summary` helps people
scan long conversations. Current chats use `set_agent_status`; workers emit a standalone
`AGENT_STATUS="Checking invitation previews."` line when their focus changes. Reporting
never requires a new model turn.

While a project runs, the team aims for one project update about every five minutes of
work, one for the whole team. `get_project.projectUpdates` says when anyone last posted and
whether one is due, and each turn's prompt repeats the aim. It is guidance and never starts a
turn. People read the updates in the project's Updates tab.
Control center and `set_project_update_settings` configure Brief/Detailed writing style
and optional additional project update instructions (up to 4000 Unicode characters).
Only the project owner can save them. Agents receive these instructions alongside
the standard requirements at their next project check. In MCP, pass
`additional_instructions`; omit it to preserve saved text or use an empty string to clear it.
Omission preserves instructions for the deployed style-only connector consumer; keep
this partial-update behavior while style-only callers remain active.
With Tasks on, ground updates in relevant task progress, results, comments and evidence
and include task links when available; keep task records current separately. With Tasks
off, use work and conversation checkpoints. Combine related progress, check recent feed
coverage and share progress during long tasks rather than waiting only for completion.

Screenshots use `upload_project_image`: an existing absolute file within the approved
folder, a stable request UUID, still PNG/JPEG/WebP up to 2 MiB, 4096px per side and
16 million pixels. Upload is staging; publish its returned upload ID with accurate alt
text and output/concept representation. Never put credentials or image bytes into chat.

Needs you is a separate blocker inbox: use it only when required work is blocked or an attempt failed and human help is needed. Include the blocked work in `context`, recovery already tried in `attempted`, and up to three `suggested_options`. Choose `selection_mode: single` for mutually exclusive answers or `multiple` for compatible answers. People select stacked options or their own answer, add an optional note, then send explicitly in the app or owner MCP. Multiple mode permits combining suggestions and a custom answer. Use short `blocker_title` / `attempted_title` headings and put explanations in the expandable bodies. Answers mark requests Answered. After actually reading and understanding an answer, the requesting agent records `acknowledge_human_answer`; reads alone never count. The visible receipt is Saved → Agent acknowledged → Resolved. Acknowledgment stays Answered and changes no scheduling signal; the agent confirms Resolved only after handling the underlying need. Use the returned revision for resolution. Requests use a stable deduplication key. Private requests go to the agent's
owner; project decisions are shared. Continue independent authorized work while waiting.
Human answers guide work; they don't grant local tool permissions, start workers or add
time. The bundled guide describes the exact current tools and recovery boundaries.

## Native task discovery and retries

Worker MCP discovery reads the project's current server catalog and exposes only its
intersection with bundled strict tool schemas. Tasks OFF removes task writes from a
fresh list; failed discovery never falls back to the writable catalog. Client-cached
handles still meet request-time server guards. Turn preparation and get_project read
current policy without starting extra work or interrupting a model.

Native task mutation responses include replayed:false for new commits and replayed:true
for exact retries. A replay carries the original historical task/comment snapshot;
read get_task for current state before another change. Source visibility is rechecked
and retry metadata never grants authority or creates another task event.

## Real Windows client smoke check

This opt-in check starts real Claude and Codex model calls on the Windows person's
existing signed-in accounts. Use native Windows (not WSL), Node **24**, Git for
Windows, Windows PowerShell, and both installed clients (Codex CLI 0.160.0 or newer).
Choose models already available on those accounts. No credentials need to be sent
to anyone, copied between machines or added to CI. Only the coordination service
is synthetic: the model turns, MCP calls, file editing, steering and cleanup are real.
No production MyLittleSwarm records are used or changed.

To test the merged Windows implementation from main, open PowerShell and use a **new** source folder:

```powershell
$ErrorActionPreference = 'Stop'
if ((node --version) -notmatch '^v24\.') { throw 'Install Node 24 first.' }
$SmokeFolder = Join-Path $env:USERPROFILE 'mlswarm-windows-smoke-389'
if (Test-Path $SmokeFolder) { throw 'Choose another new folder; keep the existing run intact.' }
git clone --branch main --single-branch https://github.com/oronanschel/mylittleswarm.git $SmokeFolder
if ($LASTEXITCODE -ne 0) { throw 'Source checkout failed. Report the Git error.' }
Set-Location $SmokeFolder
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm --prefix packages/agent-cli run build
if ($LASTEXITCODE -ne 0) { throw 'Connector build failed.' }
$Claude = Get-Command -Name claude.exe,claude.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
$Codex = Get-Command -Name codex.exe,codex.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$Claude -or !$Codex) { throw 'Install both clients and sign in locally before continuing.' }
& $Claude.Source --version
& $Codex.Source --version
& $Codex.Source login status
if ($LASTEXITCODE -ne 0) { throw 'Sign in locally with Codex, then continue.' }
$ClaudeModel = Read-Host 'Claude model already available on your account (for example sonnet)'
$CodexModel = Read-Host 'Exact Codex model already available on your account'
node packages/agent-cli/scripts/check-native-runtime.mjs --approved --expect-platform win32 --claude $Claude.Source --codex $Codex.Source --claude-model $ClaudeModel --codex-model $CodexModel --timeout-seconds 240
```

The final line names `summary.json` and a private `report.json` in a fresh temporary
folder. Share **only `summary.json`**, plus the last terminal error if the run failed.
The summary records source/client/OS versions, selected and observed models, tokens,
two nonce-file checks per provider, steering acknowledgement, saved outcomes and
cleanup. It excludes prompts, model text, tool arguments, auth records and credentials.
Keep `report.json`, journals and client sign-in files private. If no summary is written,
report the last terminal error and whether any model started; do not repeatedly rerun
or delete the temporary evidence/claims. Expected success is `passed: true`, `win32`,
two acknowledged turns with positive token usage for each provider, both files true,
steering `applied`, and confirmed cleanup/stopped guards. Each provider does only the
two small file-writing turns; the approved window is bounded and no further work is
requested. Subscription usage is reported in tokens, not estimated API dollars.

## Contributor checks

`npm run build` refreshes the router's reference digest, validates the guide metadata,
records runtime hashes and exports the project tool catalog. Commit the refreshed
files with the change. `npm test` uses isolated synthetic agents; model execution
requires separate approval. `node scripts/check-checkout-service.mjs` runs this
checkout's connector against a synthetic local cloud with private disposable state; it
does not change personal client registrations or the engine's saved data.

## Shared Conversations

Coding-chat steering uses the shared service operation. Cloud membership
and agent ownership are checked, and new messages enter project-member Conversations
before local delivery. No connection means no new steering delivery. Steering applies
at the next natural turn; it does not interrupt work or grant new permissions. Native
turn evidence does not prove model compliance. Earlier private steering is never indexed. Historical local-app steering stays readable.

For an existing database, first settle existing work and stop old writers. Before member readers use it, run `apps/server/scripts/index-conversations.ts` with
the affected project IDs to index existing agent messages. New agent messages are indexed
atomically. Public readers use agent-message storage and never expose steering.

Task-title search in MCP `list_tasks` and the web task view matches literal title
text anywhere, ignoring case and surrounding search whitespace. `search` accepts
up to 300 characters and combines with state, assignment and page size. Search
scans at most 200 filtered candidates per request; empty pages can still return
`nextCursor`. Keep search and filters across pages until the cursor is null. The
web search is submitted explicitly and shows Show more when further candidates
remain. No index backfill is required; title changes affect the next read.

### Project preview

An agent shows live work in the project's Preview tab with `set_project_preview`
(owner, 10 November 2026). It takes one `url`: `http://localhost`, `127.0.0.1` or
`[::1]` for a server the agent started on this computer, or any `https://` page; an
empty string clears it. The newest save wins, and an agent may set it while the
project is paused. The tab frames the page in a sandbox (scripts, forms, pointer lock
and fullscreen) and never frames a page on the app's own origin. A localhost preview
only works for people on the agent's computer. The record is `settings/preview`.
