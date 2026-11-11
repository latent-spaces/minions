# Decisions and open questions

How to read this file:

- New entries go directly below this note, so the top stays newest first.
- From the top through [Guest visibility](#guest-visibility--owner-selection-10-october-2026), entries run newest first, from 21 October back to 10 October.
- The 4–8 October baseline follows, from [Confirmed direction](#confirmed-direction) through [Public discovery before sign-in](#8-october-2026--public-discovery-before-sign-in).
- From [Proposal admission revision](#proposal-admission-revision--owner-choice-8-october-2026) to the end, entries run roughly oldest first, from 8 October to 21 October.
- The latest entry on a topic can sit at either end. A later entry says what it supersedes; the earlier entry is not always marked.
- Commit hashes in this file refer to the earlier history in the private `oronanschel/karma42-swarm` repository; run the `git show` commands there.
- Plans and contracts named without a link were removed in 6998671a. Read them with `git show 6998671a^:docs/<path>`. `pilot/REHEARSALS.md` (D11) had moved into docs/ in 450237da; read it with `git show 6998671a^:docs/evidence/rehearsals/REHEARSALS.md`.

## Project stamps show the newest update screenshot — owner decision, 11 November 2026

Noa replaced project pictures with id gradients on 19 October. Asked where the
restored cover should show, the owner chose “Stamps only (as before)”: the square
project stamp in the menu and the project header shows the screenshot on the
project's newest update that has one; the header banner keeps its gradient, and a
project with no screenshot keeps its initials on the gradient.

Later the same day the owner extended this to the My projects cards: the card's image
area shows the newest update screenshot (else the project's reference image) and is
taller. The owner also asked to drop the Owner, Joined and Waiting chips, because a local
engine has one person: My projects filters only All (current) or Archived.

## No top bar; the bell and My computers move to the menu — owner decision, 11 November 2026

Source: the owner in chat on 11 November 2026: “let's remove the entire top bar we don't
need to name since it's always me there is no sign-in and we need to remove and clean sign
in code, we can clean the bell and notification can go straight on the project or if it's
too complicated first move to the side bar”.

- The top bar is gone on wider screens, with its account menu (avatar and name) and the
  project search box. The Agents tab keeps its own search.
- The notifications bell becomes a Notifications row at the foot of the menu, opening
  upward, and My computers is linked just above it. This is the first step the owner
  allowed; putting notifications straight on the project is still open.
- Phones keep a slim row with only the menu button and the logo, as the menu drawer needs
  something to open it.
- Sign-in: the web already had no sign-in step (10 November). Only wording and the
  account-menu leftovers were removed. The hidden local owner session token stays: it stops
  other websites in the browser from driving the engine's 127.0.0.1 API.

## Agents get a model picked for their mission — owner decision, 11 November 2026

Source: the owner's README TODO item “Choose agent models on purpose” and the mission they
approved on 11 November 2026: when the skill adds an agent, it should pick a model that fits
the agent's mission instead of the client's default, warn when the default is a large model
such as Fable or Opus, and say why it picked.

- **The skill picks the model.** When the person hasn't named one, `add_project_agent` gets
  a Claude Code model sized to the mission: `sonnet` for routine work (the fallback when
  unsure), `haiku` for simple repetitive work, `opus` for hard work. Before, the skill left
  `model` out and the agent ran on the client's default, often its largest model.
- **A named model is used as given.** The skill doesn't argue or ask again.
- **Codex keeps its default** unless the person names a model; the skill says so.
- **It says why and warns.** The success line names the model and the reason in a few
  words, and warns in one clause when the agent runs on a large model such as Fable or
  Opus, because it uses the person's limits or tokens faster.
- **Not changed.** Website Add and start and the service's own default (no `--model` when
  none is passed) stay as they were.

## Task page and first-class subtasks — owner decision, 11 November 2026

Source: the owner in chat on 11 November 2026: “a tasks clicked should not open the right
drawer it should go to the task page and have a back button, and we should learn from
paperclip, and multica on how tasks are organized and that tasks will have subtasks as
first class”, then approving four points one by one (“Yes, approve 1”, then “Yes, as
described” for points 2, 3 and 4). This replaces “Task view unchanged” below. Paperclip and
Multica both open a full task page, model subtasks as full tasks with a parent link, and
never derive a parent's status from its children.

1. **Task page.** Clicking a task opens its own page with a Back link and breadcrumbs
   (Tasks › parent › task). The right-side task drawer is removed.
2. **Subtasks are full tasks.** A subtask has its own status, assignee and conversation and
   links to one parent task. Agents can nest two levels (a task, its subtasks); a deeper
   request from an agent is created one level up, under the same parent. People can nest
   to any depth. A parent's status is never computed from its subtasks: the parent shows a
   done/total ring, and its assignee is notified once when all of its subtasks are closed
   (done or canceled).
3. **Subtasks on the task page.** The page lists the task's subtasks with status and
   assignee, with a quick Add subtask field. Agents can propose subtasks; a proposal waits
   for the owner's yes before it becomes a task.
4. **Nested list, flat board.** In List, subtasks show under their parent with a toggle to
   collapse them and the done/total ring on the parent row. Board stays flat: each subtask
   is its own card in its status column.

## Project page: Tasks main page, Updates panel, Add task — owner decision, 11 November 2026

Source: the owner in chat on 11 November 2026, approving each change one by one, then
“go to work now” and, on visual concepts, “Skip, build now”.

- **Updates panel on every project page.** Project updates are a full-height right panel
  that runs from the top of the page, beside the header and every tab, not a tab. On narrow screens the panel collapses to an Updates button. The Updates
  tab is removed.
- **Tasks replaces Home.** The main tab is Tasks: tasks on the left and the agent
  communication map beside them in the main content (“the map should not be on the right
  panel”). Home and the separate Tasks tab are removed. With native tasks off, the page
  shows the map.
- **Setup notes in a strip.** Home's other content (waiting room, Add your agent,
  preparation) sits in a slim strip above the tasks.
- **Add task in the sidebar.** An Add task button above My agents opens a quick dialog:
  title, optional description, optional assignee. It shows only when Tasks is on and the
  viewer can add tasks. Later the same day: “add task on the sidebar should be a primary
  action”, so it is the menu's ink pill button.
- **Wider updates, better use of space.** Later the same day: “updates could be a bit wider
  and we can use the space in the page better”. The panel grows from 360px to 460px with
  the screen; the map sits beside the tasks only when the main column has room (960px),
  otherwise under them, so the task table keeps readable columns.
- **The map moves into the Updates panel.** Later the same day: “move the agent
  communication map to the updates panel and have on top selection between the map and
  updates”. The right panel opens on Updates, with an Updates / Map switch at its top; the
  tasks now span the main column. Before a project starts (or in its waiting room) the
  panel shows only Updates, as there is no map yet.
- **No project-start notice.** Later the same day: “Oron Anschel started the project …
  remove these toasts”. The notice, its Got it, the celebration and the seen/dismiss
  endpoint are removed; the start record (who and when) stays for the status panel.
- **View switches are soft pills.** Later the same day the owner asked why view tabs use
  the primary black and chose the soft pill switch: a grey track with the chosen option on
  a white chip. It applies to every segmented switch (List / Board, Updates / Map, team
  state, task status), so only real actions are black.
- **The start prompt can be edited.** Later the same day: beside Copy the prompt, “edit
  the prompt where it give u to choose between private public github, how many agents or
  free text”. Edit the prompt opens the choices in the tile (private or public repository,
  1–10 agents, what to build) and the quoted prompt follows them; the model and the five
  minutes stay as in the example.
- **Project sections in the menu.** Later the same day the owner moved the project's
  sections from the header tabs to the menu, above My agents, and renamed two of them:
  Conversations is now Communication and Control center is now Settings (Tasks, Preview,
  Teams and Usage keep their names).
- **Usage keeps less context detail.** Later the same day the owner removed “Supplied
  context by day” and the per-agent context timeline from Usage. “Now · latest turn per
  agent” shows the share of each agent's context window and the window size where
  reported, and hatches MyLittleSwarm's own setup as Karma42 does. The owner then also
  removed the “Exact values & coverage” section below it, and asked that Claude agents
  report their context window and request input so their share shows too.
- **Add task above the sections; Assign to as avatars.** The owner then moved Add task
  above the project's sections, and made the New task dialog's optional Assign to a row of
  agent avatars with a hover card in place of a dropdown, in a wider dialog.
- **My agents fits the space.** The owner chose, over an avatar grid or rotating rows,
  to show the My agents rows that fit the menu's remaining height, agents that need you
  first, with the rest behind “+N more”, which opens a popover list. It replaces Show more.
- **Task view unchanged.** The List/Board toggle stays, with List as the default. (Later
  the same day the owner replaced the task drawer with a task page and added subtasks; see
  “Task page and first-class subtasks”.)

## Job time limits come back — owner decision, 11 November 2026

Source: the owner in chat on 11 November 2026: “in default i want the skill to suggest
initial time limit to the agents and i want to return the time limits (that was already)
the skill should suggest a reasonable time for the mission”. From the options offered the
owner chose “Real job time limits” over a skill-only timer, and “Size-based” over a fixed
default length.

- **Time limits are back.** A job again has one end time shared by all of a project's
  agents. The owner sets it when starting the project (`control_project` `start` with
  `minutes`) and moves it with **Add time** (`add_time`): 5 minutes to 24 hours in
  5-minute steps, at most 24 hours left at once. A start without `minutes` gives the job
  60 minutes. This restores the behaviour removed in karma42-swarm 9122c4f6, 4e0078d6
  and b066bb42: choosing a run length at start, the end time and time left, Add time, and
  the waiting state when time runs out.
- **Time is up means waiting, not stopping.** At the end time an agent finishes its
  current turn and waits; added time continues it. The token cap, Pause, Kill and
  provider-limit waits work as before, next to the end time.
- **The skill suggests a size-based length.** Before starting a project, Claude suggests
  a run length sized to the goal and the number of agents, and the person confirms or
  changes it: about 30 minutes for a small toy or single page, 1–2 hours for a medium app
  or a toy split across several agents, and up to 24 hours for big work. A length the
  person already gave is used without asking again. When time is up, Claude offers to add
  time, again with a suggested amount.
- **Stored data.** Projects started while jobs had no time limit hold no end time. Their
  new agent starts wait for more time until the owner starts the project again or adds
  time, which gives it an end time. Nothing is deleted or migrated.

This supersedes [No time limit on a job](#no-time-limit-on-a-job--owner-decision-10-november-2026)
and the “For 5 minutes is Claude's timer” part of
[Projects start from Claude](#projects-start-from-claude--owner-decision-10-november-2026):
“for 5 minutes” is now the job's run length.

## Agents talk to each other at the start of a project — owner decision, 11 November 2026

Source: the owner in chat on 11 November 2026, when four agents started on the
MyLittleSwarm project: “agetn should be encourage to converse at start of projects”, then
“it's not a rule but a soft guidance”.

- **Soft guidance in the standing instructions.** `AGENT_PROMPT_V2.md` suggests that,
  when other agents are working on the project, an agent sends them a short message
  about what it plans to take on and which parts it expects to touch, reads theirs and
  sorts out overlaps before going deep. It is not a required step, and an agent working
  alone skips it.

## Agents set the Preview when the project fits — owner decision, 11 November 2026

Source: the owner in chat on 11 November 2026, after the Pixel Paint experiment, where two
agents built a browser editor and never set a preview: “they should use it if the project
is appropriate for that”.

- **In the agent's standing instructions.** `AGENT_PROMPT_V2.md` now tells agents to set
  the Preview with `set_project_preview` as soon as a first browser version runs (game,
  site or app), using the project's dev server or, for plain files, a static server such
  as `python3 -m http.server`. Before, only the `project-work` guide mentioned Preview, and
  agents read it only when they looked.
- **One agent per team.** The agent that starts the server says so in a message, so nobody
  starts a second one, and clears the link when its server stops.
- **Guide revision 72.** The `project-work` reference says the same.

## Local app opens without sign-in — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026: “let's remove the sign in thing and the
related screens, we don't need them in a local app (Coming soon, tour, etc)”. From the
options offered the owner chose “Open automatically” and “Remove all three”.

- **No sign-in step.** Opening the local app on this computer lets the owner straight in.
  The page asks the engine for the owner's session; the engine issues one only to its own
  page at its loopback address (`Host` and `Origin` checked, at most 30 a minute). There
  is no owner link, no `owner-link` command and no link file.
- **Screens removed.** Coming soon, the invited sign-in screen, the product tour (“How
  MyLittleSwarm works”) and Sign out are gone. When the engine cannot open the session
  the app says so and asks for a reload.
- **GitHub sign-in mode removed.** `MLSWARM_SIGN_IN`, GitHub OAuth sign-in, its setup
  and its docs are removed; the engine always runs with the local owner file. GitHub
  stays the person's own `gh` sign-in for repository work.
- **Unchanged.** Approving a computer is still the person's own yes in the browser.
  `npm run setup` recognizes its own running engine with `check-running`, which verifies
  an issued session against the owner file's secret. Existing databases and owner files
  keep working.

## Preview replaces Outputs — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026: “now we don't have outputs on claudeflare
but we can change the name to Preview, of the outputs tab and let say in the skill that if
there are live visuals we can show it there so it can be an iframe to some local game html
or whatever”. From the options offered the owner chose “Agent sets a link” and “Remove it”.

- **Preview tab.** The Outputs tab is now Preview. It shows, in a sandboxed frame, a page an
  agent set: a server it started on this computer (`http://localhost`, `127.0.0.1` or
  `[::1]`) or any `https://` page. The person clicks Open preview; Open separately opens it
  in a new tab. A page on the app's own origin is never framed. Guests do not see the tab.
- **An agent sets it.** Agents use `set_project_preview` with one `url`; an empty string
  clears it. The newest save wins, and an agent may set it while the project is paused,
  like its last update. The skill tells agents to set it when there are live visuals to
  try and to clear it when their server stops.
- **The old live link becomes the preview.** The owner-only `https` live link (`settings/live`,
  edited through `POST /:id/live-link`) was never shown in the app, so it is replaced by
  `settings/preview` instead of adding a second similar setting. The owner route is removed.
- **Cloudflare publishing is removed.** The static hosting module, its routes, background
  jobs and realtime topic, the agent tools `read_project_hosting`, `publish_project_output`
  and `upload_project_output`, and the owner tools `inspect_project_output`,
  `get_project_hosting`, `configure_project_hosting`, `upload_project_output` and
  `approve_project_output` are gone. A local engine never had the hosting service.

## Project updates come back — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026 asked “what happened to the updates?” and
“there was an update tab … (in the old karma42)”. From the options offered, the owner chose
“Bring it back”, “Bring back 5-min reminder” and “Update before pausing”. Text-only updates
were offered and not chosen, so every update still needs an image. This partly reverses the
lean web app decision of 9 November.

- **Updates tab.** Each project again has an Updates tab, restored from the feed removed in
  karma42-swarm f4d6638c and trimmed to the private swarm. It reads what the agents posted,
  newest first, with images and links. It has no public reading, no author filter and no
  composer for people: agents post, and the person reads.
- **A shared five-minute reminder.** `get_project.projectUpdates` again says when the team last
  posted and whether an update is due: the project is running and there is no post yet, or
  none in the last 5 minutes. A paused, not started or closed project has none due.
  Each turn's prompt says the team aims for one update about every 5 minutes. One post
  covers the team, not one per agent. The reminder is guidance: it never starts a turn or
  blocks work.
- **Update before pausing.** When a project is paused, each agent's last turn ends with a
  short update about what it did. The owner chose how on 10 November 2026 (“Short last
  turn”, over ending every turn with an update): after a project Pause, each agent whose
  latest turn was work gets one short extra turn. That turn only posts the update, or
  nothing if there is nothing new. It leaves queued steering for later and is not repeated
  until the agent works again. The Pause is confirmed when that turn ends. An agent paused on
  its own, stopped, or at its token cap gets no extra turn. So that this turn can post,
  agents may publish an update and upload its image while the project is paused; other
  new agent work still waits for Resume.

## Projects start from Claude — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026: “i don't want the option to create a
project from the local app only from claude, but we should add this kind of prompt so
people can see how it works”, with the example “open a private github repo and add 3
claude sonnet agents for 5 minutes build me a 2d game”. The owner then chose the answers
below from the options offered.

- **No create screen in the website.** The sidebar's New project row, the New project tile,
  the empty state's New project button and the Create project screen are removed. Claude
  creates projects with `create_private_project`. The server's `POST /api/projects/private`
  route stays: the server tests create their projects through it.
- **An example prompt instead.** My projects shows the example first in the grid, and in the
  empty state, with a button that copies it: “Open a private GitHub repo and add 3 Claude
  Sonnet agents for 5 minutes to build me a 2D game.”
- **Claude creates the repository.** The guide tells Claude to offer
  `gh repo create <owner>/<name> --private --add-readme` and run it after the person's yes.
  The connector does not create repositories.
- **“For 5 minutes” is Claude's timer, not a job limit.** Jobs still have no time limit (see
  “No time limit on a job” below). Claude starts the project, waits in its chat and pauses it
  when the time is up, and says that only an open chat can do this.

## Fresh repository with a single commit — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026, asked why the repository is so big
(“it should be a very small git”), chose option 1 of three: start a fresh history.

- **New repository.** MyLittleSwarm continues in the private repository
  `oronanschel/mylittleswarm`, starting from one commit with the files of
  `karma42-swarm` `main` at `4d01d97d`. A clone drops from about 357 MB to about 13 MB.
- **The old repository is the archive.** `oronanschel/karma42-swarm` keeps its full
  history, PRs and branches, and is not changed or deleted. Commit hashes and PR links
  in these docs point there.
- **Unused concept images removed.** 17 of the 18 files in
  `apps/web/public/project-concepts/` were not used; only `kindred-map.jpg`, on the
  sign-in screen, stays.
- **Unfinished work moves by hand.** Branches and checkouts of `karma42-swarm`, such as
  the job-limits work, are brought over as changes on top of this commit when they
  continue.

## Product renamed to MyLittleSwarm — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026: “let's also change the name of this
product we don't keep karma42”, then “Yes, MyLittleSwarm”. Asked “Rename everything,
including settings names and folders?”, the owner answered “Yes, everything”, then
“let's go for all of the above decisions”. For the names underneath, the owner chose
the short form “mlswarm”. Asked about renaming the GitHub repository: “Not now”.

What this means:

- **Name.** Everything a person reads says MyLittleSwarm: the website, its page titles
  and wordmark, the connector's messages, the MCP server instructions, the skill and
  the docs. Names underneath use the short form `mlswarm`.
- **Settings.** Every `KARMA42_*` setting is now `MLSWARM_*`, for example
  `MLSWARM_ENGINE_PORT`, `MLSWARM_ENGINE_HOME`, `MLSWARM_SERVICE_HOME`,
  `MLSWARM_SITE_URL` and `MLSWARM_SELF_HOSTED_ORIGIN`.
- **Folders.** The connector service and credentials are in `~/.mlswarm/service` and
  `~/.mlswarm/mcp` (`~/.mlswarm/instances/<id>/…` for an enrolled origin), the engine
  home is `~/.mlswarm/engine`, and project workspaces are `~/mlswarm/main`,
  `~/mlswarm/projects/<project>` and `~/mlswarm/instances/<id>`; on Windows the same
  under `%USERPROFILE%`.
- **Packages.** The connector package is `mlswarm` (command `mlswarm-agent`), the shared
  contracts `@mlswarm/contracts`, the server `@mlswarm/server`, the web app
  `@mlswarm/web`, the test and benchmark workspaces `mlswarm-tests` and
  `mlswarm-benchmarks`, and the repository root `mlswarm-workspace`.
- **MCP entry and tools.** Each site's MCP entry is `mlswarm-<8 hex>`, and the MCP
  servers are `mlswarm-local-runtime` and `mlswarm-project-worker`. The guide tool is
  `get_mlswarm_guide`; any later tool that names the product uses `mlswarm`.
- **Skill.** The bundled skill is `mlswarm` (`skills/mlswarm`), installed to
  `~/.claude/skills/mlswarm` and `~/.agents/skills/mlswarm`.
- **Internal names** follow: headers (`X-Mlswarm-Profile-Id`), cookies, storage keys,
  schema tags and temporary-file prefixes.
- **The repository keeps its name for now.** It stays `oronanschel/karma42-swarm`, and
  links to it stay.
- **Nothing migrates from Karma42 folders.** `~/.karma42`, `~/karma42` and their
  settings belong to the everyday Karma42 install and are never read, moved or deleted.
  The engine starts with a fresh database in its new folder. Setup leaves the everyday
  install's `karma42` MCP entries and skill as they are.

## Disconnect from the live site — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026: “do 1 , 2, and let's remove the
unnescessary files with all the db and stuff”, then “Level 2”.

What this means:

- **Level 1, now.** The connector defaults to the local engine on
  `http://127.0.0.1:8787` and no longer trusts `karma42.ai` or
  `karma42-launch.web.app`. A self-hosted origin set with `KARMA42_SELF_HOSTED_ORIGIN`
  and loopback `http` still work. Every site's MCP entry is named `karma42-<8 hex>`;
  the plain `karma42` name is no longer written.
- **No deploy path.** The deploy and image scripts, `tools/release`, `infra/cloud`, the
  Hosting configuration, the static-content Worker and the cloud-only delivery worker
  entry are removed. `firebase.json`, the Firestore rules and the indexes stay for the
  emulators. The [release guide](release/deployment.md) keeps the Release history of
  earlier releases.
- **Level 2, done.** The local engine is the only way the server runs. Removed: the
  hosted Firestore connection, Firebase/Google sign-in on the server and in the web
  app, Google Cloud Storage and Cloud Vision screening, the hosted, control and
  local-worker entry points, `tools/local` with its seeds, `infra/firebase` (rules,
  indexes, emulator configuration), the emulator-based test setup and the hosted load
  generator. Tests run on a disposable SQLite store with local sign-in. The store keeps
  its Firestore-shaped interface, collection paths and field names (including
  `firebaseUid`), so existing engine databases stay readable; `firebase-admin` remains
  only for the Firestore API types and value classes (`Timestamp`, `FieldValue`) the
  store implements. No public image screening provider ships, so public images are
  refused as unavailable, as before on the engine.
- **The live site is not touched.** `karma42.ai` keeps running the code it was last
  deployed with. Its live data and credentials are not touched.

## Agents wait out a provider limit — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026. Asked whether to include the rate-limit
fix (agents wait and retry on a usage limit) in this round, the owner answered “Yes,
include it”.

What this means:

- **Not a failure.** A model provider's usage limit, rate limit (429) or overload (529)
  does not count toward the three failures that end an agent. Other failures still do.
- **Wait, then try again.** The agent tries the same work again at the reset time the
  provider names. When it names none, the agent waits 10 seconds, then twice as long each
  time, up to 15 minutes.
- **Shown.** My agents says “Provider limit reached. Trying again at HH:MM”, or
  “Provider limit reached. Trying again” when the provider named no time.
- **Controls.** A waiting agent can be paused or killed. Its wait survives a connector
  restart.

## No time limit on a job — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026. Offered one “run for X” on the job of up to
7 days, or no time limit, the owner answered “Yes, up to 7 days”, then “no time limit”,
then “ok let's do all these”.

What this means:

- **No end time.** A job has no time limit. Agents work until the owner pauses or kills
  them, or until the optional token cap. At the cap an agent finishes its turn and waits;
  raising or removing the cap continues it. There is no default token cap.
- **Removed.** Choosing a run length at start, the end time and time left, **Add time**,
  and the waiting state for time that ran out. A scheduled start begins the job with no
  end. Built-in expiries that would stop a run of several days are removed.
- **Kept.** Start, Pause, Resume, Kill, Pause all, Kill all, the token cap and its editor
  in the job bar, and waiting or paused agents surviving a connector restart. A single
  turn still has a 24-hour safety stop for a hung turn; it is not a job limit.
- **Stored data.** Nothing is deleted or migrated. Stored project end times, worker
  session and mission end times, and end times in local connector missions are still read
  and ignored, so an end time that has passed leaves no agent waiting.
- **Not changed.** Work in this chat keeps its own time window.

This supersedes the end-time parts of
[Job limits design answered](#job-limits-design-answered--owner-decisions-9-november-2026),
[End of time waits; Stop and Kill are separate](#end-of-time-waits-stop-and-kill-are-separate--owner-decision-9-november-2026)
and “time is the primary limit” in
[Private swarm for bounded jobs](#private-swarm-for-bounded-jobs--owner-decisions-9-november-2026),
and the end-time placement in
[Limits follow-ups](#limits-follow-ups--owner-decision-10-november-2026) (B).

## Local connector package — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026. The owner's words: “let's build a new npm
for this repo and disconnect it from the old karma42”; asked for the name, the owner chose
“karma42-swarm”; asked about publishing: “for now local only and remove connection to the
old karam42”, and “for now for the development we can keep it local”.

What this means:

- **Name and distribution.** The connector package in `packages/agent-cli` is the private
  package `karma42-swarm`. It is not published to npm or any other registry.
- **Install.** A person sets up a computer from a checkout of this repository: run
  `npm ci --ignore-scripts` in it, then `node packages/agent-cli/src/cli.mjs setup`. The
  MCP configuration starts the connector with the running Node and that checkout's
  `cli.mjs`. The website's setup instruction says the same.
- **Update.** The connector does not update itself. The self-update machinery, its MCP
  tools, the website's update status and Update when idle control, the approval
  screen's automatic-update choice and the API's update routes are removed. A person
  updates by hand while no agent is working: pull, `npm ci --ignore-scripts`, restart the
  service and run setup again.
- **Old installs keep working.** Connectors installed earlier from npm still connect: the
  API accepts and ignores the update report they send. Stored update fields on computer
  connections and local update files are kept and no longer read; nothing is deleted or
  migrated.
- **Later.** Publishing the connector, or distributing it any other way, needs a new
  owner decision. This supersedes the npm `beta` channel described in earlier release
  records.

## Limits follow-ups — owner decision, 10 November 2026

Source: the owner in chat on 10 November 2026, accepting the session's recommendations:
“let's do that using opus5.5 subagents”.

- **A. The token pool never resets.** The pool lasts for the life of the project. To
  continue after the cap is reached, the person raises the cap. This answers the open
  question in [Token cap pool and limits screen](#token-cap-pool-and-limits-screen--chosen-under-owner-delegation-10-november-2026)
  of when a new job should start a new pool. No code changes.
- **B. Limits screen defaults accepted, with one change.** The job's end time and
  **Add time** appear in one place for the owner: the job bar above My agents. The project
  header no longer shows them to the owner; it keeps the project status and Pause all /
  Resume all. People who are not the owner do not see the job bar, so the header still
  shows them the end time and the time left.
- **C. Role-removal leftovers are removed.** Following
  [One person only](#one-person-only-token-cap-answers--owner-decisions-10-november-2026),
  nothing offers inviting people, roles, admins or moderators: the share button is
  **Copy project link**, project setup no longer carries a planned role (a stored one is
  dropped as it is read; nothing is deleted), the local demo's reviewer is
  **Local Reviewer**, and the agent hat is **Community rules**. Leaving a project, GitHub
  collaborator invitations and the moderation reports an agent can file stay as they are.

## Token cap pool and limits screen — chosen under owner delegation, 10 November 2026

Source: the owner in chat on 10 November 2026. Asked to choose between keeping the
per-agent or shared switch and always one shared pool, and between three limits-screen
concepts, the owner answered “review them and decide”. The coordinating session chose
under that delegation:

- **One pool.** The token cap is always one pool for all the person's agents in the
  project. The per-agent mode is removed. This supersedes “Shared pool” in
  [Job limits design answered](#job-limits-design-answered--owner-decisions-9-november-2026)
  and the per-worker cap in
  [Private swarm for bounded jobs](#private-swarm-for-bounded-jobs--owner-decisions-9-november-2026).
- **Tokens stay in the pool.** The pool keeps the tokens of ended, restarted and revoked
  agents, and of an agent's earlier missions. Each new mission still counts its own
  tokens from zero, but its earlier missions stay in the pool.
- **Job scope.** The pool counts the missions in contact since the job started
  (`execution.startsAt`). A project starts once; reopening does not start it again. So
  in practice the pool counts all the person's missions in the project. When a new job
  should start a new pool is still open.
- **Limits screen (slice 5).** Concept 1, a job bar above the agents, with concept 2's
  exact-number cap editor. This settles layout only.

## One person only; token cap answers — owner decisions, 10 November 2026

Source: the owner in chat on 10 November 2026, answering the questions in PR #16 (job
limits slice 4): “we focus on one person now , not multiple people we can remove
invaites and all of this”, “unkown usgae like now”, “yes tokens stays in the pool”,
“one cap is enough”, “let’s remove admin moderators and so on we are focused on single
person use”.

- **One person.** The product is for a single person and their agents. Invitations and
  the rest of the multi-person features can be removed. The admin and moderator roles
  are removed; the one person is the owner.
- **Unknown usage is not counted.** A turn whose provider reported no usage does not
  count toward the token cap; it is reported as unknown.
- **A killed agent's tokens stay in the shared pool.**
- **One cap for all agents.** It is one pool that all the person's agents in the project
  count toward. There is no separate cap per agent.
- **What follows.** A shared pool covers all the person's agents in the project, which
  is every agent in it. Only the owner sets the cap once the admin role is gone.

- **What is removed.** The owner accepted this list the same day with “yes go with
  your recommendations”: invitations, invite links and join links with their emails;
  member roles, admin and moderator, and the moderation controls over other people's
  agents; remove-and-ban and the people list; the platform admin routes for invites.
- **What stays.** Public projects, Explore and proposals; teams; community rules;
  feedback reports; Needs you requests from agents.
- **Order.** The removal is one PR, made after the open job-limits and lean-tool-results
  PRs are merged.

Not answered, so kept as it is: the token count starts again with each new job of an
agent. Stored records are not deleted.

## Tasks tab has two views — owner direction, 9 November 2026

Source: the owner in chat on 9 November 2026, relayed by the coordinating session:
“tasks tab should have two views the current and trello/ multika like”.

- The Tasks tab has two views with a switch between them: the current view, kept as
  it is, and a board view like Trello or Multica (columns of cards).
- Both views read the same task data through one implementation; there is no second
  task store.
- Asked about concept mockups for the board, the owner said the same day: “no need
  for mocks just do it”. The board is built without mockups, with these defaults,
  which the owner can correct in the PR: columns are the existing task statuses in
  their order; a card shows title, assigned agent and state; the current view stays
  the default and the chosen view is remembered per browser; dragging a card changes
  its status only where the app's existing permissions and transitions already allow
  that change, otherwise the board does not change status; at phone width the columns
  scroll sideways.

## It is the local app — owner wording, 9 November 2026

Source: the owner in chat on 9 November 2026, relayed by the coordinating session:
“it's not web app it's local app now right?” The coordinating session confirmed that it
runs locally and is opened in a browser, offered to change the wording, and read the
owner's reply as agreeing.

- Current docs and user-facing text call it the local app. Earlier entries in this
  file keep their wording.
- Code identifiers, package names and paths such as `apps/web` keep their names.

## Lean app behavior changes confirmed — owner confirmation, 9 November 2026

Source: the owner in chat on 9 November 2026, relayed by the coordinating session,
after the seven items under “Behavior that changes — please check” in
[PR #3](https://github.com/oronanschel/karma42-swarm/pull/3) were put to them one by
one: “I agree to all of the proposed changes.”

- Private projects only.
- The app does not edit a project's title, goal, live link or community rules.
- The app has no invitations, join links or member management.
- Names are plain text.
- Top-bar search works only inside a project.
- A signed-out visitor sees Coming soon and sign-in.
- Private messages and the people directory are removed; stored records are untouched.

## One-command engine setup — owner approval, 9 November 2026

Source: the owner approved the backlog item on 9 November 2026, relayed by the
coordinating session.

- **One command** (`npm run setup`) takes a fresh clone to a built, initialized and
  running engine with this computer connected through the connector, on macOS and
  Windows alike, reusing the existing engine and connector CLIs.
- **Two steps stay in the browser**, because they are the person's own yes: opening
  the one-time owner sign-in link, and approving this computer. The command opens
  the link and waits for the approval; it never prints the sign-in code.
- **Unchanged.** A separate connector installation still changes no coding-client
  settings and no GitHub sign-in; those remain printed next steps.

## Lean, paginated tool results by default — owner direction, 9 November 2026

Source: the owner in chat on 9 November 2026, relayed by the coordinating session:
“tool call everywhere will not give too much information if it's listing for example
list project should return only project names in default and paginated the if the
agent need more info he can ask more info, also coversations etc, we [need] to get
into the defaults of exactly how and what but that's example, for example the
conversations ... should be only the titles and who to whom”.

- **Every MCP tool that lists things returns a lean, paginated result by default.**
  The agent asks for more detail when it needs it.
- **Examples the owner gave.** Listing projects returns only project names; listing
  conversations returns only titles and who is talking to whom.
- **Confirmed by a short reply (“ye s”), say if wrong.** This applies to this
  repository, not the main Karma42 app; and the skill and guide tell agents to use
  the short conversation list by default.

Added the same day. Six choices were put to the owner, each with a recommended option
A. Asked whether “A for the rest” covered them, the owner replied “your
recommendations”, so A is selected on all six:

- **Asking for more.** A list tool takes `detail: true` for full rows; the existing
  read tools return one item in full.
- **Page size.** 20 rows by default, 100 at most.
- **Project rows.** ID and name only.
- **Conversation rows.** The first message's summary, or its first 80 characters when
  it has none, with who is talking to whom and the message count.
- **Worker inbox and thread reads.** These keep full message bodies, with the same
  paging.
- **`get_project` and `get_project_overview`.** They no longer repeat the goal, and
  the long guidance moves to the guide.

## Job limits design answered — owner decisions, 9 November 2026

Source: the owner in chat on 9 November 2026, relayed by the coordinating session,
answering nine options put to them: “i think pause is better name than stop, and
kill is kill, waiting should survive restart, and A for the rest”.

- **Pause and Kill.** Pause lets the worker finish its current turn, then the worker
  waits and can continue. Kill is the immediate complete kill and ends the worker.
  Both exist per worker and for all workers.
- **One waiting state.** Pause keeps its name with this new meaning; it no longer
  interrupts the turn. End of time, Pause and the token cap all lead to waiting.
- **No bound on a turn that runs past the end time.** It runs until it finishes or
  the owner kills it. The owner was told a runaway turn spends tokens until killed
  and still chose this. The web app says the worker is past the end time and
  finishing its turn.
- **No limit on waiting.** Workers wait until the owner adds time, kills them or
  closes the project.
- **Waiting survives a connector restart.**
- **Token cap.** At the cap the worker waits after the turn that crossed it; raising
  the cap continues it. The cap is checked between turns for Claude and Codex alike,
  so a worker can pass it by up to one turn. Input, cache writes and output count;
  cache reads do not.
- **Every job needs an end time**, and there is no separate time per worker.
- **Shared pool.** When the owner turns it on it replaces the per-worker cap.
- **Adding time** moves the end time for all workers and continues waiting workers.

Added the same day. The coordinating session asked about the two values left open and
the owner replied “your recommendations”:

- **An end time is required; a token cap is optional.**
- **Default job length: 60 minutes**, matching the worker default before this change.
  The number was the coordinating session's recommendation, accepted by this reply.

## End of time waits; Stop and Kill are separate — owner decision, 9 November 2026

Source: the owner in chat on 9 November 2026, relayed by the coordinating session:
“i want to be able to either stop or kill, at the end of time they finish the turn
and wait, if i extend the time they continue”, and earlier in the same exchange
“don't want to kill the workers at the end of time”.

- **The end time does not kill.** At the end time each worker finishes its current
  turn and then waits; it starts no new turn.
- **Extending the time continues the work.** Waiting workers resume when the owner
  extends the time.
- **Stop and Kill are two separate owner actions.**

Not decided: the exact meaning and names of Stop and Kill, whether a turn that runs
past the end time has an upper bound, how long workers may wait and what waiting
holds, what happens at the token cap, and how the existing Pause relates to waiting.
This narrows “Time is the primary limit” in the entry for the private swarm below;
nothing here is implemented yet.

## No human chat in the web app — owner decision, 9 November 2026

Source: the owner in chat on 9 November 2026: “remove the human chat”.

The Humans only chat beside every project section is removed from the web app, with
its composer, drafts, uploads and reactions. Project pages use the full width. The
read-only agent Conversations tab stays. The server's human chat routes and stored
messages are untouched.

## Lean web app for the private swarm — owner selection, 9 November 2026

Source: the owner in chat on 9 November 2026. The owner asked: “let's make this repo
lean, only what we need (include UI) and remove all the general app stuff, it should
be super lean”, accepted the first pass with “Yes, pass 1”, and accepted the
recommended list of screens to keep with “Yes, use it”.

- **Pass 1.** Research, design archives and side tools the private swarm never runs
  were removed.
- **Global screens kept.** My projects (landing), New project, Needs you and
  Computers. Explore, public project proposals and their review, the platform admin
  page, profiles, the people directory, private messages and Karma42 invitations
  were removed from the web app.
- **Project tabs kept.** Overview, Agents, Tasks, Conversations, Needs you, Usage and
  Settings. The Updates, Community and Details tabs were removed.
- **Settings kept.** Status, Repository, Agents and Merging. People, Visibility and
  Updates were removed.
- **What follows from the list.** These were not confirmed one by one. The web app creates private projects only.
  It no longer edits the project card, live link or community rules, and no longer
  manages invitations, join links or membership. Names of people are plain text.
  Search is available only inside a project. A signed-out visitor sees sign-in, not
  Explore.
- **Server.** The private-message and people-directory routes were removed with their
  screens. Stored records are untouched.

Not selected, so kept as they are: the Outputs and Teams tabs, the Features settings
tab, the hosted sign-in, invitation and join entry screens, Feedback, the product
overview and web presence. Connector tools and server routes for the removed screens,
and the documents that describe those screens, also remain until the owner chooses.

## Private swarm for bounded jobs — owner decisions, 9 November 2026

Source: the owner in chat on 9 November 2026, after a spike that compared merging
this engine with `main` and ran two real workers on it.

- **No hosted account.** The first version runs on the self-hosted engine.
- **Private and single-owner.** One person, loopback only, for the first version.
- **Separate private repository.** This repository starts from
  `oss/self-hosted-engine` at `9b543fff7`. It replaces integrating that branch into
  the Karma42 repository and does not catch up with Karma42 `main` as a whole; fixes
  are copied over only when needed.
- **A GitHub repository is required to start.** Owner's words: “we will require a
  github repo as a start”. A project running on only a local folder is not planned
  for now.
- **Start and kill workers completely.** Owner's words: “we need to able to start
  and kill compeltely workers”.
- **Time is the primary limit and tokens are a cap.** Owner's words: “we should use
  time as primamry limit, token as a cap, they share if we say”. Sharing is opt-in:
  limits are per worker unless the owner says workers share them.
- **Sharing defaults.** The owner accepted this proposal with “go”: a job has one
  shared end time for all its workers; tokens are capped per worker, with a shared
  pool only when the owner asks for one.

The license, public release, web-app inclusion, moderation opt-out and Windows
acceptance remain open. These decisions do not authorize deployment or use of
production data or credentials.

## Standalone self-hosted engine — owner direction, 2 November 2026

Source: owner steering to the self-hosted-engine project on 2 November 2026:
“run the whole thing yourself is the direction”.

The owner selected standalone self-hosting: people operate the engine service,
workers and database themselves. Implement this through shared storage, identity
and infrastructure boundaries, with Karma42's hosted implementations retained.
Independent connector instances use an explicitly selected service origin and
separate local approvals and state. Work integrates through peer-reviewed PRs
into `oss/self-hosted-engine`, based on `713f0053`.

The license, public release, whether the web-app source is included, and any
moderation opt-out remain separate owner decisions. This direction does not
authorize deployment or changes to production data or credentials.

## Usage tab leads with agent rows — owner selection, 2 November 2026

Source: the owner asked to make the Usage tab "more visual much less text" and to "lead
with the current status with a stacked bar plot of several agents with legened and hover",
then chose concept A: "A: agent rows / but fix the colors the colors are bad".

- The tab opens with one row per recently active agent: a stacked bar of what Karma42
  supplied on its latest turn, its total, a request-pressure ring and a short trend.
  Hover or focus shows the exact value.
- Top tools, turn outcomes and supplied context by day follow as charts. The detailed
  numbers and coverage notes stay available under "Exact values & coverage".
- Colours use the validated dataviz palette in a fixed order, with status colours kept
  for outcomes. Bytes and tokens are still never stacked together or converted.
- Concepts and corrections: [docs/design/usage-visual](design/usage-visual/README.md).

## Agent status in the sidebar follows the communication map — owner decision, 2 November 2026

Source: the owner reported in Claude Code that "the sidebar status and the agent communication map icon are still not synced" (screenshot: the same agents Offline in the sidebar and Working on the map). Claude recommended that a session heard within 90 seconds wins for activity. The owner replied "do it and clean code if possible".

- Own-agent status (sidebar, Agents tab, run controls) shows Working, Idle or Blocked from the agent's session when the session reported within 90 seconds and is newer than the computer's snapshot, even if that snapshot is older than 90 seconds. This matches the map's current-state rule.
- Offline now means neither the computer nor the session was heard within 90 seconds.
- Pause, Stop, Recovery and ended allowed time still follow the computer's snapshot.
- Supersedes the 26 October rule (23b9aa55) that a computer not seen for 90 seconds stays Offline even when its session is fresh. That rule came from an agent review cycle and was never recorded as an owner decision.

## The card's scope field is called Rules — owner decision, 2 November 2026

Source: the owner asked for "rules" on the public card, then chose the recommendation
to rename only the labels ("go with your recommendation on the rename").

- The card section "Scope & boundaries", the "Initial scope" field in the proposal form
  and Card settings, and "Scope" in the public-conversion review are now labelled Rules.
  The agent text built from the card says "Rules:" instead of "Scope:".
- The stored field stays `scope`, so no data changes. Rules are on public cards, as
  scope already was.
- Shared instructions (agent guidance) stay a separate, members-only field and are not
  folded into Rules.
- Community rules remain their own section, which the owner edits in Settings.

## Remove and ban on Home, and agents use tasks again — owner request, 2 November 2026

Source: the owner asked to put removing a person on Home, next to roles and GitHub
permissions, to "allow the owner to ban", and said "we need to fix the tasks" after
noticing agents rarely use them.

- On Home, the owner sees Remove and Ban on every other person's row, each confirmed
  first. Removal stops the person's agents in the project, as it already did from
  Control center.
- A ban is a removal that invitations, invite links and email invitations can't undo.
  Only the owner bans. Control center lists the person as Banned with Lift ban, which
  leaves them removed; they can then be invited or restored like anyone else. The
  owner MCP tool keeps its current remove-only behavior.
- Moderators keep their 20 October powers (pause or stop a participant's agents, with a
  reason, from that person's page). They can't remove or ban.
- The background agent prompt again tells agents, when tasks are on, to check the
  backlog on start and after each piece of work, claim what they take up, file
  follow-ups as unassigned tasks and mark their own tasks done. Small investigations,
  discussion and reviews still need no task. This restores guidance the 28 October
  skill router moved out of the core prompt.

## Per-person access on Home and a plain Outputs tab — owner selection, 1 November 2026

Source: the owner asked to show merge and publish permission as buttons like the
role choice, keep three simple per-person controls on Home, call the tab Home and
clear the text from the Outputs tab, then approved building it.

- Each person row on Home shows Role (Member / Admin / Moderator, owner-assigned),
  Can merge and Can publish as toggle buttons that save at once. The role select with
  Apply / Cancel is removed.
- Owners and admins can always merge; their Can merge is shown on and locked. Toggling
  anyone else uses the selected-people merge policy.
- Can publish means publishing directly (automatic hosting mode with that person as a
  submitter). The approval mode is no longer offered in the web UI; the server and the
  `configure_project_hosting` MCP tool keep it.
- The project tab is always called Home; the separate Waiting room label is retired.
- The Outputs tab keeps only the output, refresh and the build/unpublish controls; its
  explanations, MCP instructions and owner policy settings are removed.

## Upload-only MCP hosting without agent execution — owner selection, 31 October 2026

Source: asked whether designated members should be able to upload through MCP
while projects remain paused, the owner selected “Add upload-only MCP access;
keep agents stopped”. The owner also authorized doing the work needed to publish
the five selected games and using agents to implement/test the work. Use coding
review/test agents without starting or resuming the existing game agents.

An approved computer may submit built static folders on behalf of a currently
owner-designated member, without an agent run or work window. Uploads remain MCP-only;
ordinary browser sign-in supplies no file ingress. An upload is not agent execution
and does not resume a paused project. Closed projects remain read-only. Preserve
membership epochs, owner-selected submitters/approvers, exact-build approval,
automatic-mode policy, stable retries, storage bounds and computer revocation/expiry
through publication recovery. Project-worker uploads retain their existing run and
working-folder checks. This supersedes the earlier agent-run-only upload rule.

## Native hosting release and platform timing — owner selection, 31 October 2026

Source: the owner said “Let’s merge and deploy PR #423, and I’ll check Firefox
and Safari live. We can defer Windows for now.” This supersedes the earlier
selection keeping every platform check blocking. Merge and deploy the reviewed
coordinated hosting release. Native Windows acceptance is deferred; Firefox,
Safari and iOS acceptance remains pending live manual verification after deployment.
Local Chromium/WebKit and simulated touch do not establish those platform passes.
Record each result or deferral explicitly in release evidence. No model execution
or unrelated production changes are authorized by this release decision.

## Existing friends' projects may become public — owner selection, 31 October 2026

Source: the owner selected “Use all five; add public project conversion” for
“2D Game with Shunit”, “2D Game with Itai-benari”, “2D Game with Almog”,
“2D Game with Alon”, and “Friends Game”. Asked about existing private project
chat, the owner explicitly selected “Also make existing project chat public”.

Add an owner-controlled private-to-public project conversion, with explicit notice
that the project card, repository link, published output and existing project chat
become public. Preserve agent conversations and other member-only history, current
memberships, execution controls and repository access. Conversion does not change
GitHub repository visibility or start agents. Implement and validate the supported
conversion before applying it; do not rewrite private provenance or fabricate a
reviewed proposal through direct datastore edits. This supersedes the earlier
examples-only restriction for these five projects. Production hosting deployment,
merging and package publication retain their separate release authorization.

## Native build uploads use MCP only — owner selection, 31 October 2026

Source: the owner said “upload should be done only via the mcp”. Submit built
folders through `upload_project_output`; the later upload-only MCP selection above
allows an owner-designated member's approved computer as well as an authorized
project agent. Browser folder upload, client-side packaging/retry and human Firebase
prepare/file/seal ingress remain removed. The app retains exact-build review,
approval, automatic publication settings, viewing and Unpublish. Owners select
eligible current members; browser sign-in alone grants no upload path. Preserve
the selected review-alongside-output layout and publication authority.

## Native hosting retention — owner selection, 30 October 2026

Source: the owner replaced the earlier five-build choice with “Current build +
24-hour grace”. Keep the current public build; replaced releases remain available
for 24 hours, then their payloads are eligible for deletion. This supersedes the
five-build rule. Clean abandoned uploads 24 hours after upload expiry; preserve
valid builds awaiting approval and pending publication. Obsolete-policy candidates
become eligible after a 24-hour grace period. Current-build staging duplicates can
be removed without removing the published payload. Keep small authority/idempotency
fences, and reclaim reservations only after scoped deletion is confirmed.
This selects future feature behavior; it authorizes no production cleanup now.

## Native Outputs screen — owner selection, 30 October 2026

Source: the owner selected “B — review alongside output” from the two generated
hosting layout concepts in this Codex chat. Follow the existing Gallery Workspace
visual system and keep the current public release distinct from a pending candidate.
The concept's data is synthetic, not evidence of a connected or published service.
Use “Eligible submissions are published automatically” for automatic-mode copy.
This selects screen layout; it grants no hosting/deployment or repository authority.

## Native hosting v1 audience and publication rules — owner selections, 30 October 2026

Source: the owner requested an English goal to implement and review PR #423, then
selected “Public outputs only for v1” and “Use these v1 rules” in this Codex chat.

V1 serves public outputs only. The owner explicitly enables each publication.
Automatic mode accepts builds from owner-designated current project members and
their authorized agents. Approval mode requires one currently designated person
to approve the exact build. Policy changes invalidate pending approvals. Source
repositories and project records do not become public with a hosted output.

Implementation and local review are authorized. Paid resources, cloud validation,
merging and deployment remain separate release steps. PR #423 tracks the work;
its earlier audience and publication-rule questions are settled by this entry.

## Native static hosting on Cloudflare — owner selections, 30 October 2026

Source: in this Codex chat, the owner selected “אז בוא נלך על Cloudflare ונכין
תוכנית מימוש לאחסון סטטי כחלק ממערכת התבניות”, then immediately corrected the
scope: “לא כחלק מהתבניות זה יכולת בסיסת native” (a native platform capability,
not part of templates). Asked who may publish, the owner selected “בעל הפרויקט
יכול לבחור, עדכונים אוטמטים, או לאשר את האנשים שמאשרים” (the project owner
chooses automatic updates or designates the people who approve publication).

Plan Cloudflare-backed static hosting as a native Karma42 project capability.
It is not restricted to games, project templates or a template-created project.
It can serve browser games, static pages, reports and other supported static
outputs. Templates may supply defaults later; they do not own hosting state or
grant publication authority. This serves accessible project outputs and
traceability while preserving the vision's separation of execution and human
authority.

The project owner controls the publication policy: automatic updates or approval
by owner-designated people. Keep that policy separate from repository merge
authority, agent execution grants and the ability to upload a candidate build.
The v1 selections above settle current submitter eligibility, exact-build approval
and policy invalidation. Repository merge authority and agent execution grants
remain separate from hosting publication.

The owner then selected integrated viewing: “אני רוצה להנגיש את זה בתוך iframe
אצלנו או משהו דומה” (make it accessible inside an iframe or similar within
Karma42). Present hosted output within the project experience using the selected
review-alongside-output layout. Browser isolation and a separate content origin
must preserve account and cross-project boundaries.

The owner also selected the games previously built with friends as initial
examples. Use existing authorized game repositories as local acceptance
fixtures without restarting agents or changing those repositories. The owner
subsequently confirmed “אפשר לפרסם את משחקי החברים שעשינו לציבור” (the friends’
games may be published publicly). This explicitly permits public publication of
the selected playable game outputs, including outputs from their private projects.
It does not make source repositories, project records or credentials public. Keep
private fixture provenance outside the public planning PR. Keep local development
preview, embedded hosted output and public publication distinct.

V1 public-only serving and explicit owner consent for output files are selected
above. Member-only hosting is deferred. Customer quotas and domain choice remain open; engineering bounds do not select a pricing plan. Preserve
private project files and credentials: selecting Cloudflare does not make an
existing project public.

This selects the provider and product direction. Implementation/local review and
public release of the selected example game outputs when the hosting release is
ready are authorized. It does not authorize paid subscriptions, domain registration,
cloud resource creation, model runs, merging or unrelated production-data changes.
Provider selection performs no deployment or publication. Keep implementation,
contracts, acceptance evidence and remaining release gates in PR #423; these
product selections do not establish production readiness.
## Connector TOML parsing and web data sharing — owner selection, 31 October 2026

Source: Oron's answers in this chat to the open-source hardening review's Phase 3 questions.
- The connector reads people's Codex `config.toml` with smol-toml, a new runtime dependency
  of the published `@karma42/agent` package, instead of hand-written parsing.
- The website adds React Query, starting with one shared Needs-you query for the bell and the
  Needs-you page; other screens move one at a time.
Windows background workers, `TRUST_PROXY`, the Hosting page CSP and `turnBudgetUsd` remain open.

## Server consistency rules for hardening — owner selection, 30 October 2026

Source: Oron's answers in this chat to the open-source hardening review's Phase 2 questions.
- `limit_reached` returns HTTP 409 from every router.
- Web POSTs time out after 30 seconds and say the change was not confirmed, offering a
  retry of the same request (writes carry a `client_request_id`).
- A GitHub `invalid_response` is retried on the existing persisted retry schedule, and the
  repository is blocked after three in a row (`npm run sync:github`).
  Added 31 October (Oron's “ok” in this chat): a blocked repository, including one blocked by the
  earlier first-failure rule, is unblocked only by an operator with `npm run sync:github -- <project-id>
  <repository-id> <resource> --unblock`, which clears the failure counters and reads nothing.
- GitHub repository URLs compare owner/repo in lowercase and accept a trailing `.git` or `/`
  on input.
- Profile-photo refusals use the shared statuses: a rejected image is 422 and unavailable
  moderation is 503, which the web offers to retry.
Hosting frame/CSP headers, the React Query cache rule, smol-toml and Windows background
workers remain open.

## Project update settings layout — owner selection, 30 October 2026

Source: Oron's explicit “let's go with B” in this chat, after reviewing two concepts.
Use [concept B](design/project-update-settings/README.md): visible Brief/Detailed
length choices, a compact instructions field and a single Save action. Remove the
style-details disclosure and repeated explanatory prose. This selects presentation
and clearer copy; existing publication limits, permissions and save semantics remain.

## Additional project update instructions — owner selection, 30 October 2026

Source: Oron's request in this chat to add update instructions through MCP or Control center.
Owners/admins can save optional project-specific instructions alongside the writing
style in Control center → Updates or the owner MCP tool `set_project_update_settings`.
Agents receive the text at their next project context read, supplementing the standard
update requirements. Empty text clears it; omitted MCP text preserves it. Limit text
to 4000 Unicode code points and retain existing permission, revision and retry rules.
This serves participant guidance and readable progress without adding execution authority.

## Selected-people merge access enforced by GitHub — owner decision, 30 October 2026

Source: the owner in this Codex chat explicitly selected: “yes let's do the enforced
version, owners and admins can merge by default and give merge access to selected
people, everyone else can only open PRs”. This serves People define shared goals and
boundaries: project administration controls whose contributions may enter main.

Add an opt-in merge-access mode alongside the existing review instructions. Project
owners and admins grant/revoke merge access for current members; owners and admins
are included automatically. Other members may push working branches and open PRs.
Agents act through their person's GitHub account and inherit that account's access.
This grants no project role, steering, publication or deployment authority.

The owner's approved computer applies a repository-level GitHub branch ruleset,
using verified numeric account IDs and pull-request-only bypass for the allowlist.
Target main and the default branch. Block direct updates, branch recreation,
deletion and force pushes; preserve other GitHub rules/checks and review requirements.
No GitHub App or credential proxy is introduced. The GitHub repository's own admins
retain their inherent ability to edit its rules. This supersedes the previous
no-GitHub-rule-writes restriction only for the explicitly selected access mode.

Saving is desired policy, not confirmed enforcement. Show pending, verified, stale
and failed synchronization separately. Grants/revocations take effect after GitHub
synchronization; an offline owner computer cannot apply changes. Missing verified
identities, unsupported GitHub plans/permissions and conflicting managed rules must
never become a guidance-only success. Keep existing selections/defaults until an
owner/admin explicitly opts in. Removing/rejoining does not restore a prior explicit
grant. Disabling removes only this project's managed access ruleset after verification.
Placement refinement from the owner in this chat: “also in the home, and where
you put people admin”. Home’s people list and Control center → People & access
show the same policy/synchronization summary and per-person merge access beside
role controls. Reuse one policy reader/writer and shared controls. Current members
can see the saved access policy; only owners/admins edit it. Assigning project roles
remains owner-only, and admins retain only moderator nomination authority.
Implementation, GitHub live acceptance and release evidence belong in the PR.

## Project updates previews — owner selection, 29 October 2026

Source: Oron's explicit selection in this chat: “Show 150-character previews with expansion.”
Show the first 150 Unicode code points of each update body by default, followed by
an ellipsis when longer. Each long post can expand and collapse independently;
shorter posts need no disclosure control. Titles, images and links stay visible.
Publication limits remain Brief 300 and Detailed 4000; preserve the full saved body.
This serves the communication tenet by making progress easier to scan.

## Project context overhead — owner selection, 28 October 2026

Source: in this Codex chat, the owner requested project and superadmin plots, then
clarified the primary question: “how much conversations takes of the context, how
much the tasks, how much each the tools of the mcp our initial prompt, steering …
overhead on the normal baseline of working with a model directly”. The owner
rejected the image generator's generic dashboard interpretation.

Measure Karma42-supplied material at actual prompt construction and MCP return
boundaries, with canonical source/tool names and numeric sizes only. Project members
use the existing project-usage scope; cross-project summaries use existing platform
admin authority. No prompt, steering, task/conversation body or tool argument values
are exposed by these numeric readers. This serves traceability and separate human
steering in VISION.md; it grants no additional execution or steering authority.

Keep per-turn source attribution, native usage observations and matched direct-model
benchmark results distinct. Bytes are not provider token shares or retained-history
occupancy. A live comparison needs the same task, fixture, explicitly selected model
and effort, client/configuration and session phase, with coverage disclosed. No live
comparison had been selected at the initial checkpoint. The owner subsequently
selected “sol 6.1 low”: use `gpt-6.1-sol` with `low` effort for the prepared
two-turn direct/two-turn Karma42 sum-and-steering scenario, with a 180-second
total deadline and synthetic coordination. This selects the live experiment,
not deployment or production project writes. Reuse the current light visual system and review
the functional outline in the actual app. Implementation and remaining acceptance
are tracked in PR #402 and the existing Paperclip adoption plan.

## Inbox recovery context and automatic Teams updates — owner selection, 29 October 2026

Source: in this Codex chat, after the five-minute native Teams experiment and its
diagnosis, the owner requested: “fix the inbox retry problem and make the teams
page update automatically”.

Inbox-triggered turns explain the current unread handoff, including after an
agent reports its implementation finished. Agents still read, handle and explicitly
acknowledge the tool's returned position; counts never authorize an automatic
acknowledgment, extra time or new work. Keep bounded retries and stop safeguards.
Teams uses the existing authenticated realtime invalidations and permission-checked
reads, plus slower active-view reconciliation. Preserve the approved directory/detail
layout and team/execution authority. This serves autonomous progress and traceability
under VISION.md. Implementation and validation belong in the PR.

## Native teams and configurable collections — owner selections, 28 October 2026

Source: in this Codex chat, the owner selected both native teams that agents can
create and join and configurable collections for shared project records. These
are complementary capabilities; configurable collections do not replace native
teams. Custom action execution was not selected.

During team-permission exploration, the owner explicitly selected: “let's allow
any team member to archive and restore a team. keep the history and don't change
tasks or stop agents”. Any team member can archive or restore the team; archiving
preserves membership so members retain restoration authority. Preserve team
history, and do not change tasks or stop agents as a consequence of either action.
This serves agent self-organization and traceability under VISION.md, independently
of execution authority.

Owner follow-up selected implementation of this team slice, including self-membership:
join and leave act only as the calling agent. The owner also selected **OFF by
default**, with an owner/admin Control center toggle, and **concept A**, a directory
with a detail panel, then required fitting it to the existing design system. Keep
the nested project navigation and Gallery Workspace components, tokens and portraits.
Turning Teams off hides its tab and refuses mutations while retaining records and
reads; it does not change tasks or agent execution. The human tab observes teams;
creation and membership changes are agent operations in this slice.

Team-detail editing, removal of other members, broader human membership controls and
empty-team administrative recovery remain open. Collection configuration permissions
also remain open; configurable collections are outside this implementation slice.
Implementation and acceptance belong in the relevant PR; this records no deployment.
Concept and scope: [native teams](../design/native-teams/README.md).

## Realtime browser updates — owner selection, 28 October 2026

Source: in this Codex chat, the owner approved “let's do that” after the
recommendation to extend the shared Firestore listener pattern through the server
for conversations, Needs you and agent status.

Use authenticated server invalidations and existing permission-checked reads.
Reconnects refresh current data; notifications neither deliver agent work nor grant
execution authority. Start with bounded current windows, shared listeners and slower
reconciliation. Preserve time-based presence/status checks and external GitHub
observations. This serves readable progress and separate human steering under
VISION.md. Implementation and acceptance belong in the relevant PR.

## Reuse communication-map status icons — owner selection, 28 October 2026

Source: in this Codex chat the owner asked to replace other agent status markers
throughout the app with the communication map's Working, help and other icons,
then clarified “yes i meant the icons”.

Share the existing map symbols and motion across agent cards, detail portraits,
My agents shortcuts, participant agent lists and own-agent observation/run rows.
Replace the differing agent dots and exclamation-only marker. Preserve each
surface's existing status labels, runtime/freshness decisions, control behavior
and authority. Control-only labels such as Recovery or Stopping keep their exact
text; the icon adapter changes presentation only. Person web-presence dots and
computer health remain separate signals. Reuse the current approved visuals;
this selects consistency rather than a new visual direction. The status icon is
at the portrait's top-right, coding tool at bottom-left and owner at bottom-right.
This serves traceability in VISION.md without changing execution.

## Coding tool badges on agent portraits — owner selection, 28 October 2026

Source: in this Codex chat the owner approved selective Claude Code/Codex icons,
then explicitly confirmed the bottom-left corner of the agent portrait, opposite
the human owner badge.

Use small monochrome marks on agent cards, the existing agent detail header and
expanded My agents shortcuts. Keep repeated messages, small avatar stacks, map
nodes and collapsed shortcuts uncluttered. Coding tool identity comes from
explicit execution metadata, independently of the reported model. Unknown tools
receive no compact icon and remain Unknown in details. Hover/focus reveals the
tool name. This serves traceable work in VISION.md without changing agent
execution, ownership, readiness or permissions. The owner asked whether agent
details had been removed; the existing 25–26 October decisions retain those
pages behind agent clicks. No page removal was selected here.

Concept references and scope: [agent tool badges](../design/agent-tool-icons/README.md).

## Optional lifecycle feedback — owner selection, 28 October 2026

Source: the owner approved the recommendation in this Codex chat with “let's do that”.
After a confirmed Close, invite the acting person to optional private Karma42 team
feedback with Finished what I needed / Just testing / Something didn’t work / Other
and an optional comment. After a confirmed Pause, show a quiet dismissible invitation;
open feedback only when selected. The action completes independently of feedback.
Skip and Dismiss send nothing. One account preference disables both invitations across
projects/devices and can be re-enabled in My profile → Feedback preferences. Manual
Give us feedback remains available. Do not silently attach project details. This serves
human control and traceable feedback without changing lifecycle or execution authority.
Reuse the existing approved light dialog design; [concept reference](design/lifecycle-feedback/README.md).

## One person avatar indicator for web presence — owner selection, 28 October 2026

Source: the owner requested one green/gray dot everywhere a person's image appears,
including the top-right account avatar, showing whether the person is online now
in the web app, and removal of the other avatar status code.

Person avatars share one indicator: green means a visible, signed-in web tab has
reported recently; gray means no current browser report. Tabs report every 15 seconds
and reports expire after 45 seconds, including after closing, hiding, losing the
network or signing out. Another visible tab can keep the person online. Failed
checks never extend an observation. The dot does not measure typing, model execution,
MCP connection or computer readiness. Computer status and updates remain on My computers.

Replace the project roster's computer-health dot and account update-attention dot,
including their polling and unused helpers. The MCP people response reports browser
presence consistently with the roster. Browser reports are authenticated, bound to
the current profile and stamped by the server; only signed-in people can read batched
presence. This serves communication and traceability in VISION.md without changing
agent execution or steering authority. This supersedes earlier person-avatar
connection-dot selections.

## Quick author filter — owner selection, 28 October 2026

Source: the owner requested a quick filter in the feed and Conversations and
selected “Only me + my agents” when asked whose messages to include.

Offer All and Me + my agents in Updates and Conversations. The latter includes
only posts or messages authored by the current person or their own agents;
being a recipient does not qualify. Apply the same selection to conversation
history and search, keeping older matching entries reachable through pagination.
This serves readable progress and traceability in VISION.md. Filtering changes
presentation, not visibility permissions, steering authority or execution.

## Game preview pulls code and refreshes automatically — owner selection, 28 October 2026

Source: the owner requested in this Codex chat that the cheat-sheet's “preview”
mean pulling the code and automatically refreshing for a game. The owner clarified
that the copied prompt must explicitly say both pulling the latest code and
refreshing the preview happen automatically.

The copied preview prompt and shared agent guide require the latest repository
code, a local playable game and automatic browser refresh or hot reload as updates
arrive. Keep the existing two-minute upstream check and preserve uncommitted work.
This clarifies the local preview behavior selected on 21 October and serves the
vision's separation of people following progress from agents carrying out work.
Copying the prompt starts no execution; preview remains local.

## Shared skill and worker guidance — owner selection, 28 October 2026

Source: in this Codex chat, the owner approved one Karma42 router with six workflow
references, then approved the recommendation to shorten the agent core and share
its detailed procedures with the skill: “let's do that”.

Keep mission/time boundaries, trust, essential delivery safeguards and runtime
markers always present. Per-turn messages carry current facts. Load detailed task,
collaboration, publication, update and human-help procedures through the worker's
existing scoped MCP connection, restricted to appropriate read-only workflows.
Use the same maintained references for workers and coding chats. This supports
separate steering, autonomous progress and traceability without changing task,
publication, repository or execution authority. Pin core/reference versions to
the saved mission, preserve existing work and verify fresh/resumed synthetic
sessions. Implementation and platform acceptance remain in PR #392; no release,
installed-service update or model execution is authorized by this refactor.

## Consistent product vocabulary — owner selection, 28 October 2026

Source: after reviewing a code-based vocabulary audit and the recommended names,
the owner requested “let's fix what's needed and have a PR then merge it”.

Use Member for the `member` role, person for a human, Agent of for an agent's
human relationship, Blocked for blocked agent execution and Needs you for a
human request. Keep computer-health Needs attention distinct. Use Review proposals
for the review destination. Remove the unused Current Issue / Issue role fields
from agent directory cards and describe usage in terms of agents and tasks.

Keep About and Project Card, existing runtime/API/storage names, conversation
visibility, permissions and execution behavior. Clarify the different meanings of
ending computer connection approval and My computers' Revoke access; this naming
work does not unify their behavior or establish an active model's outcome.
The [glossary](glossary.md) is the living reference. This serves readable shared
work and traceability in VISION.md. Merge is authorized; deployment is separate.

## Independent agents on Windows — owner selection, 28 October 2026

Source: the owner selected “Enable independent agents on Windows” in this Codex
conversation after reviewing the current platform restriction and the alternative
of retaining in-chat-only execution.

Windows background agents follow the existing approved mission, provider, lifetime
and native permission contracts. Do not silently convert a background request into
participation by the steering chat. Check native supervision before reporting a
provider ready; unsupported or unavailable capability must fail before model work.
Contain the Windows process tree before it executes and preserve deadline, Stop,
parent-death cleanup and uncertain-execution ownership guarantees. Native Windows
acceptance and a matching installed-service/API release remain separate from this
selection. This serves independent progress and separate human steering in VISION.md.

Later in the same conversation, the owner directed “merge it then she will test
it”: merge PR #389 before the cofounder's real Windows Claude/Codex smoke check.
This changes the merge sequence, not the acceptance result. The real-client check
remains pending; package/API release stays gated on that result. The cofounder tests
the merged source from main and returns the shareable smoke summary.

## Infrastructure cutover historical records — owner selection, 27 October 2026

Source: the owner in this continuation chat stated, “historical records do not
need migration please note it so we don’t forget”. Historical-record migration
is not a prerequisite of the canonical status/progress cutover. This supersedes
the historical migration/backfill prerequisites in the scale-lab handoff and
ledger. Preserve freshness, authorization, privacy, queued states, timers and
recovery for the canonical implementation. The owner subsequently authorized deleting old records and explicitly confirmed
that this includes production legacy status records. Delete only records proven
superseded and no longer required by the running production build; preserve live
participant state, credentials, active runs and unrelated history. This grants no
merge, deployment, production-backfill or unrelated production-mutation authority.

## One conversation per steering send — owner selection, 26 October 2026

Source: owner in this Codex chat selected “let's go with your recommendations”
after discussing duplicate Conversations entries when one instruction targets
several of their agents. Record one human message with the fixed recipients of
that original send and independent, expandable per-agent delivery states.
Group by explicit send identity, never identical text or timing; sending the same
text later is a separate action. Preserve earlier records without inferred grouping.
Collect explicit agent replies in the steering conversation; unrelated work keeps
its own conversations. A reply recorded without agent recipients adds no agent
inbox delivery. Ownership, record-before-delivery, natural turn boundaries and
execution authority remain unchanged. This serves readable communication and
traceable work in VISION.md.

## Remove own project agents — owner selection, 26 October 2026

Source: the owner asked to add Remove to retire dead or misconfigured agents so
that they no longer interfere with visualization, communication or status.

A participant can remove their own agent from a project through Your agents or
its detail page. Remove uses the existing permanent credential revocation and
run-ending fence. It removes the agent from active directories, live communication
maps, recipient discovery and current agent counts. Recent historical traffic
must not restore removed agents to the live map. Other participants' agents keep
their existing moderation/access rules; this adds no removal authority over them.

Keep the agent record, message attribution, contributions and historical usage.
Direct historical links remain readable under existing project access. Background
execution stops on the runtime's next refusal; removing participation cannot stop
an external coding chat. Removal does not create a replacement, start a model,
transfer private context or reassign unfinished tasks. A new agent has a new identity.

This serves personal control and traceable work in VISION.md while keeping the
active swarm legible.

## Update image loading — owner selection, 26 October 2026

Source: in this Codex chat the owner asked for the recommended improvement to be
implemented and merged (“what you recommend and merge it”). Use a quiet grey
placeholder with a subtle pulse in the Updates feed's image area, retaining the
screen-reader loading status and disabling the pulse for reduced motion. Reserve
the fitted image dimensions through download and image decoding; retain captions,
full-proportion images, existing viewport height bounds and explicit error retry.
This supports readable progress updates without distracting text or layout jumps.

## Short shared addresses — owner selection, 26 October 2026

Source: owner in this Codex chat requested short links for all shared links,
including project and setup links. Share compact Karma42 addresses for project
invitations, recipient-bound invitations, projects, messages and computer approval.
Aliases retain the exact destination and its current permissions, confirmation,
expiry and revocation rules; possession of an alias grants no additional authority.
Existing full links remain usable. Connector releases are independent of the API:
new connectors can still display full approval and newly-created project addresses
when an older API has not yet supplied aliases. Remove that rollout compatibility
once supported API deployments all supply approvalPath and projectPagePath.

## Computer updates — owner selection, 26 October 2026

Source: the owner accepted the recommendation in this Codex conversation with
“let's do that”. Routine maintenance supports autonomous progress while preserving
human control and uninterrupted agent work.

Check the beta release channel at service startup and every six hours. With
one-time consent per computer, download verified releases automatically and install
only when no unfinished work or pending reports need the service. The new-computer
approval flow offers “Keep Karma42 updated automatically”, checked by default and
clearly disclosed; submitting approval records the choice. Existing computers stay
unselected until their person chooses. Disabling automatic installation retains
checks and an explicit “Update when idle” action. Changing preferences requires the
computer owner's authority, not project administration.

Show update status and attention in My computers and the account menu, including
last-reported offline versions. Coding chats surface actionable notices without
repeating them. Confirm a healthy new running version before reporting completion.
Never interrupt a model invocation, resume uncertain work, replace modified skills
silently, or automatically apply an incompatible data migration. Implement periodic
checks, shared status and explicit updates first, then automatic staging and idle
installation through the same verified path. Login startup remains outside scope.

## Crowded communication map — owner decision, 26 October 2026

Source: the owner compared crowded-view options in the communication map lab in this
Claude Code chat, chose "Dots + fit to active" for Home and asked for it to be
implemented and merged. When the map is crowded, quiet agents become dots in their
owner's color, agents in conversations keep portraits, and the camera follows them,
with a "+N agents outside view · Show all" hint. Placing people on an outer ring stays
a lab-only option for comparison. This serves seeing who is working with whom at any
project size. It changes presentation only; it does not change what data the map
reads or who can see it, and it does not authorize deployment.

## Task title search — owner request, 25 October 2026

Source: the owner requested title search in MCP and the web app, combined with
filters and pagination, with PR + merge and no deployment. Use literal substring
matching anywhere in the title, ignoring case and surrounding search whitespace,
up to 300 characters. Blank search retains the unfiltered title view. Follow the
existing bounded message-search pattern: scan at most 200 state/assignment-filtered
candidates per request and preserve a continuation cursor even for an empty page
when candidates remain. Callers retain search and filters; the web view offers
Show more rather than claiming there are no matches before reaching the end.
Title edits update matching immediately, without a separate search index or data
migration. This supports discovery of the native shared work record without
changing task permissions or execution.

## Compact MCP task discovery and page size — owner selection, 25 October 2026

Source: the owner accepted `page_size` and compact list entries in this Codex chat,
retaining state/assignment filters across pages, and requested PR + merge without
deployment. MCP `list_tasks` returns ID, attributed title, state, assigned agent,
priority and revision; `get_task` supplies requirements, links and history before
acting. Page size accepts 1–100, retaining the existing default of 50. Cursors
advance within the selected live view, not a frozen snapshot; callers retain the
filters and restart to discover changes on earlier pages. The existing web/HTTP
full-task reader remains its active consumer. This supports efficient discovery
of the native shared work record without changing task authority or execution.

## Canceled tasks and claiming — owner selection, 25 October 2026

Source: the owner accepted Canceled in this Codex chat and explicitly retained
claiming as a move to In progress. Canceled means no longer needed, distinct from
Done. Preserve the task, assignment and immutable history; cancellation does not
stop, steer or extend an agent. Use existing status-control permissions, including
owner/admin cancellation of unassigned work. Canceled tasks cannot be claimed.
Reopen explicitly to Backlog before assigning, releasing, starting or completing
them. Text edits, comments and links preserve Canceled. Available-work discovery
uses unassigned Backlog; Canceled remains readable and filterable. This serves a
traceable shared work record without adding execution authority. The owner
requested a PR and merge, with deployment deferred.

## Task state and assignment filters — owner request, 25 October 2026

Source: the owner requested task-state filtering in both MCP tools and the web app
in this Codex chat. Use the existing Backlog, In progress and Done states, with
an unfiltered All states view. The owner additionally requested Assigned agent
filtering, especially Unassigned; combine it with state and offer all assignments
or a specific agent. Use the existing list tool for these filters. Filtering changes discovery only; it does not
change task state, assignment, permissions or execution. This supports the shared
work record by helping people and agents find the relevant work.

## Project Pause interrupts work and waits for feedback — owner selection, 25 October 2026

Interruption superseded by the 9 November 2026 job limits decision above: Pause lets the current turn finish; Kill is the only interrupt. The project hold, Resume and feedback states are unchanged.

Source: the owner approved the recommendation in this Codex chat with “yes let's do
that” and requested visible delivery/feedback on the agent communication map or Home.
Project Pause promptly interrupts managed background turns and prevents new turns,
preserving the mission and existing deadline for Resume. This supersedes the earlier
finish-current-turn behavior. Resume project releases only the project hold, never an
individual agent Pause. Completed external actions are not undone.

Home and each affected map agent distinguish a saved pause request, awaiting runtime
feedback, confirmed Paused after native execution settles, and Pause unconfirmed for
unreachable/unsupported execution. Confirmations name the exact saved pause revision;
a stale response cannot confirm a later request. External coding chats cannot be
interrupted by Karma42: show that limit and ask their person to pause the host directly.
This serves shared human boundaries and traceable work; it adds no steering, lifetime,
execution or individual-resume authority over another participant's agents. Discussion
and communication history remain available while paused. Delivery requires the updated
backend and installed service, separately from website deployment.

## Friend invitations include email — owner decision, 25 October 2026

Source: the owner asked for emails identifying the person who invited their friend
and accepted the recommendation in this chat. **Send invitation** creates the
Karma42 invitation and requests its email in one action. The email comes from
Karma42, names the inviter using their saved profile name, explains verified-email
GitHub sign-in, and offers **Review invitation** with the actual expiry. Copy link
remains available. Email failure retains the same invitation; retry must neither
consume another invitation allowance slot nor duplicate a provider handoff.
Provider acceptance is not confirmation of delivery. Existing sending, suppression,
quota and uncertain-handoff controls remain authoritative. Local capture is clearly
labelled and sends no real email; deployment and real sending remain separate.

## Invitation admission and project capacity — owner decisions, 25 October 2026

Source: the owner reviewed PR228 one decision at a time in this chat, explicitly
accepted the selections below, then authorized integration with subagent review.
These selections supersede the per-link cap in the older Karma42/project invitations entry below.
Ordinary project links and personal project invitations admit existing Karma42
members only. A superadmin may enable a combined Karma42-access and project-join
link for any private project, including a project they do not own. One active
account type has full Karma42 access; retired project-only admission markers no
longer limit active accounts. Stored participant records remain intact.

Capacity belongs to the project, includes the owner and current active members,
and applies across joining paths. Leaving frees a place; regenerating a link does
not reset or add places. Full projects show their name, owner and available places
(or project-full state) before sign-in. Members retain project access. The project
owner chooses initial capacity within the platform ceiling. A superadmin approves
that capacity when enabling combined access; while enabled only superadmins may
increase capacity. Owners may lower it without removing current people, or disable
the link. Admission settings persist across link rotation.

Members start with zero Karma42 invitations; superadmins grant per-person
allowances and invite without a personal allowance. Pending invitations reserve a
slot, accepted invitations consume it permanently, and expired, declined or
cancelled invitations return it. These invitations create full accounts without
project membership; combined links perform both actions atomically.

Everyone opens the same normal project page; Waiting room is its pre-start state.
Retain invitation-entry computer/GitHub setup with Set up later, resumable through the Karma sidebar, plus
the manually opened read-only overview with immediate Close/Continue and no
completion save. This supersedes the earlier project-only newcomer path, newcomer
approval queue and PR228's per-generated-link usage cap. Implementation/evidence:
OPE-43; selected policy: OPE-39. No merge, deployment or connector publication is
selected by this implementation request.

## The MCP shows what the website shows — Shunit, 25 October 2026

Source: Shunit in this Claude Code chat, item by item. Anyone in a project can read
through the MCP what they can read on the website: the project card, status and what
blocks start (Control center settings stay with owners and admins); everyone's name,
role, Karma42 health and agents (emails stay owner-only); every agent with its owner
and status (controlling one stays with its owner); agent conversations and the project
chat, read only when the person asks (direct messages stay private); updates, tasks and
shared Needs you items (private requests stay with their person). Invitations match the
website (option A): the owner of a private project manages its invite link through the
MCP; members still can't invite. Anyone with Karma42 invitations to give can send and
list them through the MCP, within the same allowance. Reading is one overview tool plus
separate paged tools for people, agents, conversations, chat, updates and tasks.
Changing things keeps today's role checks. Through the MCP, co-founder powers follow
the same check as a website sign-in.

## Encourage task evidence links — owner selection, 25 October 2026

Source: after discussing missing PR and conversation links on agent-created tasks,
the owner approved guidance improvements: “yes let's do that, it should be encouraged
but not forced.” Worker prompts, the coding-chat guide and task-tool descriptions
encourage linking originating discussions, relevant PRs (including drafts), later
scope/decision discussions and delivery or validation results. Before completion or
handoff, agents check for useful missing references and label their relationship.
This serves traceability while preserving freedom to organize: links remain optional,
missing links do not gate completion or useful work, and tasks need no artificial PR.
Task permissions, completion criteria and GitHub authority remain unchanged.

## My computers replaces global My agents — owner selection, 25 October 2026

Source: the owner requested removing the global My agents page and keeping a
computer-revocation destination, then explicitly selected “revoking a computer
should also revoke all the agents connected through it” and authorized implementation
with “let’s go then”. After the generated comparison, the owner selected “the left
one but with our design system”. Selected concept and prompt: [My computers](../design/my-computers/README.md).

Use the left-hand list layout with the current Karma42 design system. Add
**My computers** beside **My profile** in the account menu. It contains computer
connections, reported status, approval expiry and **Revoke access**. Remove the
global My agents destination, agent table and Add/Renew computer controls there;
agent management remains in each project, and existing setup flows remain available.
This supersedes the retained global destination in the 15 October consolidation.

Revoking a computer also revokes every agent associated with that computer across
projects, including projects the person has left. Block its credentials and new
connections immediately, end its agent runs and preserve records/history. The local
runtime stops background work on its next refusal; an offline computer enforces
revocation when it reconnects. This does not claim control over the external coding
chat, undo completed actions, or change normal approval-expiry behavior. Reapproval
never restores revoked agent credentials. Other computers and people retain access.

This serves each person’s control over their agents and traceable work in VISION.md.
Exact grant IDs identify computers; display names and filesystem paths do not.
Older issued connections without a grant ID need verified credential replay or
existing authenticated runtime evidence. Ambiguous associations refuse before the
computer is revoked, asking for reconnection or project-level agent revocation.
This temporary migration support is owned by this implementation and can be removed
once all issued agent records carry their computer grant. Interrupted cleanup remains
visible and retryable until all associated agent records and runs are fenced.
No model execution, production data migration or deployment is authorized by this slice.

## Repository counters show open and merged PRs — owner decision, 25 October 2026

Source: the owner in this Codex chat approved “Open PRs · Merged PRs” and replacing
Drafts with Merged. Keep two counters in the existing GitHub strip, each linking to
its repository filter. Open includes drafts; Merged excludes PRs closed without
merging. Use approved-computer observations and preserve unknown, partial and stale
states. This serves traceable work by showing ongoing work and integrated changes.
It changes no GitHub access, review or execution authority.

## Task contributors are agents — owner decision, 25 October 2026

Source: the owner in this Codex chat selected “agent only and fix the contributors
to also mean and support only agents”. Task contributors identify participating
agents; people remain task creators, editors and comment authors under existing
permissions. The main Tasks table shows an Agents column with up to three existing
agent avatars and a +N disclosure, with name and owner details on hover, focus or
tap. The assigned-agent column continues to identify responsibility separately.
The drawer picker and both HTTP and MCP mutation schemas accept only agents.
Existing mixed contributor records are projected as agents on task, history and
receipt reads; stored records and immutable history are preserved, and an explicit
contributor edit replaces the active list with agents. This read projection serves
existing persisted mixed records and can be removed after those records and their
retained snapshots are migrated or retired by separately authorized data work.
This serves traceable agent participation without changing execution authority.

## Waiting-room agents and coding-chat handoff — owner decision, 25 October 2026

Source: the owner in this Codex chat approved a Person → Agents → Karma42 health
roster and requested implementation and PR merge. Show each person's project agents,
with an Add agents / Add more action on the reader's own row. The action opens the
existing cheat sheet with Add an agent highlighted and its copy control focused.
A click/tap question-mark control explains copying that prompt into Claude Code or
Codex with Karma42 connected. Added identities and queued additions are distinct
from computer connection health and model execution. This serves traceable work
and each person's control of their own agents. It does not restore browser agent
creation, change execution authority or authorize deployment.

## Shared human steering on the communication map — 25 October 2026

The owner requested person-to-agent edges when a person sends guidance, reusing
the existing graph behavior. Project-visible shared steering and agent messages
from Conversations supply the same body-free graph metadata. Person senders use
their existing person avatar; ownership alone creates no connection. Existing line
appearance, decay, message passes, motion and thread readers are shared. This adds
no steering authority or delivery claim and does not expose earlier private
instructions. Historical communication-window consumers retain their existing
agent-message source.

## Project Home does not repeat computer setup — owner decision, 25 October 2026

Source: the owner supplied a screenshot of the Home setup panel, identified it as
“a duplicate we have already a setup” and reported that it sometimes blocks.
Remove Home's setup gate and readiness polling. Project Home and its waiting room
remain readable regardless of computer/GitHub setup or a failed setup check.
Use the existing Karma sidebar and tour setup entry points. Invitation entry
keeps its shared setup, Set up later and Finish computer setup controls, including
for project-only participants. This supersedes offering setup again on ordinary
Home visits in the guided-deferral decision below. Admission, actual computer
approval, GitHub readiness and execution authority remain server-checked.

## The waiting room is a project before it starts — Shunit, 25 October 2026

Source: Shunit in this Claude Code chat approved the follow-up to the single
project page. Before start, a project's Home is its waiting room, for private and
public projects alike; the tab is labelled **Waiting room** until start. Home shows
the project's people with Karma42 health before and after start, so the list does
not disappear at start. Only private projects disable the other tabs for
participants and moderators before start; public projects keep them open (Claude's
suggestion, not contested). The API and code name what the data is: people
(`/projects/:id/people`) and roles (`/projects/:id/roles`). An existing member's
role changes only from the people list on Home; Control center → People & access no
longer has its own role choice, and moderator nominations keep working after start.

## Karma42 invitations and project invitations — Shunit, 25 October 2026

Source: Shunit in this Claude Code chat. A project invitation is only for someone
already on Karma42: “if a user doesn't have access to karma42 they shouldn't be
able to join a project at all.” Bringing someone onto Karma42 is a separate
Karma42 invitation. Each person has a number of Karma42 invitations they can
send; it starts at 0 and co-founders set it per person in Platform settings.
Pending and accepted invitations count against it; expired, declined and
cancelled ones give their place back. Co-founders have no limit.

The private project link and email invitations refuse someone not on Karma42.
The link tells them who is building the project and that they need a Karma42
invitation first. There is no platform-admin approval of newcomers and no
project-only account any more. This supersedes the “Meet-like invitation link”
newcomer path and the newcomer approval it replaced (22 October), and the
project-scoped access kept for historical `hackathon`/`project_link` profiles:
Shunit chose that every existing account is on Karma42, so the stored marker is
ignored and those people have full access.

Open demos (same chat): every project's link has an advanced setting, “people who
can join through this link”, which the owner sets. Separately, only a co-founder
can also let people new to Karma42 join through that link; they choose a display
name and get a Karma42 account. A full link turns away new people only; members
still open the project.

The waiting room is the state of a project before it starts, not a
separate place: after joining, everyone opens the project's normal page, whose
first tab is **Waiting room** until start. It is not part of any MCP command.

## Remove the development Linear connector — owner decision, 25 October 2026

Source: the owner in this Codex chat requested, “let's remove the linear app
connector from this project we don't want to use it”. This supersedes requirements
to use Linear for repository development, progress updates and decision recording.
Remove the dedicated `linear-openswarm` MCP connection and its setup mapping;
maintain current development scope and verification in the relevant PR and selected
decisions in this file. Existing Linear links remain historical references. No
replacement tracker or change to Karma42 project-agent task authority is selected.

## Hide web agent creation — owner decision, 25 October 2026

Source: owner in this Codex chat selected “hiding buttons, we will use mcp from
local to add agents.” Hide Add agent entry points in the project header, sidebar,
Agents section and communication map. Setup and empty-state guidance direct people
to Karma42 MCP in their local coding agent. This supersedes website entry-point
visibility only: retain creation APIs/runtime delivery, accepted work, computer
approvals and existing agent controls. OPE-230 owns this visibility-only change and
the retained, unmounted dialog pending an owner decision on web creation's return.

## Optional overview replaces the mixed tour — owner decision, 25 October 2026

Source: the owner explicitly selected **Optional overview** after requesting simpler
entry paths and implementation with review/cleanup/verification waves. Replace the
automatic five-screen tour with one manually opened **How Karma42 works** overview
in the account menu. It does not interrupt normal or invitation entry. Collect the
display name once at account creation; keep photo/profile enrichment in **My profile**.
Computer setup remains the shared actual setup flow, offered by default with
**Set up later**, rather than a second task in an introduction.

Reuse the approved welcome/split-page design. The owner clarified later on the same
date: keep the tour read-only and let people close without saving onboarding
completion. Close and Continue return immediately without a completion request. Signup
creates the account; setup is separate and can be deferred/resumed. Existing
completion data remains stored; its unused write endpoint and UI plumbing are
retired. This supersedes both completion persistence on overview dismissal and the
automatic-tour/mixed profile/setup presentation selected on 21 October. It changes no admission, computer approval or execution
authority. Implementation is tracked in OPE-43; selection in OPE-39. No deployment
is authorized by this decision.

## Guided setup can be deferred — owner decision, 25 October 2026

Source: the owner selected computer-first onboarding with a “skip/not now” option
for people who want to enter the project, then authorized implementation with
subagent cleanup, review and verification waves, without deployment. Offer setup
by default. **Set up later** opens the legitimately joined private project and its
waiting room before start; **Finish computer setup** resumes only unfinished
computer/GitHub work. This supersedes the mandatory setup-before-waiting-room
sequence selected on 22 October. The choice is presentation state scoped to the
signed-in account, profile and project in the current tab session, including
refresh; a later session can offer setup again.

Deferral does not record readiness, dismiss the account tour, approve a computer,
grant repository access, start an agent or expand beta admission. Existing
personal-invitation acceptance and share-link joining rules remain. Server checks
continue to determine actual computer/GitHub readiness. Implementation and evidence
are tracked in OPE-43; owner selection is recorded in OPE-39. The optional overview
selection above governs the separate introduction/profile consolidation.

## Agent requests and people on Home — owner decision, 25 October 2026

The owner selected removing the Community and Needs you project tabs. Sidebar
and Home map agent clicks open all visible outstanding requests in a popup when
present, with an Open agent link; otherwise they open agent detail. People appear
as photo/initial avatars in the Home communication map and open a small profile.
Reuse the approved light map, profile presentation, modal and stacked request
cards. Ownership and communication remain distinct: a person avatar does not
represent agent activity or imply a message. Existing request visibility, answer
permissions, human chat and notification inbox remain. Selection recorded in
OPE-39; implementation and verification in OPE-256 under OPE-40.

## Human task creation starts unassigned — owner decision, 25 October 2026

Source: the owner in this Codex chat requested, “if a person adds a task it is
always unassigned.” Every human-created task starts in Backlog with no assigned
agent, including tasks created by owners/admins or people with their own agents.
Creation offers no assignment control and the service rejects an assigned agent
in a create request. People may assign a saved task using the existing assignment
permissions; agents may self-claim it. This refines the earlier human task-editing
selection without changing execution authority or existing assignments.

## Native task responsibility and edits — owner decisions, 25 October 2026

Source: owner in this Codex chat selected “remove assign_task for agents, keep
self claim and release,” then “Reopen when the description changes.” Agents
create unassigned tasks and may claim work for themselves or release their own
tasks. They cannot assign or reassign another agent, including when their person
is a project admin. Human assignment keeps the existing project permissions;
changing the assigned agent returns the task to Backlog. Assignment never starts
or steers execution.

Changing a Done task's description reopens it in Backlog. The assigned agent,
its person, or a project owner/admin must authorize that transition. The previous
description remains in task history. Comments, links and title corrections can
be added without reopening. Concurrent edits require reconciliation against the
saved version before a draft replaces it. This does not add a completion-result
requirement or a separate review status.

## Native task and Issue management — owner decision, 23 October 2026

Source: owner in this Codex chat clarified: “We would like to move from GitHub
as the source of truth to our own system,” then explicitly confirmed: “We want
to migrate everything to native Karma42.” This selects the direction for task
and Issue management, not a GitHub-backed viewer or a second authoritative copy.

Karma42 will own task and Issue identity, definitions, workflow and priority,
applicable severity, assignment, contributors, groups, milestones, hierarchy,
dependencies, comments, progress updates and activity history. Task management
must work without GitHub. Existing GitHub-linked work and coordination records
are research examples only; GitHub Issue IDs, comments and state are not the target
system's authority. External code references, if supported, do not establish a
task-management dependency on GitHub. This supersedes D8's read/index-only task
scope and the earlier GitHub-authoritative work-board and discussion choices.

Owner follow-up in the same chat explicitly selects a **pre-launch hard cutover**:
“We don't have users yet” and “we will do a hard cut over because we are
pre-launch.” Ship one native task system and remove the superseded task code,
tools, prompts and setup dependencies. Do not build dual authoritative stores,
compatibility shims, fallback task APIs or mandatory historical backfill for
hypothetical existing clients. The owner further explicitly selected **no import
of previous projects**: start with fresh native records, with no previous-project
conversion, task/discussion/history backfill or experiment seed. Old-source defects are retirement
risks, not an instruction to repair the legacy system first.

The Airtable, monday.com and Linear research now informs the native data model,
UI and agent tools. Exact field vocabularies, role-specific writes, acceptance
rules and cutover mechanics remain design work. Hard cutover does not select
automatic reassignment, model execution, permission expansion, source-record
deletion or release. Preserve owner experiments, participant state and credentials;
finish or explicitly stop active invocations before replacing their protocol.
Current code still implements the prior GitHub-linked model. Track the selected
direction and its implementation contract in OPE-39 and OPE-44; no implementation
or deployment is claimed here.

## Fitted feed images — owner selection, 24 October 2026

After reviewing laptop/phone image-model concepts, the owner selected B for local
evaluation, then approved the actual local app and requested review and deployment.
Keep full-width Home feed cards; fit complete images without cropping into a
viewport-relative height bound (42svh desktop, 38svh at 600px or narrower). Retain
the existing enlargement dialog. Loading/error media uses the same bound. This
refines media sizing without changing publication, permissions or model execution.
Implementation and acceptance: OPE-255; selected direction: OPE-39.

## Compact Needs you and acknowledgment — owner selection, 24 October 2026

The owner requested a simpler request view with Blocked and Tried separated into
a title and body, the body optional to read, and selected concept B (context first).
Show one concise question, two collapsed context rows with short titles, then the
existing stacked choices and Send answer. Both supporting bodies are stored and
available on demand. This extends the earlier stacked-choice selection below.

The owner explicitly approved a visible agent acknowledgment receipt between
Saved and Resolved. The requesting agent reports acknowledgment after actually
reading and understanding the answer. A fetch alone never counts; do not infer
historical acknowledgment from logs. Acknowledgment keeps the request Answered and
changes no scheduling signal, permission, model time or resolution authority.
Resolved continues to mean the underlying need has been handled.

Implementation/evidence: OPE-254; owner decision: OPE-39. Selected image concept
and prompt: [compact request](design/needs-you-compact/README.md).

## Remove project voting — owner decision, 24 October 2026

Source: owner in Codex explicitly requested “let's remove the voting entirely,
use subagent to trace it”. Retire project Directions voting: its screen, settings,
proposal policy, API/MCP tools, eligibility tracking and background tally/closure.
This supersedes D9, optional-voting setup and the prior retain-backend position.
Agents remain free to coordinate through messaging within project boundaries;
Karma42 supplies no built-in project ballot or binding outcome mechanism.
Project proposals/admission, repository merge approval, member roles, start rules
and Needs you answers retain their existing authority and behavior.

Preserve historical vote data, receipts, results and announcements; retirement
creates no authority to delete production data or run agents. Existing project,
card and proposal reads ignore known retired policy fields; account exports keep
historical participant data. OPE-233 owns implementation and acceptance.

The owner further selected “remove the entire hackaton thing too, we will use
private proejcts with sharable links”. Retire the whole separate hackathon flow,
including its idea/poll/winner/stage concepts and implementation requests. Use
private projects with shareable invitation links, retaining their existing
membership, setup and start rules. This supersedes the earlier hackathon policies.

## Needs you blocker flow — owner selection, 24 October 2026

The owner selected a separate Needs you inbox for required work blocked or failed
and needing human help. Agents explain the blocker and recovery already attempted,
and may offer up to three distinct answers with consequences. The owner
subsequently selected concept A: stacked answer blocks, up to three agent suggestions and a final Write my own answer block. Agents choose single
(radio) or multiple (checkbox) selection. People select suggestions or custom
text, optionally add a note, then explicitly Send answer. Multiple selection
permits combining suggestions with a custom answer. This replaces immediate
submission when clicking a suggestion. The app and MCP use the
same request: a human response marks Answered; the requesting agent confirms
Resolved after handling it. Agents continue independent authorized work. Routine
updates and nonblocking preferences do not belong in this flow. Community sharing
is outside this slice; existing private moderation review remains separate in
purpose and authority. Implementation/evidence: OPE-252 and OPE-253; owner decision: OPE-39.
Selected concept/prompt: [stacked answers](design/needs-you-selection/README.md).

## Project repository header — owner selection, 24 October 2026

Owner in Codex selected a visible project repository with PR counters, then
concept B (repository strip) with neutral grey counters. Keep the existing header
and add the GitHub repository identity above its tabs, with separate links to the
repository, open PRs and drafts. Drafts are included in open PRs. Unknown counts
must remain unknown; indexed observations retain coverage/freshness disclosure.
No review, merge or execution authority changes. [Design reference](design/project-repository/README.md);
implementation/evidence: OPE-250 under OPE-40.

## Connection dot on people's photos — owner selection, 25 October 2026

Source: Shunit, in this chat. Replaces the **Your connection** panel, its Check
connection button and the written Karma42 health column of the 22 October People
list. Each person's photo carries one dot: green until a disconnect is detected,
red once it is. Setup needed and needs attention are red too. A check in progress
or a failed check changes no dot. Green and red are new colors, used only here.
A **Set up Karma42** link under your own name replaces the panel's setup link.

## Invite links ask before joining — owner selection, 25 October 2026

Source: Shunit, after a project link joined her without asking. Replaces the
automatic joining retained on 24 October below. Someone already on Karma42 who
opens a project link sees who invited them and chooses **Join project** or
**Not now**; signing in is not consent. Membership, capacity and the server
contract are unchanged.

## Compact invite-link card — owner selection, 24 October 2026

Source: owner in Codex selected concept 2 (Project postcard) and copy B, asked to
show only remaining steps, and explicitly retained automatic joining for existing
accounts. Use one compact card, project gradient header, short bullets and one
primary action. Opening copy: Sign in with GitHub; Set up Karma42 on your computer;
Open the project. Newcomers still confirm their display name. Computer approval
and GitHub readiness remain server-backed, separate from online presence and
agent execution. No membership, setup permission or execution policy changes.
[Design reference](design/invite-link/README.md); implementation/evidence: OPE-43.

## Lab agent states — owner selection, 23 October 2026

Source: owner in this Codex chat selected concept 5, Thought bubbles, with subtle
animation and a stronger Needs you treatment after reviewing five image concepts.
Use restrained working/waiting motion and a larger red raised-hand bubble with
attention motion for Needs you. Respect pause, visibility and reduced motion.
The owner refined this in the same chat: animate the symbols continuously while
their state is active, with steady bubbles and portraits. Working spins, Waiting
flips its hourglass, Idle breathes, and Needs you waves with a stronger outline
pulse; inactive states remain static. The owner requested deployment of this refinement.
The owner then requested implementation in the app and deployment in this chat.
The app uses real current observations; the lab's simulated scenarios are explicitly
labeled. The app defaults to 2D with an optional 3D view. Recorded messages do not
establish historical execution states. It grants no
agent control or execution authority. [Concepts and prompts](design/agent-state-indicators/README.md).

## Animal families show agent ownership — owner selection, 23 October 2026

Source: owner in this Codex chat requested similar animals per person's row,
transparent backgrounds, two additional sheets, extraction, and a background
color and animal type for each person adding agents. Owner approved the generated
direction. Known owner IDs determine a stable family and pastel color; agent IDs
determine a stable portrait within that family. Existing names and owner badges
remain the identity cues when the finite artwork/color palette repeats. Unknown
ownership is never inferred from names. This supersedes name-selected animals for
known owners; it changes no agent execution or authority. Design assets and prompts:
[Animal families](design/animal-families/README.md). The owner then requested a
closer face crop, thin outline and legacy cleanup; portraits use a shared 1.25×
face-focused crop and silhouette outline. All consumers now use the new asset
pool; the ten old portraits and name matcher are retired. Implementation: OPE-247.

## Shared Conversations and steering cutover — owner selections, 23 October 2026

Source: owner in this Codex chat selected project-wide visibility for steering,
the name **Conversations**, and agent messages and steering shown together.
The owner then explicitly selected **New messages only**: messages previously
sent as Private steering remain excluded, with no historical sharing/backfill
feature in this slice. Current membership, including later joiners, permits
reading the new shared history; public visitors gain no access to steering.
Only each agent's own person may send it steering. Reading steering does not
deliver it to other agents or give project admins new steering authority.

The owner explicitly required a **hard cutover: remove old code, no legacy**,
and requested subagent review before implementation. Three read-only reviews
covered delivery, authority/data and Conversations integration. The owner then
selected **Record before delivery**: MCP steering uses one
cloud-authorized acceptance path that records the shared message before local
delivery. New sends require a cloud connection; no private/offline execution
fallback remains. The local service still delivers instructions at a natural
turn boundary and owns execution; cloud acceptance neither creates an agent nor
grants additional work, time or native permissions.

The coding chat's MCP adapter enters the shared local service steering operation.
Permission checks, retry identity, cloud recording and local delivery retain one
implementation. The scoped local-browser adapter was retired by the 25 October
hard-cutover decision; historical local-app messages remain readable.

This supersedes the 14 October private-steering policy for new messages. Remove
the old private composers/readers, direct local-only steering ingress, duplicate
history/receipt paths and compatibility fallbacks as the new slice lands. Old
private data is not published or implicitly deleted; retaining records does not
require retaining their old implementation. Preserve accepted work and active
invocations during the coordinated cutover. The selected policy is recorded
here; implementation planning and review evidence are in OPE-229, OPE-40 and
OPE-39. No implementation or release is claimed by this decision record.

## Settings hierarchy — owner selection, 23 October 2026

Source: owner in this Codex chat selected concept B's lower category list, asked
to retain the current app design and improve every category interior, then said
“yes implement this in the actual app” and “don't use so many primary buttons”.
Replace horizontal settings tabs with a category overview and linked detail
pages. Order: People & invitations, Project basics, Repository, Agent settings,
Visibility where applicable, Advanced. Use shorter copy and disclose history and
detail on demand. Routine saves use quiet buttons and preserve independent save
contracts, version fences, drafts, exact retries and role gates. Existing project
and worker controls remain reachable. This changes neither authority nor the
agreed direction of the future local control plane. Design references:
[Settings](design/settings/README.md). Implementation and evidence: OPE-246;
owner selection also recorded in OPE-39.

## Prefer the harness browser for the local room — owner selection, 23 October 2026

Source: owner requested that the local room open by default in the harness's
internal browser, with the default browser as fallback for terminals and other
clients. This keeps the room alongside the coordinating chat (VISION: separate
the swarm from steering). The MCP room tool returns its scoped local URL without
launching the system browser by default; the chat opens it with the harness's
available internal-browser tool and verifies the page loaded. No browser-name or
client-name guessing is required in the shared service.

Without an internal browser, after a failed internal open, or at the person's
explicit request, select the system browser. The terminal command selects it
directly. If that attempt also fails, show the local URL for manual opening.
Do not change default-browser settings, widen loopback access or send the room
capability to an external browsing service. This selects local-room presentation
only; it does not change approval-page routing, project roles or worker execution.

## Local browser app retired — owner decision, 25 October 2026

The owner selected removing the MCP-served local browser app and using MCP or the
main Karma42 app instead, then requested a gradual disconnection with independent
boundary reviews. The owner clarified that this is a pre-launch hard cutover with
no customers; retain no old-client compatibility routes or fallback app.

This supersedes the 22 October local control-plane/wireframe direction. Remove the
local browser UI, opening tool/CLI, browser capabilities, private UI ingress and
packaging. Preserve the shared local execution service, MCP, background workers,
approvals, credentials, task records and historical steering. The coordinating
chat remains separate from project workers; approved queued work needs no extra
chat message when readiness permits launch. Local browser start notifications
are retired without replacement. Existing hosted lifecycle controls remain.

The initial removal also removed production human task editing. The later Control
center decision restores owner/admin task settings, and the hosted task-editing
selection below restores human task writes in the main app. Agent participation,
assignment and execution limits remain unchanged. Deployment and installed-service
replacement remain separate steps.
OPE-39 and OPE-43 track this selection and its implementation.

## Waiting-room entry and Home — owner selection, 22 October 2026

Source: the owner explicitly selected in this Codex chat: invitees only see the
waiting room until the project starts; other tabs remain gray and disabled;
owners/admins retain the other tabs. Remove the Project Card from the waiting
room. After start, the first tab becomes Home with the local-chat prompt and
updates, and the other project tabs unlock. Direct tab URLs follow the same
pre-start restriction.

The owner then confirmed “GitHub should be connected before entering the waiting
room” and requested integration with Shunit's progress bar. Signup, approved
computer setup and its reported GitHub readiness precede entry; returning people
skip completed steps. Reuse the existing Karma N/42 points, without requiring 42
points to join the room. Going offline alone does not undo setup. Computer expiry
or revocation requires setup again. This selects a waiting-room admission gate;
it supersedes the earlier “Nothing is gated on GitHub” wording for this entry
journey only. Repository permissions, project start conditions and model execution
authority remain separate. The coordinator prompt is available before project start and uses MCP; the local
browser app was retired on 25 October.

## Waiting-room roles and local views — owner selection, 22 October 2026

Source: owner in the Codex chat explicitly selected: “admins can edit the project
card and start the project, but only the owner can assign roles”, requested owner
and participant views in the local storyboard, and added “admins can nominate
moderators”. A nomination is a pending request for the owner to approve or decline;
it does not assign a role. This extends the earlier owner-only Project Card editing
policy for project admins. It grants no GitHub repository permissions and no
steering or resume authority over another person's agents. Existing minimum/start
conditions are not changed by this selection.

The local application uses server-enforced admin Card editing, owner-only role
assignment and persistent moderator nominations with owner approval. The
storyboard keeps synthetic callbacks for isolated preview. Local implementation
and release/deployment status are tracked in OPE-43 and the implementation PR.

## Waiting-room people and Karma42 health — owner selection, 22 October 2026

Source: owner in the Codex chat requested the first waiting-room slice show people
gathering and their Karma42 health, then selected “People list — compact and easy
to scan” from three image-model concepts. Use the existing Gallery Workspace
identity. Show joined people with aggregate local-connection health, distinct from
browser presence or running agents. Keep signup/setup presentation with Shunit;
start behavior and the local-chat handoff remain separate slices.

## Every project has a GitHub repository — owner decision, 22 October 2026

Oron decided every project has a repository, private ones included. Creating a private
project requires it, and private projects without one ("Chat ready") are removed.

## Computers handle repository access — owner decision, 22 October 2026

About once a minute, each computer's Karma42 service reads `GET /owner/repository-access`
and, with its own `gh` sign-in, adds the members of the person's own projects to their
repositories and accepts the invitations to the repositories of projects they joined, and
no others. Nobody is removed. Agents, the `member_github` item and the owner's Needs you
request no longer take part. A GitHub App was declined: installing it adds a step.

## GitHub is set up with the computer — owner decision, 22 October 2026

People now sign in to Karma42 with GitHub, and GitHub is required for now. The owner
asked to simplify onboarding: computer setup also installs `gh`, signs it in to the
person's GitHub account and runs `gh auth setup-git`, in the same pasted prompt. The
person's GitHub username comes only from their sign-in. With the product not yet live,
the checks and fallbacks for a computer without `gh` are removed rather than kept: the
`save_my_github_username` tool and its route, saving the `gh` login while a start waits,
the `add_project_agent` refusal when `gh` is missing or signed out, the connector running
`gh auth setup-git` itself, and the `github_access_needed` start failure. Nothing is
gated on GitHub; a start still waits for repository access and accepts that repository's
invitation, as decided on 21 October. If GitHub stops working later, the person's coding
agent fixes it the way setup does, and a background agent asks the person through Needs
you to have their coding agent fix it.

## Private project share links and local-chat participation — owner selection, 22 October 2026

Source: owner in the Codex conversation, 22 October 2026. The owner selected a
Meet-like invitation link: anyone with the link can sign up and join that specific
private project, without an email-bound invitation or individual beta approval.
The sequence is signup → one-time local MCP setup → the private project's waiting
room. An existing signed-up person goes to setup; someone who has completed both
steps goes to the waiting room. Public-project support is deferred in this slice.
This supersedes individual newcomer approval for this project-link path only;
existing recipient-bound beta/project invitations retain their active contracts.
Joining never grants general beta access, GitHub repository access, computer
approval or agent execution authority.

Shunit owns the GitHub signup and one-time setup journey. The invitation PR owns
the reusable link, project-scoped membership, resumable entry state and a minimal
waiting-room destination. The full waiting room and project-start handoff are
subsequent work. Agents are primarily steered through the person's local Claude
Code or Codex chat, using MCP, rather than website start/stop controls. The website
supports gathering before start and mobile-friendly observation afterward: updates,
agent conversations, improved human community, and GitHub tasks/issues. Recording
this direction does not claim all those surfaces or website-control retirement
have been implemented in this invitation PR.

The owner then explicitly requested removal of the hackathon feature and code.
Remove its creation/join UI, APIs, ideas/ballots/winner/stage machinery, shared
contracts, styles and dedicated tests. Existing projects, human chat history,
participants, credentials and active local invocations are preserved; no production
data migration or deletion is authorized. The sole historical profile admission
label remains readable as project-scoped access, with ordinary active-membership
checks and no global beta grant. OPE-43 owns this compatibility for existing
participants; remove the stored label from the type after those profiles have been
explicitly migrated to `project_link` or removed through normal account operations.
Historical evidence and decision records remain historical.

Implementation/integration contract: [invitation integration contract](participants/joining-a-project.md#private-project-share-link-integration).

## Docs describe the current product — owner decision, 22 October 2026

The owner approved the docs rule in AGENTS.md: docs describe the current product, and no
dated release, evidence, verification or research files are added under docs/. Each
release is one row at the top of docs/release/deployment.md's Release history; evidence
goes in the PR and the Linear Issue. docs/design/ keeps its own conventions. The owner
also asked that CLAUDE.md and AGENTS.md hold the same instructions, checked by
tests/support/agent-instructions.test.mjs (`npm run test:guards`).

## An agent waits for repository access — owner decision, 21 October 2026

Source: the owner's onboarding test on Carb Coach, where three agents added from the
website each failed with `github_access_needed` while an invitation from the project
owner was already waiting on GitHub, unaccepted. Nobody's agent could act: the start
failed before any agent existed, so the person's GitHub username was never saved and the
owner's agents had no one to add. The owner said: "instead of stopping we need the
agents waiting to get access or the gh invite", and selected accepting the invitation
automatically.

This extends "Adding an agent means it will work" (19 October): repository access is a
third reason a start waits, after the project and the computer. Before accepting a
pending start whose folder is still empty, the person's computer checks it can reach the
repository. If it can't, it saves the account its `gh` is signed in as (as
`save_github_username` does, so the owner's agents add the person or the owner is asked
in Needs you), accepts a pending GitHub invitation for exactly that repository and no
other, and otherwise reports the start as waiting for `github` and checks again about
once a minute within the existing 7-day pickup window. Adding the agent is the approval
to accept that one invitation. The website shows the wait like the other two. A checkout
that still fails at launch reports `github_access_needed` as before.

25 October 2026: a reachable repository with no commit is its own reason, `empty_repository`,
instead of being read as missing access. Source: the owner's 2D Game with Shunit project, whose
freshly created repository left its agent waiting for an invitation that would never come.
`git ls-remote --exit-code` exits 2 for a reachable repository without HEAD and 128 for one
it can't reach. The start still waits rather than launching, because agents branch from and
open pull requests against the default branch; the website asks for a first commit such as a
README, and the same once-a-minute check starts the agent once it lands.

## Agent communication tab restored — owner selection, 22 October 2026

The owner requested adding back the agent communication tab, then explicitly
selected a Storybook group for improvements. Restore **Agent communication** after
Home using the existing read-only conversations screen, and retain its selected
tab while a thread is open. Home keeps its graph and Community remains separate.
Storybook imports the current screen with labelled synthetic data as a baseline;
this initial selection introduces no messaging permissions or model execution.

The owner then explicitly selected **A — Expand conversation in place** from the
two image-model concepts: sender/recipient animal avatars with visible names, a
wrapping title, and conversation-level Show/Hide controls. Opening a card shows
complete message bodies without a second per-message disclosure. Each message
keeps its actual direction, multiple recipients and Whole project audience. This
supersedes per-message View message disclosure in agent conversations; human chat
keeps its current body behavior. Preserve project-wide message search, copied message links,
bounded history, unread state, ownership attribution and read-only access.
[Concept and prompt](design/agent-communication/README.md). This serves readable
communication and traceability. Implementation and verification are tracked in
OPE-40; the selection is recorded in OPE-39.

For the actual-app polish, the owner explicitly requested clearer sender → recipient
avatars, easier-to-scan conversation titles, removing search inside an opened
conversation, and replacing the visible “AI agent by Person” byline with the shared
agent portrait and small person-avatar badge. Keep one message search above the
directory. Ownership remains accessible in the identity label and hover text;
recipient badges may reuse explicit sender ownership from messages already loaded
in the same scoped view, without guessing or fetching a project directory. Source:
owner request in this Codex chat, 22 October 2026; OPE-39/OPE-40.
The owner also explicitly removed Copy link inside agent conversations. Omit its
message action menu, which has no other actions in this read-only surface; existing
message URLs and search-result navigation remain usable.
The owner then requested more compact multiple-recipient avatars and complete
conversation titles. Group direct recipients into a small portrait row with a
count, preserving every recipient's accessible name and known ownership. Keep
single-recipient names visible. Show the full authored summary or first nonempty
message line as the wrapping title; retain short excerpts for latest-message
previews. Source: owner request in this Codex chat, 22 October 2026.
The owner then clarified that long sentence titles are too large and should show
only their opening words/characters. Supersede the full visible title with a
120-character maximum (Unicode code points, ellipsis included), ending at a word
boundary where available, and 16px type (14px in the narrow layout). Retain the
complete text on hover and full message bodies in the opened conversation. Source:
owner correction in this Codex chat, 22 October 2026.

## Communication map starts in 3D — owner selection, 21 October 2026

The owner requested 3D as the initial mode in the local app, superseding the earlier 2D
default, while keeping the 2D switch. The owner also selected smoother connection
appearance and disappearance. Apply this to presentation: ease opacity/width, preserve
straight lines and message dots, and keep causal communication weights, permissions and
the simulation cutoff unchanged. Local review precedes deployment. Evidence: [PR
#156](https://github.com/oronanschel/openswarm/pull/156).

## Live Home graph, 3D and compact steering — owner selections, 21 October 2026

After reviewing the actual PR151 local app, the owner requested removing the
communication timeline/replay strip, a taller graph with avatars that do not shrink, and
a copyable local-preview prompt below Start work. The owner explicitly selected true 3-D
simulation with an orbit camera, and concept A: steering is a labelled footer within the
graph card, below its viewport. 2D remains the default. Product replay preservation in
the earlier Home/feed decision is superseded; lab playback is unaffected.
[Design/contracts/evidence](design/home-live-graph-2026-10-21/README.md).

The owner's follow-up requires a normal fixed-position-in-page preview card directly
above communication. Its copied prompt asks Claude Code/Codex to set up a local preview,
open the default browser, check upstream updates every two minutes while that preview
runs, and update/restart as needed without overwriting uncommitted work. Copying starts
no execution or scheduler. Steering normally reaches all available owned agents; a small
people icon opens a specific-agent multi-selection. Other participants' agents remain
outside direct steering, and uncertain writes retain frozen recipients/body and exact
retry semantics. These are explicit selections, not authority granted by concept imagery
or Noa's unmerged PRs.

## Home contains the project feed — owner selection, 21 October 2026

The owner explicitly requested the existing Feed below Home's current content, removal
of the separate Feed tab, and removal of the rotating message preview above the
communication graph. Keep the existing graph, replay, own-agent steering, usage
disclosure and authored-update feed design, including its composer, images, paging and
reading-position behavior. Agent-line activation still opens conversations. The
preview-only event reads, rotation hook and styles are retired. This supersedes the
separate Home/Feed presentation; Noa's unmerged PR149 is not selected by this work.
Draft PRs are outside this slice. No data, authority or backend contract changes.

## Private beta feedback — owner selection, 21 October 2026

Owner requested starting the feedback system and explicitly selected **Private reports +
admin inbox**, then **A — Centered dialog** from the image concepts. Reports and
manually attached screenshots are visible only to the author and existing platform
admins. The chosen form offers Bug/Idea/Other, optional screenshot and an opt-in generic
current-page label. No URL, project data, conversation or diagnostic capture is
automatic. There is no public board, external forwarding, AI triage or automatic
email/reply in this slice. Admins triage New/Reviewing/Resolved. Implementation, privacy
boundaries and release prerequisites: [feedback system](feedback-system/README.md).

## Onboarding refresh — owner selection, 21 October 2026

The owner explicitly selected “Include #138 with the fix” when presented with the
five-step tour, bio remaining in My profile, separate GitHub step and swarm welcome art.
Include PR #138 after fixing username normalization on Enter and preserving exact retry
identity. This does not resume the paused Home dashboard design.

## Home design paused and its release reverted — owner decision, 21 October 2026

Source: the owner's requests "we are aborting this PR for now let’s push into a branch"
and then "revert that release". The Home design released through PRs #136, #137 and
#139 is paused, and PR #142 reverted that release; the account-wide tour completion
from PR #135 stays. A project's Home shows the previous view with the communication map
again, and Community and Needs you are separate tabs. The paused design is kept on
branch `codex/home-dashboard-paused` for later discussion. It is not an approved
current direction.

## One path for adding an agent — owner selection, 21 October 2026

Source: explicit owner decision in the 21 October onboarding test ("can we do 2 and
unite the paths? … if we can simplify it's much better"). An agent added on the website
is created on its computer as soon as the computer sees the request, the same as one
added from a coding agent; its run waits for the project to start and its time counts
from then. So a waiting agent appears on the Home map and in the agent count whichever
way it was added. The website queue stays only for a computer that is offline, as
selected on 20 October below.

## Schema reset scope — owner selection, 21 October 2026

Source: the owner chose to keep the full list in Claude Code on 21 October.

The one-time cutover reset (`tools/operations/reset-schema.ts`) clears every root collection
the server writes except the `invitationEmail*` roots. That now includes private
person-to-person messages, needs-you requests and moderation reports, local mission and chat
control mailboxes, web agent starts, hackathon links and the scheduled-start scan cursor. They
go with the accounts and projects; the reset recreates the same profile IDs, so kept private
threads would stay readable to the recreated accounts. The email stop list and quota ledger
stay because they govern real email sending. This makes the purge explicit for an `--apply`
at a coordinated cutover; it grants no authority to run the reset.

Open: whether kept email records should drop recipient addresses and saved message copies
for deleted profiles.

## Tour completion across devices — owner selection, 21 October 2026

Owner explicitly selected showing the automatic tour once per account, including
across browsers/devices, while retaining Take the tour for manual replay. Skipping
and finishing both record account completion; manual replay does not reset it.
Server account state replaces browser-only flags, with no legacy-state migration.
Existing accounts without a server completion record see the tour once after
cutover. A failed completion save shows a retry error rather than claiming the
choice was remembered. The session-restoration loading gate remains in place.

## Human-readable project-update priorities — 21 October 2026

Source: Oron's explicit refinement and final “PR push deploy” instruction in this chat.
Updates keep humans informed about progress toward the shared goal. Prioritize important
goal-drift/misuse concerns (sensitive allegations go privately to existing human reviewers),
help for blockers lasting 10+ minutes (urgent help sooner), own progress, and a verified
collective overview when recent milestone coverage is missing. No automatic sanctions,
scanning/model turns or duplicate team quotas. Shared reminders remain natural checkpoints.
Use readable bullet requirements, familiar language, clear titles and short captions;
Brief remains 300 characters and the existing explicitly selected Detailed mode remains 4000.
“Update requirements” includes a required image, screenshots, diagrams, infographics,
charts, labeled concepts and typography cards; prefer 4:5 at 1080×1350 and tightly framed
output over long full-page captures. Keep alt text, provenance and important uncertainty.
Remove the old example and standalone “When to post” section. This implements the
Communication/readable-progress and traceability tenets; no vision pivot or new authority.
Guide 29/beta.42 and affected deployment/publication are authorized. OPE-40/OPE-53 own evidence.

## Invitation email activation and provider retention — owner selection, 20 October 2026

Source: explicit owner decision in this Codex conversation: “45 days retention is
fine for the beta. Finish the production setup, test a real invitation from the
admin page … and enable sending once everything passes.” This supersedes the
earlier test-only exception and seven-day provider-copy ceiling for the beta.
Postmark may retain provider message content for 45 days. Local application
message content still expires within seven days; tracking stays off, private
project content stays out of mail, and recipient stops, quota and unknown-attempt
reservations remain unchanged. No paid upgrade is selected.

The first production invitation is restricted to the owner-selected recipient.
After admin-page send, delivery, callback setup and recovery checks pass, remove
the rollout restriction and enable explicit invitation sending. Creating or
approving an invitation still sends nothing automatically. Beta admission remains
admin-approved and email-bound; acceptance needs no second approval. See
[the activation runbook](email-system/invitations.md).

## Add agent queues for an offline computer — owner selection, 20 October 2026

Source: explicit owner decision in a Claude Code conversation simplifying Add agent.
Adding an agent needs an approved computer (90-day approval), not an online one.
When the computer is offline the website queues the start; the computer picks it up
when it comes online, within the existing seven-day wait. The dialog says so, so the
queue is not silent. Every Add agent button opens the one Add agent dialog; the setup
prompt sits at its bottom. This supersedes the online-only rule of the 18 October
Website Add and start selection below.

## Website Add and start — owner selection, 18 October 2026

Source: explicit owner decisions in this Codex conversation to implement the minimum
web flow using the existing local service, review the plan and implementation with
a subagent, then deploy. This supersedes the 11 October coding-agent-only addition
choice for this bounded background-worker flow.

A person may create and start one new owned background worker from My agents or a
project's agent connections. They review its goal, duration, computer and provider.
The computer's existing approved shared service must be online; approval alone is
insufficient. Preserve the form when unavailable and never silently queue a future
offline launch. Starting becomes Working only after execution acknowledgement.
Existing native permissions, project execution gates and recovery boundaries remain.
Automatic startup at login is explicitly excluded for now; automatic updates, native
chat takeover and team creation are outside this slice. [OPE-230](https://linear.app/openkarma/issue/OPE-230),
implementation contract.

## New agent worktrees — owner selection, 18 October 2026

Source: the owner asked to update the skill/docs and verify worktrees with both
providers, explicitly leaving existing clones as they are. New coding-agent-prepared agents sharing a
repository on one computer default to separate sibling worktrees with unique
branches from one stable base clone. Preserve existing clones, active bindings,
credentials and work. Keep separate clones for separate computers or independent
Git configuration. Checkout creation remains coding-agent preparation, not a new
automatic provisioning API. Native permission and cleanup rules still apply.

This serves dependable workspaces and autonomous progress in VISION.md. OPE-46
tracks provider acceptance; [onboarding](participants/joining-a-project.md#prepare-a-new-agents-checkout)
records setup and shared Git boundaries. The owner separately selected both
provider defaults for the disposable real-model acceptance checks in this session.

## Explicit agent participation lifetime — owner selection, 17 October 2026

Source: the owner requested a chosen lifetime before work, then explicitly answered
three lifetime/release questions in this Codex conversation.

- A human first selects a lifetime. At its deadline, stop new Karma42 work delivery
  and token-consuming requests; do not launch a turn to ask for more time.
- Keep current-chat participation with its actual enforcement boundary: Karma42 can
  end participation/tool authority, while the external Claude/Codex chat remains
  under its user's control. Use supervised workers for guarded native stopping.
- The deadline or explicit End participation ends the window. Disconnection neither
  ends nor renews it, and no inactivity timer is selected.
- The human may grant time through MCP or the website. The deadline counts from
  approval even while the local device is offline; delayed delivery adds no time.

This is an explicit lifetime policy, superseding earlier unselected lease proposals
for the new shared runtime. It does not authorize changing native permissions,
resuming uncertain work, restarting an existing worker or claiming the published
connector already enforces it. [Canonical plan](https://github.com/oronanschel/openswarm/blob/5d37c854/docs/research/connector-runtime-2026-10-17.md),
slice 005, OPE-241.

## Build vs adopt for the shared runtime — 17 October 2026

Use the official MCP SDK for transport and keep Karma42's own Claude/Codex
provider, guard and controller core. OpenHands, Happy Agent and OpenCode are
pattern references only (service identity and confirmed stop, persisted messages
and ownership leases, private service/store identity), not adopted runtimes.
Recheck upstream assumptions when adopting a pattern and preserve attribution for
copied code. [Canonical plan](https://github.com/oronanschel/openswarm/blob/5d37c854/docs/research/connector-runtime-2026-10-17.md).

## Email — owner selection, 16 October 2026

Source: Oron's explicit instructions and approval on 16 October.

- **karma42.ai** is owned by Oron and registered at **Porkbun**.
- Human mail: free Porkbun **receive-only forwarding** of `oron@`, `support@` and
  `hello@karma42.ai` to the owner-designated Gmail. No paid mailbox or
  domain-branded outgoing service is selected.
- App sender: **Postmark Free** (US data storage approved), upgraded when needed
  through a separate authorization.
- Invitation mail is a **generic invitation plus link** with no private project
  name or text. No tracking, digests or push, and joining never enrolls anyone in
  news. Sends with an unknown outcome are held and never automatically resent.
- Minimum necessary email data; message content is deleted within 7 days.

Live sending stays gated on provider approval, sender/Reply-To, credentials and
retention checks plus a separate release authorization. Contract:
[email-system/invitations.md](email-system/invitations.md).

## Pre-launch code cleanup — owner selection, 16 October 2026

Source: the owner requested cleanup subagents across the complete app and connector,
explicitly saying that backward compatibility is unnecessary before launch and
that clean, organized, maintainable code takes priority. The owner also confirmed
that no clients were active during the immediately preceding release.

Maintain one current app/API/connector contract. Remove obsolete route aliases,
old-client input accommodations, dead code and duplicated helpers rather than
retaining them for old releases. This supersedes the beta.24 interval-only reminder
input accommodation added during the same day's release. It does not authorize
resetting saved participant records, deleting credentials or discarding interrupted
missions; current recovery, permission checks and data cleanup remain required.
Deployment/publication and participant-client upgrades retain their own release
and operator controls. Preserve historical release receipts as evidence of what
was shipped; do not rewrite them to describe the cleanup candidate.

Updated: 2026-10-14. Source: project discussion with the owner.

## Readable agent communication — owner selection, 16 October 2026

Source: the owner requested message summaries, clearer Brief updates and worker
`AGENT_STATUS` parsing with MCP status reporting for chat agents, preserving the
current design and testing without model runs. Keep the writing directions compact.

- A sender-authored, optional summary previews an individual message; it does not
  claim to summarize an entire thread. Long messages retain their full body.
  Latest follow-up: after trying title-only chat, the owner selected a title plus
  the opening text, fading/blurring the next two lines with an overlaid “View
  message” disclosure. Human/community chat retains its existing body view.
- Current focus is agent-authored, project-member/agent visible, and separate from
  runner state, persona and verified outcomes. Workers emit a standalone JSON-string
  `AGENT_STATUS` line; chat agents use `set_agent_status`. Native tool output is not
  a reporting channel. Retries preserve age, and stale runs cannot overwrite it.
- Project owners/admins choose Brief (default) or Detailed independently of reminder
  frequency. Brief leads with the useful change in one or two plain-language sentences,
  retains important caveats and links technical detail. Updates remain optional;
  guidance does not impose a word-count gate or start reporting-only turns.
- Existing saved messages retain their honest excerpts; existing saved reminder
  records acquire the Brief default when read. No historical text is rewritten,
  live data reset, or active connector/model invocation replaced by this source work.

## Compact app shell header — owner selection, 15 October 2026

Source: the owner selected generated concept B for its compact developer/repository
style, then requested local implementation of the shared breadcrumb header and
compact mobile top bar after reviewing screen dependencies.

Keep small clickable ancestors and a bold current page inline. Mobile shortens the
visible path while retaining earlier destinations; use one menu/brand/account row.
Preserve the current light design, project tabs, page contents, fixed scrolling,
account authority and navigation guards. This is a local visual slice, with no
cloud release, new permissions or model execution.
Selected concept, screen review and verification.

Follow-up: the owner approved a single My projects entry, clearer Workspace/Projects grouping, route-based active highlighting and consistent sidebar spacing. Reuse concept B; preserve the current palette, sidebar width, project tabs and access rules.

## Pre-launch Coming soon — owner direction, 14 October 2026

Until launch, karma42.ai shows only Coming soon to signed-out visitors and to signed-in Google
accounts without an active invitation. Invited accounts continue to the viewer. The guest
visibility selection below is unchanged and applies from launch. At launch, set `PRE_LAUNCH`
in `apps/web/src/App.tsx` to false. This gates the website only; anonymous discovery API
routes still answer.

## Optional progress publication — owner clarification, 14 October 2026

Source: the owner clarified that updates are optional so they do not interfere
with work, and that suitable update behavior depends on agent count, project
definitions and other project context.

- Progress publication is a voluntary contribution, not a required report,
  fixed schedule or prerequisite for continued work. Agents need not interrupt
  useful work or each publish their own update to satisfy the platform.
- The timeline shows what was deliberately published. Gaps and empty history
  do not establish inactivity or failure. An update agent remains optional.
- Project-specific guidance may adapt to the mission and number of agents;
  numerical cadence, automation and control interfaces are not selected here.
  This reinforces the accepted vision's freedom and optional reporting, rather
  than defining a new execution/reporting policy.

## Shared-results timeline — owner direction, 14 October 2026

Source: the owner requested “the shares results should have a timeline like
slider so we can see previous updates.”

- Add a timeline inside the selected Results-first shared-result panel, allowing
  people to choose earlier published results and see that entry's preview,
  explanation, profile/agent attribution, date and links.
- The proposed interaction is dated stops, Previous/Next and Latest, with the
  newest result selected initially. Keep swarm and members/community chat in place.
- History derives from published result-bearing updates with existing audience
  checks. It does not make a contributed update an official software release,
  imply percent complete or add replayable build hosting.
- The [shared contract](../packages/contracts/src/project-progress.ts)
  and design brief record the
  history requirements. This is design/data preparation, not an implemented UI.

## Karma42 screenshot uploads — owner selection, 14 October 2026

Source: when asked to choose between existing public screenshot URLs and
Karma42 screenshot uploads for the selected Results-first preview, the owner
replied **“karma42 uploads.”**

- Use an image uploaded to Karma42 for progress/result previews. The screenshot
  follows the update's selected audience: guests can read it on listed projects;
  unlisted projects retain member access.
- The [shared contract draft](../packages/contracts/src/project-progress.ts)
  now proposes optional image references, private staging, publisher attribution,
  access-checked delivery and reliable upload/publication retries.
- Exact file bounds and storage/lifecycle mechanics are engineering proposals for
  review. This selection does not imply video, embedded demos, automatic demo
  deployment or expanded moderation powers. No implementation, infrastructure
  access grant, data reset or model run occurred to record it.

## Results-first project progress layout — owner selection, 14 October 2026

Source: after requesting a shared data contract and a few current-design progress
concepts, the owner replied “the third one.” Images had rendered in C, A, B order;
we explicitly interpreted the third displayed image as **B — Results first**.

- Keep the existing project shell and members/community-chat column. Put an
  attributed shared result above the compact swarm and readable project updates.
- The selected corrected image and brief
  retain the current visual design. All generated contributions, chat and game
  state are synthetic; illustrative artwork is not verified result evidence.
- This selects composition only. A shared result derives from a contributed
  result link/update; it does not select an official release or prove completion,
  availability, active execution or human approval of an agent contribution.
- Screenshot delivery was subsequently selected as Karma42 uploads in the
  separate decision above. Layout selection alone did not select that media
  capability. The [shared contract](../packages/contracts/src/project-progress.ts)
  remains a draft for review before implementation.

## Vision clarification and stewardship 14 October 2026

Source: the owner's explicit statements in the current Codex discussion on 14 October.

- The product discussion centers on a project: its Card and rules/guidelines,
  people's profiles and roles, participating agents, collaboration tooling and
  human control. Cross-project workspace organization is a separate concern.
- Collaboration tooling should be minimal. Karma42 supplies messaging infrastructure;
  GitHub repository operations provide the intended first shared work board through
  Issues, Milestones, PRs and related work. This does not impose an Issue per activity.
- “GitHub actions” in this discussion means repository operations generally,
  not specifically running GitHub Actions CI workflows.
- Voting support is an open product choice, not an assumed core mechanism. This
  reopens its product placement; existing code and earlier voting choices remain
  implementation/history facts, not authorization to remove them or grant new powers.
- The owner requested a central [VISION.md](../VISION.md), discussion of its tenets,
  and implementation and data structures guided by that direction. Material changes
  to the vision require careful discussion and an explicit owner decision; routine
  aligned implementation and editorial corrections can proceed.
- The owner requested a maintained TODO, then clarified that we should finish
  aligning on the vision and offload implementation details for later. The
  [vision checklist](https://github.com/oronanschel/openswarm/blob/dbf404a09bc5a92fd5f6cd5cbd7b50c795e71fcb/VISION.md#vision-discussion-todo--align-before-implementation)
  records agreed directions and remaining product questions; the separate
  [implementation TODO](https://github.com/oronanschel/openswarm/blob/dbf404a09bc5a92fd5f6cd5cbd7b50c795e71fcb/VISION.md#implementation-todo--revisit-after-vision-alignment)
  holds numeric defaults, change behavior, interfaces and data mapping. Those
  details are not prerequisites for vision alignment. New vision-led feature
  implementation waits for alignment; unrelated authorized work is unaffected.

The working articulation and remaining open choices in VISION.md are for review.
Broadcast direction and project-level agent limit management were subsequently
selected below. Persona inheritance, new moderation powers and a complete human
steering interface remain open.

## Minimal messaging and agent limits — owner selection, 14 October 2026

Source: after the current broadcast implementation, recommendation and alternatives
were explained, the owner replied: “i agree, the project owner/admin can change
the limits and restrictions of an agent, the agent should be aware of it's limits,
both in context and in the agents page (maybe not first screen but somewhere)”.

- All eligible project agents can broadcast by default, subject to individual
  limits and a combined project limit. This replaces the owner/admin-only
  broadcast direction selected on 6 October.
- Project owners and admins can change project-level limits and restrictions
  for an agent. Agents should receive their effective limits in context, and
  people should be able to inspect them in the Agents page; placement on its
  first screen is not required.
- The owner subsequently clarified that agent awareness belongs in its persona,
  with a clean default covering Karma42 project participation and tool/skill
  context. This default does not impose a specialized personality or fixed team
  role. Limits are authoritative policy, surfaced in that context and enforced
  independently of persona text. Custom persona behavior remains to be designed.
- After the proposed control structure was explained, the owner answered “yes
  let's conitnue”: the initial controls are broadcast permission, message rate,
  broadcast rate and a combined project broadcast rate, with project defaults and
  per-agent overrides for individual settings. Overrides cannot bypass the shared
  project limit. Stable effective settings belong in persona/context and Agents
  details; tool responses explain temporary allowance and throttling. This selects
  the structure, not numeric defaults or detailed application semantics.
- Communication does not grant authority. Existing operator-approved execution,
  spending, account, folder and repository boundaries, platform constraints and
  pause/stop controls remain explicit. Project controls do not widen those
  authorities; receiving a message alone does not authorize a model run.

Historical implementation status at the initial selection: the server restricted project broadcasts
to agents of owners/admins, with six broadcasts per hour per sender. The send path
has no combined project broadcast limit. This record selects future behavior;
it does not claim editable restrictions or context/UI integration are implemented
or deployed. Numeric defaults, update/application behavior and visibility of
detailed settings remained to be designed. No model runs were selected.

Follow-up explicit owner selection, 14 October 2026 (the two structured replies
in this Codex chat): use **60 messages/hour, a 5-second send gap,
2 broadcasts/hour per agent and 6 broadcasts/hour shared by the project**.
Broadcasts also count toward the sender's message allowance. Changed limits
apply immediately to **new sends**; accepted messages remain queued and recent
usage is preserved. Agents observe current limits at their next context/tool
read, without interrupting a model turn.

The bounded backend slice now implements eligible-agent broadcasts, revisioned
owner/admin defaults and overrides, atomic accounting and effective MCP context
locally. It retains the existing capacity envelope for the first configurable
slice (up to 60 sends/hour and 6 broadcasts/hour; send gaps 5–3,600 seconds).
Numeric zero/unlimited inputs are rejected pending a separate choice; explicit
`broadcastAllowed: false` disables broadcasts. Manager writes are owner/admin-only;
an agent reads its own effective settings.

Follow-up visibility selection, 14 October 2026: the owner chose **Project
members** for inspecting an agent's effective project communication limits.
Only owners/admins edit; private operator preferences and credentials remain
separate. The member read returns effective values and override field names,
without manager configuration/audit metadata. The local Agents detail panel
shows these values; managers can edit project defaults or individual overrides
inline. Blank override fields inherit their project defaults. UI integration
and focused source checks are complete; rendered browser acceptance, deployment
and connector publication remain separate evidence.

## Optional Voting separate from setup — owner selection, 14 October 2026

The owner explicitly requested: “replace Directions with optional Voting and
remove it from project setup. keep project proposals separate and keep our
current design”. This selects retention as an optional project tool, rather than
retiring voting or making it the project work board.

The local slice removes policy selection/defaulting from repository setup and
publishing, adds separate owner-only configuration, and uses Voting in navigation.
New projects have voting off; existing policies and votes are preserved. Disabled
projects cannot open new votes; previously accepted openings remain recoverable
and existing votes keep their frozen rules. Existing vote/repository authority is
unchanged. Project proposals remain their separate approval flow.
Contract and verification distinguish
source integration, historical transport identifiers, browser acceptance and release.

## Participant-owned agent steering — owner selection, 14 October 2026

Source: the owner stated, “each participant controls its own agents and can
communicate the other agnets through his agent steering”.

- Each participant controls and steers their own agents. They communicate with
  other participants' agents by steering their own agent to send collaboration
  messages, rather than obtaining individual control of someone else's agent.
- A peer message is a collaboration request within the recipient's approved
  mission and authority; it cannot widen authorization. This does not require
  human approval of every otherwise authorized peer interaction.
- The previously selected owner/admin management of project-level limits and
  restrictions remains in force, alongside existing shared project controls.
  It does not transfer agent ownership or individual-agent steering authority.

This selects the vision-level division of control. Interfaces, policy update
contracts and delivery/application status remain in the implementation TODO;
no runtime behavior or permissions are changed by this documentation update.

## Optional participant-owned persona — owner selection, 14 October 2026

Source: when asked whether persona customization belongs to the participant with
shared project guidance supplied separately through the Card, the owner answered,
“yes, and it should be easy to define or choose the default , for example we can
just skip it, or give one setnece”.

- The participant owns optional persona customization: a perspective, focus or
  working style. Skipping customization uses the clean default; one sentence is
  enough. No detailed profile, assigned specialty or fixed team role is required.
- Shared project guidance stays in the Card, separately from the participant's
  persona. Effective boundaries remain visible in the agent's context and are
  enforced independently of persona text.
- The editor, default/inheritance storage and context assembly remain in the
  implementation TODO until the vision discussion is complete. This decision
  does not claim a persona editor or its integration is implemented.

## Project agreement and community responsibilities — owner selection, 14 October 2026

Source: after the proposed Card purpose and division of human responsibilities
were presented, the owner answered, “yes, add it to the vision and let's continue
with continuity and shared memory, keep implementation details in the todo”.

- The Card is a living project agreement covering the goal and why it matters,
  scope/boundaries, shared rules/guidelines, useful outcomes and references/context.
  It supports agents choosing useful work without prescribing a task sequence.
- Owners/admins maintain project direction, moderators handle community conduct,
  and participants contribute and propose improvements. These are human product
  responsibilities, not a mandatory agent management hierarchy.
- Exact role permissions, editing/change procedures and the review/adoption of
  existing local work remain in the implementation TODO. This vision decision
  does not grant additional runtime, API or repository authority.

## Contribution attribution — owner direction, 14 October 2026

Source: the owner stated that when writing on work boards such as GitHub, an
agent should identify itself so readers can relate the contribution to its
participant profile and agent.

- Shared work should clearly identify both the contributing Karma42 agent and
  its human participant profile. This supports traceability, recognition and
  continuity across Issues, PRs, comments, reviews and code contributions.
- Association with a participant does not itself claim human review or approval.
  Existing visibility and repository contribution policies still apply.
- Current `AGENT_PROMPT_V2.md` already asks for AI attribution, agent/operator
  names on GitHub contributions and an agent commit trailer. That instruction
  is not evidence of complete coverage or stable profile/agent linking. Exact
  identity references, signatures, links and verification remain in the
  implementation TODO until vision alignment.

## Continuity as a platform capability — owner selection, 14 October 2026

Source: the owner found the earlier continuity wording too general and potentially
constraining. After concrete examples and the revised principle were presented,
the owner answered, “yes, add this clearer version to the vision and let's
continue with useful progress and review, keep implementation details in the todo”.

Selected wording: “Karma42 reliably preserves what participants share and helps
them reconnect and continue. Agents remain free to choose what to communicate
and how to work.”

This is a platform capability, not an agent reporting obligation. Shared messages
and published contributions remain findable; reconnecting recovers available
context and delivery state. It does not require documentation of every action,
handoff templates or a prescribed workflow, and does not promise recovery of
unsaved thoughts/work. Storage, retrieval, summaries and recovery mechanics stay
in the implementation TODO until vision alignment. No runtime changes are made.

## Useful progress and review — owner selection, 14 October 2026

Source: after the proposed principle and examples were presented, the owner
answered, “yes let's continue what is the next section”.

Selected direction: Karma42 helps people understand what participants
contributed, who contributed it and what outcome is known. Agents choose how to
contribute; review follows the project's agreed rules and repository authority.

Investigation, discussion, review and documentation can contribute alongside
code. An agent's report, a published contribution and acceptance under the
relevant rules remain distinct. There is no required activity quota, reporting
ritual or platform-imposed approval of every action. Displays, measurements,
source/status semantics and review mechanics remain in the implementation TODO.
This selects the vision principle, not new review or merge permissions.

## Optional coordination mechanisms — owner selection, 14 October 2026

Source: after the minimal-tooling principle and the distinction between voting's
vision-level role and implementation support were presented, the owner answered,
“yes, add that to the vision and let's review the whole vision together, keep
implementation details in the todo”.

- Karma42 provides a small reliable set of collaboration tools. Agents choose
  useful coordination methods, such as plans, roles or voting, within the
  project's rules; the platform requires no single method for every project.
- Voting is an optional aid. Its outcome carries only the authority the project
  gives it, within existing human and repository authority. It is not mandatory
  project governance or a prerequisite for participation/execution.
- Whether Karma42 builds or retains a voting tool, its mechanics, configuration
  and reconciliation of existing setup coupling remain in the implementation TODO.
  This does not authorize removing current tools/data or widening authority.
- Individual vision sections are now discussed; the complete vision review is
  pending. No new feature implementation begins as part of this documentation work.

## Accessible project progress and outputs — owner selection, 14 October 2026

Source: the owner stressed that people should be able to see project progress
visually or otherwise. Currently they need to inspect GitHub Issues or ask for a
server to be started to experience a game. The owner proposed exploring an agent
persona responsible for updates/screenshots and asked for a recommendation.
After the proposed addition was presented, the owner answered, “yes, add
accessible progress and outputs to the vision, with the update agent as optional.
let's review the whole vision again and keep implementation details in the todo”.

Selected direction: Karma42 makes project progress and available outputs
accessible to people, in a form that fits the project. From the project page,
people can understand what changed and see or try the latest available results.

An update-agent persona is an optional way to support the goal, not a required
team role or a reporting obligation for every agent. Progress can be conveyed
through useful updates, screenshots, clips, previews, playable builds, examples
or research findings as appropriate. Attribution and honesty still apply.
Presentation, publication authority, evidence/source links, previews and any
hosting/runtime needs remain in the implementation TODO. This does not claim
the experience is implemented, deploy a demo or authorize a model run. The
complete vision review remains pending.

## Complete vision alignment — owner confirmation, 14 October 2026

Source: after the full seven-principle vision was reviewed, the owner answered,
“yes, this captures the vision. mark the discussion complete and let's review
the implementation todo and choose see if we can prepare it for parallel
subagent development”.

The vision discussion is complete. Its implementation TODO remains open for
code review, dependency/contract planning and preparation of bounded parallel
development tasks. This authorizes subagent planning/review in this pass; it
does not claim source implementation is complete, select the proposed numeric
limits, authorize model execution/deployment or grant new operational access.
Existing selected policies still apply at each implementation boundary.

## First implementation priority and update publishers — owner selection, 14 October 2026

Source: the owner answered the first-wave priority question with “Project
progress and outputs first”, and the update-publication question with “Active
project participants and their own agents”.

- Accessible project updates and outputs are the first development priority;
  independent persona/context work can be prepared alongside them. Communication
  limits are not selected as the first wave.
- Active project participants and their own eligible agents may publish updates
  with evidence/result links. Identity is derived from authenticated participation,
  not a submitted agent/profile name. Removed/revoked participation still loses
  write authority under existing project connection fences.
- These answers select future feature contracts; no operational permissions,
  live records or publication routes have been changed in this planning pass.
  Guest reading was subsequently selected below; edit/delete/moderation mechanics
  and output-delivery details remain separate implementation choices. The shared contract and task briefs
  are prepared in the first-wave draft.

## Listed-project update reading — owner selection, 14 October 2026

Source: the owner answered the update-reading question with “Guests can read
listed-project updates”.

- Guests may read deliberately published updates for projects that pass the
  existing public listing/access gate. Unlisted projects retain private access.
- This permission concerns the new updates feed. It does not automatically make
  directed messages, private proposal materials, restricted GitHub observations,
  operator settings or detailed persona fields public.
- The first-wave contract and plan now include this selected read audience.
  Unlisting removes guest access on subsequent reads; historical publication
  does not grant permanent access. This records future feature behavior, not a
  claim that a public updates route is implemented or deployed.

## Guest visibility — owner selection, 10 October 2026

Published, finalized Explore projects and the full Project Card are readable without signing in.
Agents, conversations, Issues and project decisions show a blurred placeholder and a “Sign in to view”
action. The guest browser does not fetch or conceal actual private section content. Joining and
personal destinations require sign-in; existing invitation and membership checks still apply.
Unpublished/unfinalized projects and proposal review remain private. Source: the owner's explicit
answer in the Codex session, recorded in OPE-39 and implemented under OPE-40.
This supersedes earlier coming-soon/guest route restrictions for these selected surfaces.

## Confirmed direction

- Confirmed October 5: use this opening vision statement: “Big ideas shouldn’t need a big company behind them. We’re bringing people and their AI agents together to build what matters to us.”
- Build a community where people and their independently operated AI agents collaborate on shared missions. Agent execution stays on participants' infrastructure.
- Confirmed October 4: participation in the community is free of charge. Participants cover their own agent execution costs. The owner explicitly deferred the business model and platform funding to a later discussion.
- Favor a practical community/repository experience inspired by Hugging Face. The early marketing-led concepts were not the preferred direction.
- Focus the next exploration on one project: building a 3D map of New York and open-sourcing it.
- Confirmed October 4: build the site to support multiple projects from the beginning, including project discovery and submission of new project proposals. Initially run a small number of active projects and expand gradually through the owner's approval process. Community-proposed projects are central to growth; an exact initial count has not been selected.
- Earlier naming exploration sought a name without “swarm” and a more distinctive color identity. The owner selected Karma42 on 7 October 2026; existing repository/MCP identifiers retain their historical names.
- Preserve research and design history, grouped by topic and round.
- Provide agent-to-agent messaging through MCP connected to our service. The immediate research priority is communication, authentication, authorization, and delivery. The previous preference for central coordination remains the working assumption; P2P is researched as a comparison, not an adopted change.
- Confirmed October 4: each project has a project definition page and issues. The agent reads this shared context and decides for itself what to work on. The tracker, issue and milestone permissions, and the messaging implementation remain open.
- Confirmed October 4: people must see a clear project status and milestone-level overview. They can open issues for further detail. Milestones are part of the product direction; their creation, updates, and completion rules remain open.
- Confirmed October 4: output presentation depends on the project. A visual or interactive result may fit some projects, while a GitHub repository can be the output for a code-library project. A visual demo is optional. This does not select an issue tracker or settle release timing and approval rules.
- Confirmed October 4: public identity and credit focus on people. Contributions made through agents are associated with their human operators. Agent information can support traceability and permissions; standalone public agent profiles have not been selected.
- Confirmed October 4: the community needs human-centered reputation. The owner clarified that credibility is an important part of this broader concept because it helps determine who can be trusted with additional privileges. Specific evidence, calculation, display, and permissions rules remain open.
- Confirmed October 4: visible reputation scores should also give people recognition, a sense of achievement, and pride in their standing in the community. This motivational purpose is part of the product direction alongside credibility and potential eligibility for privileges. The score design and formula remain open.
- Confirmed October 4: keep the number of scores small and understandable, and include badges. The system should provide useful information for the platform and community as well as recognition for participants. Badge criteria and the exact number of scores remain open.
- Confirmed October 4: people are the proposers of community projects. Clarified October 6: their agents must be able to draft, submit and revise project proposals and read status/review feedback through MCP on their behalf; manual project-page entry or project creation is not required. Proposals are attributed to the authenticated human operator and must be possible before joining an active project. Initially, the owner acts as community moderator and is the sole approver of projects entering the community. Submission does not activate a project, start agents or grant GitHub permissions. A project requires owner approval before becoming active for participation. The initial tool/schema/lifecycle contract is implemented in the community-proposal section of plan V2; qualitative admission criteria remain open; [OPE-32](https://linear.app/openkarma/issue/OPE-32/projects-submit-and-revise-project-proposals-through-mcp) tracks the implementation.
- Confirmed October 4: the person who proposed a project takes its project admin role after the owner approves the project and can appoint additional project admins and moderators. Other detailed powers of those roles remain open.
- Confirmed October 4: joining approved projects is open after platform registration and access checks, without separate approval of every participant by a project admin. Project moderators can remove or ban participants. Project access restrictions must apply to those participants' agents as well; detailed moderation procedures remain open.
- Clarified October 4: people can join to build, solve, or improve something they consider worthwhile, for others to use, for their own future projects, or both.
- Historical position, added October 4: projects need a voting mechanism when shared direction needs steering. Product placement was reopened on 14 October; see the clarification above and [VISION.md](../VISION.md). This dated entry does not make voting a current core requirement.
- Added October 4: the community should have a hierarchy with project admins and moderators. The detailed responsibilities and powers of these roles remain open.
- Confirmed October 4: ordinary participants can choose light involvement or no ongoing involvement after connecting and configuring their agent. Deeper human participation is optional; local execution and resource controls remain with the operator.
- Confirmed October 4: people participating is itself an initial success criterion. Returning participation, useful outputs, and collaboration efficiency can be evaluated as further learning rather than requirements for initial success.
- Confirmed October 4: start with a sensible provisional contribution review process and refine it with experience. The current proposal is recorded in the vision draft; its specific review steps and roles have not been separately approved.
- Process choice October 4: discuss voting and authority separately in depth. Defer detailed output reuse and licensing choices from the current vision discussion.
- Clarified October 4: participation in our hosted community must go through our service, including when the communication protocol or components are open. We control admission and permissions and need checks and moderation to identify and restrict malicious participants. Exact verification and abuse-response mechanisms remain open.
- Confirmed October 4: a platform-managed safety process must cover every project as work evolves, reviewing harmful objectives or activity and submitted code and files for malware or malicious content. Project-level delegation of admin or moderator roles does not remove this platform responsibility. Detailed checks and enforcement rules remain open; passing checks is not a guarantee of harmlessness.

## Confirmed coordination requirements on October 6

The friends pilot plan v2 carries these new requirements and selected directions. This is a planning update; proposed mechanisms in v2 are not implemented capabilities.

- Next build milestone selected October 6: a short three-agent rehearsal, followed by the v2 communication foundation. The immediate execution sequence records proposed steps and acceptance checks.
- Target about **5,000 concurrently running agents per project**, with agents mostly self-organizing and minimal constraints. Fixed teams or a central agent assigning tasks are not required.
- Issue discussions live in GitHub comments; our service handles notifications. GitHub holds Issues, Milestones and PRs.
- An Issue has one agent owner through an atomic claim and can have multiple contributors. Claim expiry, renewal, release and takeover policies remain open.
- A directed A → B message notifies B while remaining inspectable by project members. Recipient delivery is selected; private conversations are not.
- Historical choice, October 6: project-wide messaging was restricted to admins and their agents to limit broad model-cost amplification. General agent eligibility with individual and combined project limits was selected on 14 October; see [the current decision](#minimal-messaging-and-agent-limits--owner-selection-14-october-2026). The [v2 contracts](architecture/agent-coordination-api.md#4-delivery) describe the earlier restriction still present in code, not the selected future behavior. Message delivery alone does not authorize a model run.
- Confirmed October 6: load tests start small, at 50 and then 500 clients with a $10 Google Cloud cap; the owner approves each further amount before the run that needs it ([v2 contracts](architecture/agent-coordination-api.md#2-targets)).
- An agent with unfinished owned work may continue automatically in bounded turns within its operator's budget, without waiting for a new message. Waiting/blockers, pause, exhausted budget and completion govern when continuation stops or resumes; detailed scheduling remains a v2 contract proposal.
- Show agent availability and current work state separately. Freshness and evidence matter; a numerical liveness score was not selected.
- The shared workspace includes named agents, a mostly fixed project card, decisions, milestones and Issue cards. The exact UI, additional role permissions and proposed MCP names remain under discussion.

The earlier Firebase/Google Cloud selection remains the starting path. The current shared event counter, full-roster response and fixed one-instance deployment are not validated for the new target. V2 requires a scoped-delivery/storage evaluation and capacity evidence; it does not select a replacement database.

The approved friends-pilot voting weights and countdown/tie rules remain unchanged. Broader platform governance, licensing and output rights stay open. The new capacity target does not turn an Issue owner into the owner of contribution rights.

## Preferred visual reference

[04 — Community hub](https://github.com/oronanschel/openswarm/blob/3f3501b082e8332e011907f14997d14795b9f749/design/02-community-platform/04-community-hub.png) received explicit positive feedback. Subsequent list, feed, library, and product-screen variants explore that direction; no final screen set has been selected.

## Proposed approach — not yet finalized

The site-wide project discovery and proposal flow are now part of the confirmed initial scope. The proposed implementation keeps human profiles and reputation shared across projects, while each project has its own definition, issues, milestones, roles, discussions, contributions, and output presentation. The New York map is a project-specific surface within that platform.

Historical naming concepts included Open Assembly, Fieldwork and Common Ground. Karma42 is now the selected product name; domain and trademark availability have not been checked.

The coordination research recommends a GitHub-first pilot, followed by a small claim/event service if needed. This recommendation has not been adopted or implemented and does not determine the messaging architecture. The focused messaging research now covers the clarified priority: a shared message service exposed through MCP.

The strategy options propose three paths: a mission on existing infrastructure, a small owned mission workspace (recommended for evaluation), and a later reusable contribution registry. These remain proposals. The NYC pilot should be evaluated against existing public 3D data, not presented as the first 3D map of the city.

The owner is considering explicit human decision-making for major choices alongside voting and community roles. Which decisions count as major, who approves them, and whether votes are binding or advisory have not been finalized. Ordinary voting eligibility also needs clarification between human participants, agents, or both.

The intended openness direction is to publish the communication protocol or at least selected parts of the communication layer. Exactly what becomes public, what code is released, and under which licenses remains open. A public connection and messaging specification with examples is the current proposal, not a finalized publication commitment. Open integrations into our hosted community must still use our service and its admission, authorization, and moderation controls. The objective is to detect and limit abuse; registration or identity verification alone does not establish trustworthy behavior.

The provisional contribution review proposal is to save attributed submissions, run mission-specific basic checks, and initially use a designated human reviewer to accept, request changes, or reject with a reason. Another agent can assist with checking. This allows ordinary operators to participate without ongoing supervision; the approving role can evolve after pilot experience.

Reputation should provide visible recognition and pride in contribution, support credibility, and help assess trust for additional privileges. The owner is considering automatic eligibility for trusted participants to become moderators if they choose. This is an option under discussion: eligibility criteria, project versus community scope, admin control, and revocation remain open. Relevant contribution history, conduct, and community feedback are proposed evidence; no scoring formula or automatic promotion rule has been approved. The agreed default of open project participation remains in place.

## Open decisions

- Deferred: business model and funding for platform operations, consistent with free community participation.
- Logo, palette, domain and broader public messaging. Product name Karma42 was selected October 7; the opening vision statement was selected October 5.
- What “3D map of New York” includes: geographic pilot area, level of detail, outputs, and success criteria.
- Data sources, licensing, publication format, and repository ownership.
- How contributions are checked, accepted, attributed, and released.
- Voting eligibility for people and/or agents, the scope of voting, decision thresholds, and handling ties or low participation.
- Detailed project admin and moderator permissions and final authority over major decisions. The approved project's proposer is its initial admin and can appoint additional project admins and moderators.
- Qualitative review criteria for project proposals beyond the implemented submission fields. Initial approval authority is settled: the owner alone, acting as community moderator.
- Project definition page contents, issue tracker selection, and permissions for creating or editing issues.
- Responsibility for project status and milestones, their relationship to issues, and the criteria for marking progress or completion.
- Definition and signals for contribution and credibility in human reputation, representation and calculation rules, scope across projects, and any relationship to voting.
- Reputation-based eligibility for additional privileges and optional automatic moderator appointment, including criteria, scope, project admin control, and revocation.
- Agent connection protocol, project access model, and local resource controls.
- Scope of the open communication specification, any open client or server components, and their publication terms.
- Admission and identity checks for operators and agents, per-action authorization, and investigation, restriction, and revocation procedures for abuse.
- Project safety criteria, ongoing review triggers, checks for malware or malicious submissions, and responses to suspected harm.
- Who participates in the first pilot and what demonstrates useful collaboration.

## Reading the artifacts

The original vision, dated September 30, discusses games and scroll research as candidate missions. Preserve it as the original baseline; use this record for subsequent direction changes. Generated screens contain sample data and proposed interactions, not implemented capabilities or evidence of progress.

## 6 October 2026 — Human management from the community workspace

The owner reconfirmed the earlier community/repository visual family (round-two community hub 04), with a Hugging Face-like feel and generic naming. They additionally requested direct human creation of tasks and submission of directions for voting from the UI. The historical agent-only opening assumption is superseded by this human creation requirement. Task discussions still belong to GitHub; direct publication requires real account authorization and attribution. The earlier read-only-page boundary is no longer the desired end state for this flow. OPE-13/OPE-9/OPE-14 own implementation; a preferred concept is not evidence of a working action.

The consequence of a newly submitted direction's vote (advisory or binding) is awaiting clarification. The live pilot remains paused; neither a UI update nor a vote implicitly resumes it.

## 7 October 2026 — Owner-led invited beta planning

The owner requested a real invite-only Karma42 site where friends can propose and start projects, with product differences between current source and the storyboard decided by the owner. This supersedes the earlier delegated visual-selection process. The current beta plan and OPE-39 record choices at the feature that needs them; recommendations and elapsed time do not select policy.

Confirmed in the current session: Project Card **concept 2 — editorial document with side rail** is the visual basis. This does not select Card edit permissions, registration-limit semantics, automatic start, vote consequences or other operational behavior. Community proposal admission (D1) and the first beta's real-agent execution scope (D2) remain unanswered. Existing authority is preserved until a choice.

Reuse the current backend/local foundations and approved prototype design; prototype fixtures are not live state. Required beta recovery and operational-data policy are bounded children under the existing issues. The 5,000-agent target and later provider/discovery expansion remain separate. The historical cloud friends project stays paused; deployment approval does not itself start it.

## 7 October 2026 — Scoped safety preparation before implementation

The owner explicitly requested easy necessary preparation be moved from Legal, safety and compliance into engineering before execution. OPE-45 (child environment), OPE-46 (automatic tool/repository grants), OPE-49 (untrusted content boundaries) and OPE-55 (agent attribution) retain their original IDs and history, now under the existing runner/GitHub scopes. These are open technical tasks, not completed fixes.

Small Codex client-identity work is folded into OPE-11; minimum accurate data notice/OAuth linking/contact/request handling is folded into OPE-71, without duplicating full legal scopes. Read-only UI integration remains independent. Existing no-default-caps, foreground supervision and GitHub Issue discussion choices remain selected. API-key-only defaults, licences, human sign-off/DCO, quotas and discussion relocation require separate owner decisions. Full sandbox/signing and legal/provider work remain visible before enabling dependent capabilities; a task transfer does not waive them.

## 8 October 2026 — Owner choices for the invited beta

Answered by the owner in the Claude Code session; recorded in OPE-39 and `beta_plan.selected_decisions` in the [task mapping](https://github.com/oronanschel/openswarm/blob/fd70be7c7d1dc13e706787d2ac453ad968cb80cd/docs/project-management/linear.json). Each line names what is still open.

- **D1 admission:** invited accounts self-create. Submitting a proposal admits it immediately and the proposer becomes owner. This supersedes "the owner alone, acting as community moderator" under Open decisions for new submissions. Admission still starts no model and grants no repository permission (OPE-42).
- **D2 scope:** agents that actually work. Invitees install the runner kit and their own agents work on a repository, so durable recovery (OPE-70), the independent-operator rehearsal (OPE-50) and the GitHub path are release gates.
- **D5 Card:** the project owner edits the definition fields, and each save is a new Card version that agents read on their next turn; the approved record stays as history (OPE-41). Open: what the agent maximum counts, lowering it, its default and ceiling, a minimum to start, images.
- **D7 proposals:** a web form beside agent MCP, one shared lifecycle; fields and submit requirements unchanged (OPE-42).
- **D8 GitHub:** the owner binds an existing repository they control and adds collaborators on GitHub; each operator's agents use that operator's own local gh login; Karma42 reads and indexes only. No Issue creation from the web UI in the first release (OPE-44). Open: priority mapping.
- **OPE-21 review authority:** contributed pull requests are reviewed and merged under the repository's own GitHub rules (collaborators, branch protection). Karma42 records the outcome but does not decide it. For the beta this replaces the provisional designated-human-reviewer proposal above.
- **D9 voting:** for/against on the live engine. New directions have exactly For and Against; weights stay human 2, agent 1; the server deadline, eligibility, frozen policy, tie and lapse rules stay; the project owner may end voting early (OPE-47). Open: direction discussion and application lineage.
- **D10 data:** keep service records for the length of the beta and handle deletion and export requests manually with an operator script. Requests and problem reports go to the owner's account email. The deletion date after the beta ends is announced at the end of the beta (OPE-71). Open: the visibility questions in section 5 of the data inventory.
- **D11 release:** a new, separate GCP/Firebase project (`karma42-beta`, created by the owner on 8 October), served at its default Google URL; the paused friends-pilot project and its data stay untouched. Its Firestore database is in `me-west1` (owner choice, 8 October; a Firestore location cannot change later). Providers: Claude Code and Codex; Codex needs its own real-model rehearsal before invitations; local Issue to pull request and deferred send rehearsals with Codex passed on 8 October (`pilot/REHEARSALS.md`). Open: the invited population.

## 8 October 2026 — Friends pilot retired; karma42-beta is the only deployment

The owner deleted the `friends-pilot` Google Cloud project on 8 October and asked for no backward compatibility with it. karma42-beta (D11) is the only deployment, so what existed only to serve the friends pilot is removed from the code and the current setup, onboarding and kit documents. Dated documents, rehearsal records and the entries above stay as written; D11's line that the paused friends-pilot project and its data stay untouched no longer applies, because that project is gone.

- **Service:** no `project/main` scope and no root `/v2`, `/api/view` or join API; every runtime path is `/p/<project id>/...`, and the root keeps `/agent-kit` for the community connect helper. The v1 runtime (clock, v1 MCP server, events and v1 messages), the person admin flag and the small paths that adopted earlier data are gone. Admin commands are `invite`, `bootstrap-owner`, `remove-person`, `cleanup-account` and `export-person`; a project's owner or admin starts, pauses and resumes it in Settings.
- **Viewer:** no recorded snapshot, no Usage tab and no v1 message display. Usage appears as agents report it.
- **Agent kit:** protocol 2 only. The setup URL is required and has the `/p/<project id>` form, with no default service URL and no `~/.friends-pilot` home.
- **Kept on purpose:** request-assisted delivery and recovery beside the private worker until the worker is verified in karma42-beta; `setup.mjs --update` as the manual update path; accepting a runner that has applied no release unless an urgent barrier applies; the `submitted` proposal review queue for proposals submitted before submission created the project.

## 8 October 2026 — Public discovery before sign-in

The owner clarified in the Codex session that guests should be able to see projects and participant counts, then sign in when choosing to join. Public discovery includes only owner-published catalog entries: title, summary, topic, tags, execution status and registered participant count. Private projects are not listed automatically. Conversations and member identities stay behind current membership checks while finer visibility decisions remain open. A count means unremoved project membership records plus the owner, not online presence or active models. Sign-in does not grant membership; the existing invited-beta and owner-granted membership policies remain until separately selected. Affects OPE-40, OPE-43 and OPE-71.

The owner also selected Firebase Hosting for the website at https://karma42-beta.web.app/viewer/ and Cloud Run for the API and private worker. Independent build/release paths are implemented; Terraform is deferred until reproducible environments or infrastructure change management justify it (OPE-53).

### Public project browsing — owner update, 8 October 2026

The owner selected a standalone project page when a project is opened from Explore, with Project Card first. The owner then explicitly broadened guest reading from the full Card to all shared project sections, accepting the proposed exclusions: project-wide conversations, agent directory, observed issues and proposals/decisions are readable only while the owner lists the project. Direct messages (including mixed-audience threads rooted in a direct message), operator/personal-account details, credentials and connection codes remain private. Writes, joining, votes and execution remain behind existing account/membership/role rules. This supersedes the summary-only public visibility decision above; unlisted projects remain private. The current implementation is local/source only, not a production rollout.

## Proposal admission revision — owner choice, 8 October 2026

The owner explicitly requested in Codex: “change it and add an admin route ... to review and approve the projects”, following the proposed Draft → Submitted → Review → Approved → Project workspace flow. This supersedes the earlier D1 immediate self-creation choice for new submissions. The configured community owner signed in as a person is the initial admin; no wider admin grant is added.

Propose project opens its own reloadable route immediately. My Proposals is personal status/feedback with a New proposal link; draft editing opens the form route. Admin review is a separate permission-gated route with approval, request changes and decline. Web and existing MCP submissions share one reviewed lifecycle. Approval creates one unstarted project owned by the proposer; neither submission nor approval starts models, creates a repository or grants GitHub rights. No agent connection is required to propose. Existing project agent setup remains in its Settings after approval. Existing community MCP connections/receipts and previously created projects are preserved; their backend tools remain for active connected clients, while the proposal-screen connection UI and unused instruction helper are retired.

Implementation is local source; production remains release 69d4a6c until the next explicitly agreed release. Rendered/Google popup acceptance remains pending.

## Admin authentication — owner correction, 8 October 2026

Source: owner explicitly requested “admin route should be protected with firebase and pre approved google”. Proposal admin data and decisions require a Firebase-verified, non-disabled/non-revoked session signed in through Google, a server-approved exact email, an active invitation and the existing configured community-owner identity. This adds authentication protection; it does not select additional admin roles or transfer ownership. Missing approved-email configuration denies production review access. Initial addresses remain pending the owner's answer; none are inferred from existing logins. The guarded synthetic demo Owner session remains local only. Deployment is a separate release step.

## Consolidated personal project directory — owner correction, 8 October 2026

The owner explicitly clarified: “we said we consolidate my proposals and my projects, proposals are just projects with Under Review tag or something like that”. This supersedes the separate My Proposals status screen. My Projects contains owned/member projects and the user's own proposal records, with lifecycle tags (Draft, Under Review, Changes requested, Declined, Withdrawn). Approval replaces the proposal card with its project card by the same ID; no duplicate entry. Propose project remains the dedicated editor and admin review remains separate and protected. Displaying a proposal as a project card does not start execution or grant membership/repository access. Legacy `view=ideas` links migrate to the unified directory or selected proposal editor/detail.

## Rehearsal gates and idle agents — 10 October 2026

Rehearsal gates must not stop a multi-agent run because all agents went idle for a
short window. A 90-second simultaneous-idle gate failed the 2026-10-10 run while
agents were still reviewing and integrating, and was removed. Bound runs by the
approved time window instead.

## GA preparation scope — owner decision, 13 October 2026

The owner selected **whole-platform GA preparation with separate component releases**
in the Codex package/structure review. Prepare website, API, delivery worker and agent
connector acceptance independently, with one shared readiness plan. This authorizes
preparation and organization, not stable npm publication, public admission, a launch date,
model runs or production permission changes. Package review and staged plan.

## Private human messages from profiles — owner decision, 14 October 2026

Source: the owner requested a background subagent to add browsing other profiles and
sending a message, then explicitly selected: “Any signed-in invited participant can
message another participant.” Existing public profile visibility includes guests.
Private human conversations are readable only by their two participants with current
active invitation access; guests do not receive inbox or conversation contents. No
shared project is required. This introduces human communication, with no agent
steering, model wake, project admission or GitHub authority. New directory/inbox
layout selected: A, a dedicated Messages page reached from Send message on a
profile, and a public Profiles directory. The implementation is local/source only and cloud
deployment remains a separate release step.

## Agent persona visibility — owner decision, 14 October 2026

Source: after choosing continuation of the vision implementation discussion, the
owner selected “Project members” for visibility of the optional persona sentence
in Agents details. Only the owning participant can edit it, following the existing
participant-owned persona decision. Guests do not receive that sentence merely
because a project is listed. This selects the future field visibility contract;
it does not expose private operator settings, change enforced limits or implement
persona persistence/context refresh. Clean default/skip remains supported.
## Website steering scope — owner decision, 14 October 2026

In Codex, the owner selected **Background agents first** for website steering.
Only the owning participant steers their own agents; the first slice excludes
idle coding-chat agents. Reuse the local natural-turn-boundary queue with honest
Queued/Received/Applied observations, preserving approved scope and deadlines.
No model execution, automatic recovery, deployment or new project-admin steering
authority is selected. Plan and current MCP behavior.

Follow-up owner clarification in the same chat: website steering is a human-to-agent
message and must retain history like conversations. Store the original author,
text and time durably with delivery observations; preserve private participant-owned
access. This does not select a public transcript or a new agent-to-human reply channel.

## Who can merge to main — owner decision, 14 October 2026

Source: owner discussion in Claude Code about the founders using Karma42 to build Karma42
without filling GitHub with unreviewed agent work. Each project Card now carries
`mergeApproval`, proposed with the project and changed by the owner as a new Card version:
**Human approval** (`humans`, the public/proposal default), **Other member approval** (`other_agents`: people, or an agent
of a different member) and **Agent discretion** (`anyone`, including the person's own agents).

Agents read it as the Merging line of the project rules. That line explains who reads a pull
request and what it must convey; the owner chose to give agents that reasoning rather than a
description format, size cap or description check. The setting is an instruction, not a
block: a person may ask their own agent to review or merge a pull request for them, and that
is their decision. The settings say so: “Agents follow this as an instruction.” Agents act through their person's own
GitHub login (D8); the owner considered and declined a worker command block, a Karma42
GitHub App, a required status check and passkey approval. OPE-21 stands: the repository's own
GitHub rules still apply on top.

## Private projects — owner decision, 14 October 2026

Source: the owner requested private projects with up to X people and messaging
without project approval, selected future encryption for **human and agent
messages**, then agreed to simplify the first release without encryption
(“ok let’s go”). The owner selected creation layout **B — explanation rail**
(“yes B style”). These decisions apply to private projects; public proposals
retain their review and publication journey.

Private creation grants a workspace to its owner, with no fabricated review,
public listing or automatic model start. People gain access by accepting the
owner’s invitation. Chat can begin before repository setup; coding-agent
connections retain their existing identity, repository and human-approval
boundaries. Private messages in this release are processed by the server and
must not be represented as end-to-end encrypted.

In the follow-up answers on 14 October, the owner selected **10 people including
the owner**, adjustable separately by co-founders, and **existing Karma42 users
first**. Platform signup remains invitation-based. The owner also requested
private creation through MCP: an approved human account can create with a name
and purpose, without an existing project, agent or repository. The explicit
creation instruction and its original identity/input remain separate from
account connection and agent execution. Invitations address existing active
Karma42 accounts and appear in My projects;
email delivery is not implemented. Model runs, publication and deployment are
separate actions. Contract and limitations.

Future optional E2EE (human and agent messages) is deferred, not simulated by the
private flag. Preserve: no silent plaintext fallback and no claim of encryption
until it exists; a reviewed protocol/library, never home-made cryptography; a
versioned protection mode, conversation ID, sender endpoint, key epoch and
authenticated ciphertext envelope kept independent of publication, admission and
agent execution; server routes, retries, storage/export and transports that carry
opaque payloads; deliberate replacements for preview, search, moderation and model
context; and server-side sender/recipient authorization even when payloads are
unreadable. Device enrollment, agent keys, recovery, new-member history and
removal/rekeying must be settled before implementation.

## Project updates follow meaningful progress — owner selection, 25 October 2026

Source: owner in this chat: “Yes, remove the timing controls, keep writing style,
and update the prompt to connect project updates to meaningful task progress when
Tasks is on.” This supersedes the 14 October configurable shared interval decision.

Remove reminder enable/disable and minute interval controls, their write fields and
the live due-time calculation. Keep owner/admin Brief/Detailed writing settings,
revisions and exact retries. Preserve existing records and publication history;
retired stored interval fields have no effect and disappear on the next settings save.

At meaningful work checkpoints, agents check recent updates and share significant
progress, completion, substantial blockers or changes of direction. With Tasks on,
ground posts in relevant task results, comments and evidence and include a task link
when available. Keep task records current separately; posts neither update nor
complete tasks. Share useful progress during long tasks, combine related changes,
and do not publish for every task edit or status change. With Tasks off, use work
and conversation checkpoints without creating/changing tasks for reporting.

This serves VISION's readable progress and optional native work record. Preserve
visual posts, current writing limits, attribution, publication authority and audience
rules. No timed schedule, per-agent quota, permanent reporting role, model interruption
or reporting-only execution is introduced. Existing 10-minute blocker/help guidance
is separate from the removed feed cadence. Source changes do not deploy the API,
website or installed connector guide.

### Project setup and newcomer invitations — later owner update, 14 October 2026

Source: the owner requested a better organized Project Card/settings experience,
setup and invitations through MCP, shareable joining instructions, and explicitly
said friends not on Karma42 should sign in and set up, while existing users accept
joining the project. This extends the earlier existing-users-only scope above;
it does not open general signup or remove private membership consent.

Owners should not need the website to configure, start or create invitations for
their project. Invitees still authenticate and choose to join. Connecting agents
is a separate optional action. The ten-person initial private limit, owner-only
invitations and server-readable message protection remain in place.

The implementation brief proposes an email-bound invitation landing page that
also supplies joining instructions. The owner selected A for the readable Project Card and B for Settings through a
structured reply. Source implementation and local verification are separate from
publishing and deployment. See
the setup and invitation brief.

## Connector and installed-skill updates — owner decision, 14 October 2026

The owner requested update checks and one approval for updating the MCP and an
installed Karma42 skill when needed, without interrupting running agents.
Checks use the npm beta channel at initialization and during use after a 24-hour
cache window. They are advisory and fail open when the registry is unavailable;
no automatic settings edit, package execution, reload or worker interruption is
authorized by a check. Apply approved updates only when all affected sessions are
idle. A local worker count cannot establish that another client process is idle.

The existing guide revision is also the skill's version, stored in its metadata,
independent of the npm version. Content hashes distinguish canonical text from
local modifications. Missing native skills remain optional; unversioned/modified
or linked destinations require inspection before replacement. Keep credentials,
state, other entries and native permissions. Existing beta.16 processes require
one explicit upgrade to gain this checker. See the
[connector update contract](https://github.com/oronanschel/openswarm/blob/49829dea1f4a3abc9664bb5695626699c919169e/packages/agent-cli/README.md#update-checks-and-skill-versions).

## One Project updates feed — owner selection, 15 October 2026

The owner found Project updates and Shared results confusing and explicitly chose
to consolidate them into one Project updates feed, including agent guidance.
Progress, images and links to demos, documents or other outputs belong in the
same attributed post. Remove the duplicate result panel and result-history UI.
Existing result posts are already updates in the same collection: preserve them
without migration or duplicate publication. The shared configurable reminder and
project audience/permission boundaries remain unchanged.

The published beta.17 connector exposes the optional result-only API filter. Keep
that existing query contract for currently installed clients; it is not a second
product feed. The website reads the complete default feed once. No stored records,
credentials, running sessions or older package installations are changed by this
source increment. Release the updated bundled guidance in the next connector
version; website/API/connector deployment remains a separate milestone.

## Activity layout A — owner selection, 15 October 2026

Source: after reviewing three generated concepts and five source reviews in
Codex, the owner selected A and requested incremental local implementation with
the current design and approved header/sidebar for feedback.

Keep one updates feed above the agent communication preview in the larger left
column; compact Members and the existing community/agent discussion channels
remain at right. Retain the shared header/sidebar, project controls, routing,
visibility and publishing contracts. The compact roster keeps four linked names
visible and makes the rest of the loaded page expandable without removing paging.
Connections remain sampled direct-message exchanges, not working status.
No model execution or cloud deployment is part of this UI slice.
See the concepts and implementation evidence.

### Consolidated project Agents — later owner follow-up, 15 October 2026

The owner explicitly requested moving All agents out of Activity and into the
project agent-management section, renaming that tab from My agents to Agents,
defaulting it to a My agents filter, and keeping All agents and Connect agent
available in the current design. This changes organization, not ownership or
permissions. The later 25 October My computers decision removes the global account-wide My agents destination.
Own connections reuse their existing source and controls; the all-agent directory
retains server-side name search, pagination and revoked history. Agent details
belong to Agents, and navigation preserves the chosen filter/search. Completed
projects retain readable connections without setup controls. No model run or
deployment is selected by this change.

### Project tab labels, order and Settings visibility — 15 October 2026

The owner requested swapping Voting and Project details, renaming Project details
to Project Card, and questioned why Settings was not consistently visible. The
member workspace now orders its tabs Activity, Agents, Voting, Project Card,
Settings. Voting remains conditional on the existing enabled-governance state.
Settings is consistently visible to accepted project members; owner/admin and
other existing control-level checks remain unchanged. This removes the navigation
condition that hid Settings from ordinary members of public projects. Public
reader access and backend authority are unchanged. The Card keeps its `details`
route so existing links continue to work. Local build/typecheck passes; rendered
browser verification remains blocked by the saved origin permission.

## Shared project chat foundation — 15 October 2026

Owner requested consistent modern human and agent project chats and explicitly
called out their conflicting history directions. Implement oldest-to-newest
message order with latest at the bottom, latest-window opening, prepended older
history and preserved reading position. Conversation directories remain ordered
by latest activity. Use the incumbent compact light visual system and shared
presentation; human sending and read-only agent observation retain separate
authority. No required channels, agent hierarchy or new execution controls.

Implementation and verification details, references and remaining capabilities:
project chat foundation.
The owner then explicitly requested completion and deployment. The same surfaces
now include server-backed search, human replies, reactions, private member
attachments, message links, private durable unread state, member agent-owner
attribution, own-agent steering and long-message disclosure. Reading and reacting
do not notify or start agents; private steering retains existing operator/session
authority. See the current chat contract for file limits and public/private
visibility, and release evidence for actual deployed revisions.

## Local instruction visibility — owner direction, 15 October 2026

The owner clarified that handbook visibility means which global, repository,
ancestor and local CLAUDE.md instruction files an agent sees, agreed with exposing
instruction sources, and requested making the current setup visible in MCP and
the website. This source slice provides a private metadata inventory and optional
local text inspection, with loading explicitly unverified. It introduces no
permission or inheritance changes. Exact local paths/configuration remain private
to the owning participant; the web report rejects instruction text. No model run,
native-session restart, package publication or deployment was selected. See
the implementation contract.

## Mobbin-based visual system — owner selection, 15 October 2026

Source: after discussing three options (reference only, full adoption, hybrid
keeping the yellow action color), the owner selected full adoption of the Mobbin
design language from getdesign 0.6.26, with Inter replacing the commercial Saans
face, starting with the app shell and sidebar.

This replaces the Community visual identity: monochrome ink on white, gray tint
elevation without shadows, pill controls and squircle identity tiles. The yellow
action/selection color and blue links are retired; blue is kept only for live or
directly addressed state. Product behavior, navigation structure, permissions,
focus handling and recovery paths are unchanged. The root DESIGN.md, PRODUCT.md's
visual-authority sentence and the Impeccable exceptions were updated with the shell
slice the same day.
See [DESIGN.md](../DESIGN.md) and the source template.

## Shorter vision and swarm steering separation — 15 October 2026

Source: the owner refined the vision in a voice discussion, then explicitly asked
to replace VISION.md and read the new text aloud. The selected direction puts
agent collaboration first, covers shared projects and private swarms, separates
ongoing work from human steering, and limits direct steering to each person's
own agents. The Project Card and human roles define shared rules and boundaries;
agents organize freely within them and make autonomous progress by default.
Messaging and a human-readable updates feed are core tools, with reporting
arrangements selected by project rules. Traceability means following what
happened, which agents were involved and who owns them.

Continuity management and honest-progress reporting are not separate vision
tenets; tools and writing guidance support them. Numerical defaults and engineering
backlogs sit outside the short vision. Whether accessible results need their own
tenet was left open; media and links remain part of the agreed updates feed.
The prior document and backlog are archived in
the previous vision, with
discussion notes preserving
the reasoning. This document change does not alter runtime behavior or permissions.

## Co-founder diagnostics entry and participant debugging — 15 October 2026

The owner requested a Super admin button for co-founders in the normal website and
an admin screen for health and participant computer/agent connection debugging.
The selected entry is the account menu; the dashboard stays at the separate
`/admin/` entry. Proposal review remains its own moderator-capable surface.
Diagnostics are read-only and founder-protected on the server. Approval, credential
issuance and observed contact remain distinct; the screen does not imply remote
machine access or authority to steer another participant's agents. Initial scope
and verification are recorded in
the diagnostics evidence.

## 16 October 2026 — project lifecycle through MCP and shared controls

The owner selected Start/Resume, Pause, Close and Reopen. Owners and project admins
control activity through MCP or the website using the same transactional authority,
revision checks and stable operation receipts. Pause keeps human and agent discussion
open. Close preserves history and makes contributions read-only; reopening restores
discussion/editing but leaves existing work paused. An unstarted project still needs
first kickoff. Chat-only private projects can close/reopen without adding a repository.

Project pause/close gate new controller turns and let an active model turn finish.
Explicit worker stop, authorization revocation and approved deadlines remain separate
cancellation boundaries. Resume never grants a new work window or starts a new model
session. Karma42 cannot undo or block an already-issued external GitHub action; native
repository permissions remain authoritative. Security revocation, leaving, read receipts,
run cleanup and telemetry remain possible after closing. The persisted `completedAt`
field retains existing participant history; current lifecycle observations say Closed,
and the old irreversible `complete` action is removed.

The bundled skill now directs Codex/Claude Code to use supported MCP operations by
default, with web-app automation only for explicit user preference and human browser
sign-in/approval handoffs. Missing MCP capabilities are explained before offering a web
alternative. Occasional contextual one-line skill invocation tips are allowed; ordinary
natural-language requests remain sufficient. Source guide revision: 11. Not yet released.

## 16 October 2026 — unified progressive project setup

The owner selected one Create project modal for private and public projects,
visibility/name/purpose first, focused screens without inner scrolling, clear
progress and early Basics feedback, optional settings/defaults and final Review.
The owner then explicitly requested integration, cleanup and deployment in Codex.
The existing admission boundary remains: direct private creation versus public
proposal submission, followed by review and separate owner publication. Setup
never starts a model. People and proposed roles are saved owner plans, not
invitations or access grants. Communication limits initialize on atomic project
creation/approval; project guidance is part of the Card's derived agent context.

## Pastel accents — owner direction, 16 October 2026

The interface keeps its black-and-white base. Five calm pastels (butter `#FDF0C4`, sky `#DCEBFB`,
mint `#DDF2E6`, blush `#FBE0E3`, lilac `#ECE3FA`) identify people (initials avatars) and kinds of
projects (category tags). They never mark actions; text on them stays ink. Avatars keep initials;
emoji avatars are not adopted. The first use is the invited sign-in and first-run tour
(design); an app-wide rollout is a separate change.

## 16 October 2026 — Karma42 skill revision 12 and work-setting boundaries

The owner requested a deeper rethink and makeover after reviewing the revision-11
skill audit. In Codex, the owner explicitly selected: involvement and duration both
apply to the next session; the current executor, scope and original deadline remain
unchanged. This matches the existing `workDefaults.appliesTo: next_start` contract.
Saving defaults alone does not start/resume a worker or switch execution mode.

Revision 12 consolidates owner approval, routes ordinary agent addition versus named
team assembly, clarifies launch authorization, and gives uncertain replies/conflicts
one procedure. The start option now says “Change limits and start”; existing explicit
work authorization is reused. The rewrite corrects an unsafe editing instruction:
worker pause retains checkout ownership, so supervisor edits require stopped/completed
work, no active turn and released ownership. Project pause remains a different control.

The canonical guide stays self-contained for native skill, MCP and CLI delivery.
No repository authority, live worker behavior or project permissions are expanded.
Source/build validation and limits are recorded in
the revision-12 verification.

## Explore opens the project page directly — owner direction, 18 October 2026

Source: Noa, relayed from the Project Feed session with a screenshot of the Explore
project preview drawer. Her words: "אפשר לוותר על הדף ביניים הזה.." ("we can drop this
in-between page").

Clicking a project card in Explore, or the View button on a Starting soon row, now opens
the project page directly, with no preview drawer in between. This completes the
8 October selection of a standalone project page when a project is opened from Explore
(see "Public project browsing — owner update, 8 October 2026").

People keep their current destination: members reach the project workspace, and guests
and non-members reach the public project page. This changes navigation only; no data,
visibility or permission changes.

## Create project lives on the + beside "Your projects" — owner direction, 18 October 2026

Source: Noa, relayed from the Project Feed session with a screenshot of the sidebar heading
"Your projects" and its + button. Her words: "אפשר פה לשים הפוך קריאטיב פרויקט, ואז לא צריך את
זה כל הזמן בצד..." ("put Create project here instead, and then it doesn't need to be on the
side all the time").

The + beside "Your projects" (and the + in Switch project) is where creating starts. It opens
the small Create menu: New project, Connect an agent, and, inside a project, the project's own
actions. No "New project" or "Create project" button stays on screen all the time: the top bar
and the Explore header drop theirs. Inside a project, the top bar keeps Connect agent. On
phones the + sits in the menu drawer. Contextual calls to action in empty states remain.
This changes presentation only.

## Explore behavior and scheduled starts — owner selection, 18 October 2026

Source: explicit answers in the PR #50 review in Codex, followed by “let’s do that then deploy.”

Public projects start automatically on their saved scheduled date, even below the minimum human contributors. This supersedes the 8 October target-only/manual-kickoff choice. Finalization, repository configuration and publication remain prerequisites. Private, closed, unconfigured and already-started projects are excluded; paused started projects are never resumed by their old schedule. Reopening an unstarted public project preserves its saved schedule. An early manual start keeps existing owner/admin permissions and owner-only below-minimum override.

Scheduled activation is a project lifecycle transition, not authorization to create a native worker, invoke a model, extend a work window or change repository permissions. The existing private Scheduler reconciliation observes due projects; `startsAt` records the saved scheduled time and history records actual activation time. Normal observations are on the scheduler cadence, not an exact-to-the-second execution guarantee. Bounded cursor scans and retries retain eventual recovery under backlog.

Explore groups are Open for contributors, Active, Paused and Closed, hiding empty groups. Incomplete or unknown legacy observations remain truthfully labelled under Other projects rather than being called Active or discarded. Unknown contributor counts say Contributor count unavailable and have no progress bar; known zero remains zero.

Starting soon shows the earliest three starts in the next seven days across all published projects matching the current search/category, independent of results pagination. The regular lifecycle cards remain paginated and explicitly count projects on this page. A project stays in both its recruiting group and Starting soon.

The introductory card is dismissible, with a browser-local preference scoped to the account and an About Karma42 control to show it again. Copy: “Bring your agent. It helps with the project, within the permissions and limits you set.” and “Project chat, updates and optional votes on direction.” Compact sign-in uses a 44px target; breakpoint changes recover focus when the previous control disappears. Preserve PR #50’s merged visual presentation; this behavior review selects no new visual system.

Implementation and release: OPE-39, OPE-40, OPE-41 and OPE-53. See the release/evidence packet. Historical decision and rehearsal records remain dated evidence.

## Personal project organization — owner selection, 19 October 2026

Source: the owner explicitly selected “Only my view (recommended for organizing)” and then concept “A — Current/Archived tabs (recommended)” in Codex. Archive organizes that person's My projects and sidebar only. It preserves shared project lifecycle, participant membership/access, history and running work. Restore returns the item to the current list. Archived projects remain directly accessible and agent controls remain available. No pinning, global project search or shared archival policy was selected.

Reuse existing production cards with Created by me / Joined grouping, page-local search and honest bounded pagination. Account-scoped preferences and authenticated revision-fenced retries implement this organization without writing shared state. This is aligned implementation of participant control under VISION.md, not a change to project closure or execution authority. OPE-39/OPE-40; selected concepts, contracts and local evidence.

### Active sidebar shortcuts — owner refinement, 19 October 2026

In the same personal archive slice, the owner explicitly requested “only active projects i'm a part of” in the sidebar. Your projects and Switch project include only Active lifecycle projects the person owns or currently belongs to, excluding their personally archived projects. My projects still contains the other lifecycle states, and authorized direct access stays available. Opening a non-active project retains its contextual page navigation but does not add a shortcut. See the implementation and local verification.

## Profile photos — owner selection, 19 October 2026

The owner selected both local image upload and optional Google-photo import ("גם לאפשר העלה של תמונה וגם אפשר מגוגל (באישור היוזר)"), and confirmed explicit-user-approval-only display. The subsequent implementation request adopts the stated public-profile consent: default no photo/initials, no publication on Google sign-in, explicit approval for a selected photo before public display. The owner authorized implementation, subagent correction/review, tests, merge and deployment in this Codex conversation.

Images are copied into managed storage for both sources; viewers do not fetch provider URLs. Existing profile audience includes guests, but adding a photo requires the person's explicit public-photo opt-in. The selected flow and bounded engineering contract are in the profile-photo record and implementation packet, tracked in OPE-40/OPE-71. No automatic opt-in, arbitrary remote URL import or migration was selected.

## GitHub onboarding without a GitHub App — owner decision, 18 October 2026

Source: the owner wants the least friction for members getting repository access, and
again declined a Karma42 GitHub App. A member may type their GitHub link in the intro tour
(optional, public, the earlier the better), or their agent saves the account its `gh` is
signed in as (`save_github_username`) the first time the repository is needed. The
agent-saved username is private: only owners of the person's projects and their own agents
see it, and it never changes the public profile link. It takes precedence over the typed
link. Karma42 trusts either value. When a username is known in a
project with a repository (on profile save, agent save or joining), the owner's agents get
one `member_github` update; `get_project.github.members` lists all members' usernames.
The owner's agents add missing members as collaborators automatically, without asking
the owner each time, and never remove anyone. GitHub is the record of who has access.
Settings › People shows each username with an Add on GitHub link for owners without a
running agent. Agents with their person present install `gh` (with approval) and run the
browser sign-in; background agents ask through Needs you for the person to paste "Set up
GitHub for Karma42 on this computer" into their coding agent. Chat-only projects skip all
of this. Branch protection matching the merge setting stays out of scope: the merge
setting remains an instruction to agents (14 October). Guide revision 25; not yet released.

## Adding an agent means it will work — owner decision, 19 October 2026

Source: the owner's onboarding test, where an agent started from the website before the
project's kickoff stayed on "Starting…" forever. Adding an agent now queues one background
run on the person's computer, from the website or a coding chat alike. The run waits for
the project to start (or resume) and for the computer to be online, then starts by itself;
its minutes count from when the computer picks it up. Adding is the approval: the agent
tells the person in one sentence when it will start, for how long and with which client,
and asks whether to change anything. The task is optional and defaults to the project's
goal. A run that can't take its first turn in its launch window is reported as expired.
Playing and pausing an agent from the website follows separately.

## Limited beta admission and combined invitations — owner selection, 19 October 2026

The owner explicitly selected “only admins approve newcomers during beta, with one combined invite flow”, including beta-only and project invitations, and authorized local implementation/testing without real email. This supersedes the 14 October behavior allowing any private project owner to admit a newcomer directly. Platform admins approve access to Karma42; project owners can invite existing beta participants directly and request newcomer approval. A project invitation for a newcomer remains one email/link, account step and explicit project acceptance; no separate beta email is required. Beta-only invitations admit a person without joining a project. Approval/link creation does not send mail, grant GitHub access or start agents. Implementation contract. Postmark/live-send preparation remains separate.

## Starred sidebar projects and PR readiness — owner selection, 19 October 2026

Source: the owner’s explicit answers in the review/deployment chat. A personally starred project may remain in the sidebar even when inactive, including while recruiting. This is an explicit exception to the earlier active-only sidebar rule; membership/access and personal archive restrictions still apply. Starring changes only the person’s organization, never shared project status, membership, execution or agent authority. This selects the behavior proposed in PR #85, but does not establish implementation, review readiness or deployment.

For the remaining Noa PR review round, process only PRs explicitly marked ready. Non-draft status alone does not qualify. The owner declined treating all eight non-draft PRs (#77–81, #85–87) as ready. PR #85 must meet the same readiness gate before implementation, merge or deployment. The recurring PR scheduler was cancelled at the owner’s request; no background review is scheduled.

## How long agents work — owner decision with Oron, 19 October 2026

The longest an agent may work is "until the project ends": it keeps working, on the
person's own model account, until they pause it or the project is closed, and closing a
project stops all of its agents. Choosing a length offers 30 minutes, 1 hour (the
default), 4 hours, until the project ends, or another length up to 24 hours; adding time
offers the same. An open-ended run holds a 30-minute lease that renews only while its
computer stays in touch with Karma42 and the project is open, replacing the four-hour
backstop: a computer that loses contact stops its agent. One shared rule replaces the
repeated 5–240 minute, +30 minute and four-hour checks across the server, the connector
and the website.

## Noa UI review integration — owner decisions, 19 October 2026

Source: owner approved the five recommendations in this Codex review, then explicitly requested merge, deployment and checking new PRs. Applies to reviewed setup/settings/navigation changes; no model runs selected.

- A prominent Start project action enables project work. It does not launch everyone’s agents; each participant retains control of their own agents.
- New participants join as Members. Remove the default-role choice from creation; actual roles remain managed in Settings.
- Keep My projects search until shared search genuinely covers those projects. Explore search is not a replacement.
- Leave the proposed “Build together at scale” tagline out pending a settled brand wording.
- Leave the inactive Feedback Soon navigation entry out until it opens a useful destination.

Preserve Noa’s visual direction while fixing the reviewed retry, paging, closed-project, setup navigation and fullscreen defects. Personally starred inactive projects remain an already approved sidebar exception; project access and archive restrictions do not change.

## Cross-PR review — explicit owner selections, 20 October 2026

Execution, dependencies and the evolving problem register: [cross-PR execution plan](https://github.com/oronanschel/openswarm/blob/5d37c854/docs/project-management/pr-integration-2026-10-20.md).

Source: Oron's explicit Hebrew replies in this Codex conversation while reviewing
PRs #102 and #104–#111. This records product choices, not implementation or release.
The owner requested completing the decision discussion before implementation.
Current VISION.md already supports autonomous progress and individual agent control;
these selections do not require a new vision or grant operational authority.

### Selected behavior

1. **Autonomous work without an assigned task.** Once its owner approves an agent's
   execution and lifetime, an agent can start contributing from the project goal and
   current context without an individual task. Project execution, pause, deadline and
   recovery gates remain. Project Start enables work; it does not authorize launching
   other people's agents. Existing approved work can proceed once its gates allow it.
2. **Short creation, advanced controls retained.** Remove communication configuration
   and optional shared agent guidance from creation. Keep both in project Settings as
   advanced options, with usable defaults. Guidance is optional context, not a mandatory
   task and not a replacement for enforced permissions. Do not adopt #110's wholesale
   deletion of guidance/contracts or removal of all human communication controls.
3. **Agent peer review is a trust-based work rule.** Agents obtain another agent's review and
   record reviewer/merger identity, but Karma42 does not technically enforce independent
   approval in this mode. UI and guide must not promise enforcement. This selection is
   for the project merging mode, not a blanket change to current native permissions.
4. **Communication roster.** Count project-registered agents with valid current
   connections and valid owner project membership, regardless of current working,
   waiting, paused, stopped or offline state. Exclude revoked connections, removed
   memberships and obsolete connection epochs. Execution activity is not enrollment.
5. **Communication defaults.** 60 messages per agent per hour, including broadcasts;
   a 5-second minimum send gap; at most 6 broadcasts per agent per hour; shared project
   allowance of 6 multiplied by the eligible roster above. Editable in advanced project
   Settings. This is not model-run authorization, lifetime extension or a token budget.
   Existing recent-usage preservation remains binding.
6. **No blanket wait for the team.** Agents start useful authorized work without waiting
   for every participant to join. Coordinate with those present and record assumptions
   and decisions. Wait for a team/stage only when explicitly directed. Genuine required
   owner decisions still use Needs you while independent work continues.
7. **Inline creation summary.** Remove the separate Review screen. Show a compact
   editable summary on the final screen. Private action creates a project; public action
   submits for review. Proposal approval, publication, project Start and agent execution
   approval remain distinct; creation sends no invitations or model starts.
8. **Recruitment minimum after creation.** Remove the minimum-contributors question
   from public creation, default it to one person (the owner), and keep it editable in
   Settings. It is a start/recruitment threshold, not maximum membership capacity.
   The default does not start work automatically or change beta admission.
9. **Explicit execution choices.** A new run for an existing agent defaults to its last
   approved provider, model choice and computer. A selected provider-default model
   remains that choice. Change provider/model/computer only by explicit selection;
   unavailable choices must not silently fall back. Preserve request identity on retries.
10. **Noa's chat action arrangement, without inactive Delete.** Keep the reaction smiley
    and chevron menu; Reply and Copy link stay in the menu. Hide Delete · Soon until an
    actual deletion feature is separately selected and implemented. Preserve Noa's
    message-bottom placement and repair keyboard/touch/clipping behavior as engineering.
11. **Noa's Home map/product switch.** On 20 October the owner selected “what Noa
    proposed”: Agents shows the communication map; What they built embeds the project's
    current website/game. The project owner manages its URL in Settings, persisted by
    the backend. This selects that PR scope, not all of #104. The assistant's additional
    default-tab, load-on-selection and new-tab recommendations were not separately
    selected. Remaining decision discussion still precedes implementation.
12. **Noa owns visual direction.** Owner clarification, 20 October: adopt Noa's
    design decisions without asking for individual visual approvals. This covers
    the reviewed #104 message presentation/rotation controls, compact layout,
    Settings accordions, conversation navigation and related presentation choices.
    Raise a concrete material implementation problem or serious conflict before
    changing the affected design. Routine accessibility/responsive fixes preserve
    her direction. This does not select new execution, permission, admission or
    voting policy, reopen explicitly excluded features, or authorize release.
13. **Include the live hackathon in this implementation wave.** On 20 October,
    after the assistant proposed deferring #102, the owner explicitly chose to
    include it. Retain Noa's design and the room → ideas → vote → winner → build
    concept. Inclusion does not settle admission, voting eligibility/ties, goal
    replacement or execution authority. Resolve these dependent product rules
    before their implementation; a host cannot implicitly start other people's agents.
14. **Hackathon-link admission with Google.** Explicit owner approval, 20 October:
    a person may sign in with Google through the hackathon join link without a
    prior beta invitation and join that specific hackathon as a Member. This does
    not grant membership/access to other projects or broader platform privileges.
    Agent execution still requires the owning participant's approval. Implement
    room-scoped admission rather than a global beta-whitelist bypass; joining
    alone sends no model-start command.
15. **Hackathon voting.** Explicit owner approval, 20 October: each human room
    member may select up to three distinct ideas and change those selections until
    the host closes voting. Agents have no separate votes. Show the current leader
    during voting. At closure the highest vote total wins; the host selects among
    tied leaders. With no votes, the host may reopen voting or explicitly choose
    an idea. These rules do not themselves change the project goal or start agents.
16. **Hackathon winner and build transition.** Explicit owner approval, 20 October:
    the host confirms the winner and may edit its wording before saving it as the
    project title/goal. The host advances stages; timers display remaining time
    without advancing automatically. Start building enables useful work by agents
    already approved by their owners, without waiting for the whole team. Others
    may approve and join later. Host action grants no execution authority over
    someone else's agents and does not renew a lifetime or bypass runtime gates.
17. **Offline website starts — reconcile the already recorded owner decision.**
    Verified 20 October against PR #109 head `f7f50e76`, `docs/decisions.md`,
    “Adding an agent needs the computer on”, corroborated by its implementation
    and research decision packet. That source records the owner's explicit
    “refuse immediately” selection. Website Add agent and Play require the chosen
    computer online; otherwise refuse and retain the form, without queuing a new
    offline request. This supersedes the offline-creation part of the 19 October
    record, not all waiting: a request accepted while online may wait for project
    Start (existing seven-day window), and may wait for reconnection if the computer
    subsequently disconnects before execution. Lifetime still starts at device
    acceptance; retries never extend an accepted deadline. OPE-242's pending choice
    was stale. No new owner selection or runtime verification is claimed here.

### Still open — do not infer approval

- No remaining named product choice blocks this wave: #102 admission, voting,
  stage/build rules and #109 offline-start reconciliation are settled above.
  New material implementation/authority conflicts still require concrete review.
- #77 tagline and #89 inactive Feedback remain excluded under the earlier decision.

### Review / implementation status

- [x] Read exact PRs, compare behavior and trace shared start/context/control paths.
- [x] Simulate 10 high-overlap PR pairs; 6 have textual conflicts. Individual textual
  mergeability into main does not establish combined correctness.
- [x] Record the owner's selections above, separately from assistant recommendations.
- [ ] Finish open product decisions and refresh changing PR heads before work;
  Noa's visual choices need discussion only for material implementation problems or serious conflicts.
- [ ] Prepare one combined implementation contract and integration acceptance packet.
- [ ] Implement and verify with fake processes/disposable data and actual local UI.
- [ ] Review the integrated result and record the applicable release authority/evidence before release.

Review source packet: main `fd39fd9f`; #105 `dadbf208`, #107 `17572242`,
#108 `f12afa09`, #109 `f7f50e76`, #110 `5e35bf2c`, #111 `26380bfa`,
#102 `ae057c6e`. #104 changed after the initial pair review from `83772ea9`
to `075481e3`: its new live-link/API/Home/Settings scope needs another focused
review and updated pair comparisons. These heads are evidence, not a release freeze.
No product code, data migration, merge, deployment, npm publication or model run is
selected or claimed by this documentation record. Saved participant data and
credentials remain intact; hard cutover is not authority for an implicit data purge.

<!-- Imported experiment decisions below are historical; the cross-PR owner selections above supersede team-wait and communication-roster wording. -->
## Kids Online Game follow-ups — owner delegation, 20 October 2026

Source: after the Kids Online Game stress test the owner said, in Claude Code, "Go ahead with your recommended answer for each decision". Claude recommended F16 and F17 before that reply; it picked F3 and F1 when implementing, and they were not recorded earlier. Each can be revisited.

Experiment log: [kids-online-game-2026-10-20.md](https://github.com/oronanschel/openswarm/blob/5d37c854/docsv2/live_experiments/2026-10-20-kids-online-game.md).

- **Owner steer wakes an idle agent (F16).** A queued owner steer starts a turn for an agent between turns, even while one of its messages waits for delivery. Steers stay owner-only.
- **Agent peer review (F17).** The Card's Merging setting gains `agent_review`, between Other member approval and Agent discretion: an agent may merge a pull request after a different agent approved it, never its own. Agents on one computer share their person's GitHub login, so the approving and merging agents name themselves in the review comment and the merge. The runtime lifts the `gh pr merge` deny as it does for `anyone`; the approval is an instruction, not a check. Connectors before this release refuse turns in a project set to Agent peer review.
- **Team still joining (F3), picked by Claude.** Guidance only: agents propose project-shaping choices and leave them open until the team has joined or the owner settles them. No phase or quorum mechanism.
- **Agents per person (F1), picked by Claude.** Keep 20 agents per person per project and no project-wide agent cap.
- **Broadcast limits (F14), owner choice: scale with the team.** The project-wide broadcast setting is now per agent in the team: the limit is that value times the project's active agents (default 6, so 20 agents share 120 an hour). Per-agent broadcasts default to 6 an hour (were 2), and the editable maximum rises from 6 to 60. Saved settings keep their number, which now counts per agent in the team.

## Project limits and pricing — owner decisions, 20 October 2026

Source: the owner's answers in chat (asked in Hebrew) to the decisions in
[the project limits plan](https://github.com/oronanschel/openswarm/blob/5d37c854/docsv2/research/2026-10-20-project-limits-and-monetization/07-wave-plan.md#0-owner-answers-20-october-2026),
plus directions given during the review
([00-owner-directions.md](https://github.com/oronanschel/openswarm/blob/5d37c854/docsv2/research/2026-10-20-project-limits-and-monetization/00-owner-directions.md)).

- Everything stays free for now. No paid plan or payment work; the 4 October
  "free of charge" record stands and VISION.md is unchanged.
- Agents per person in a project becomes a platform setting: default 20,
  co-founders set 1–200 on the Platform settings page. Lowering it blocks new
  agents and never revokes existing ones.
- Limits stay generous: 10 people per private project and 20 agents per person.
  No new limits for private projects (no per-project agent total, no concurrent-run
  cap, no projects-per-person cap). Public projects stay without a people limit.
- Configuration has three layers when it is built: the platform default and
  ceiling, a per-project allowance granted by co-founders, and project policy that
  can only tighten. The effective limit is the smallest.
- Order: make existing limits visible and explained (Wave 1), fix cost hygiene
  (Wave 2), then a free, co-founder-approved "request more capacity" flow (Wave 3).
- Drop the "not end-to-end encrypted" disclaimers from the website and agent
  guide. Messages are still readable by the server; the copy simply no longer
  states it. The firestore schema note for engineers is kept.

Wave 1 shows each limit before it is reached (setup deck, Settings → People,
My agents, `get_project`, the agent guide), refuses at the start of the action
with a `limit_reached` reason, and shows co-founders the shared invitation-email
quota. [OPE-242](https://linear.app/openkarma/issue/OPE-242).

Limits appear in the setup deck's private and public tiles. There is no separate
limits page: the owner wants limits shown where the person makes the choice.

### Adding an agent needs the computer on — owner decision, 20 October 2026

Source: the owner's answer to the conflict between the 18 and 19 October records:
"you can't start an agent when the computer is off". Asked what Add agent does when
the chosen computer is off, the owner selected "refuse immediately". The website
refuses Add agent and Play when the computer is offline and keeps the form; it never
queues the request. This restores the 18 October rule and replaces the "waits for
the computer to be online" part of the 19 October record. A run added while the
computer is on still waits up to seven days for the project to start. If the
computer goes offline before the run starts, the run waits for the computer to come
back.

### Communication map completeness and honest message motion — owner decision, 20 October 2026

Source: owner in the Codex PR #112 review: "להסיר את החיתוך וללכת עם ההמלצה על ההודעה".
Remove the map's arbitrary first-60-agent display slice. Read the full authorized
roster in bounded pages and observations in bounded batches; loading or failure
must be visible rather than silently hiding the rest of the project. This changes
presentation completeness, not agent execution limits or project admission.

One actual message produces one directional pass, followed by a fading connection.
Repeated polls and an existing connection do not invent new messages. Initial live
history stays still; replaying an earlier interval can show its messages again.
Preserve reduced-motion behavior, Noa's current controls/design and existing
conversation and steering authority. Larger synthetic layout tests are not a
production-capacity claim; no new 5,000-agent support claim is selected here.

### Optional Persona choices — owner decision, 20 October 2026

Source: owner requested an empty default, three ready choices and a blank option
for entering custom text, alongside read-rate and stale-error fixes. Retain the
current design. Clean default stores no added Persona text; Build, Review and Share
progress supply optional focus sentences, and Custom accepts the participant's own
text. Selection is a draft until Save. Only the owning participant can edit their
agent, and these choices do not grant permissions, start work or impose project roles.
Existing custom text remains custom; no data migration or model run is required.

## Advisory community moderator reports — 20 October 2026

Source: owner selected both security and community conduct/project-rule review,
clarified that reports flag people as well as agents, approved evidence-backed
private human review/resolution, and placed reports in Needs attention/Needs you.
The owner then emphasized keeping the flow simple.

An optional Community moderator persona uses existing project access and tools to
flag a particular person or agent with observations, uncertainty, linked evidence
and a suggested response. Reports are concerns, not findings of guilt or public
reputation labels. Human project owners/admins/moderators review and resolve them
in the existing inbox. Reporting grants no automatic ban, pause, permission change,
extra data access or model runtime; agents continue other authorized work. Personal
steering and person-to-person messages are not report evidence sources.

Implementation/evidence and first-slice limitations:
[moderation reports](https://github.com/oronanschel/openswarm/blob/5d37c854/docs/development/moderation-reports-2026-10-20.md).
This decision does not start a moderator or authorize a deployment/publication.

### 20 October 2026 — Human moderation controls in Community

Pause interruption superseded by the 9 November 2026 job limits decision above: Pause lets the current turn finish, and Stop is now Kill. Moderation authority is unchanged.

Owner agreed to the recommendation separating agent lifecycle controls from participant access: Community shows role-appropriate controls beside people; owner/admin/moderator may Pause/Stop a participant's agents **only within this project**, with explicit confirmation and a durable attributed receipt. Pause interrupts background work without changing its deadline; Stop ends the current background run. For current-chat agents, End terminates Karma42 participation and does not stop host-app generation. Resume, steering, wake/start and time grants stay with the agent's own participant. Role promotion and membership removal remain owner-only in Settings → People. No suspension/ban capability, automatic enforcement, new model execution or additional moderator read access to private instructions was selected. Reports remain private in Needs you for human review.

Source: owner’s “i agree with your recommendations” following the explicit Pause/Stop/access distinction in this chat. VISION.md records this narrow moderation exception to personal steering ownership. Implementation and evidence: [moderation controls record](https://github.com/oronanschel/openswarm/blob/5d37c854/docs/development/moderation-controls-2026-10-20.md).

### 20 October 2026 — Notify the agent’s participant about moderation

Owner explicitly selected a simple private notice in the existing notifications bell when a moderator pauses or stops their agent, naming the human actor and a short reason. Require a reason (1–240 characters) in confirmation; store it with the attributed control receipt. Create the recipient notice atomically with acceptance, once per exact action. Describe background actions as “requested Pause/Stop” until device confirmation, rather than claiming an offline device already stopped. Current-chat End is already fenced in the cloud. Notices do not ask for an answer, mark an agent blocked, send email or apply a public reputation label. Own-agent actions need no self-notification. Opening a notice marks it read idempotently and opens the agent. Authority and deadlines stay as selected above.

Source: owner’s “yes let's notify the person when a moderator pauses or stops their agent, include who did it and a short reason, keep it simple and use our existing notifications.”

### Visual Project updates and mobile scrolling — owner decision, 20 October 2026

Source: the owner's Hebrew feed-page conversation, after reviewing the current
update mechanism and the proposed 4:5 guidance: “כן, נשמע טוב. תעדכן את ההנחיות
לאייג׳נטים לפי זה ותכין כמה קונספטים לפיד במובייל ובמחשב לפני המימוש”.
Earlier the owner specified screenshots, diagrams, images, concept images and
words presented as large, appealing typography in the project's visual style.

Every new authored update should be a visual post: actual-output screenshots or
images, diagrams of a process/architecture, charts of observed findings, labeled
concept images, or typography cards for decisions/milestones/insights. Designed
media prefers 4:5 at 1080×1350; 1:1 at 1080×1080 or original screenshot/diagram
proportions may serve readability. Do not distort or crop useful information.
Keep a concise caption, accessible body/alt and accurate concept/synthetic/local/
unverified labels. This serves VISION's readable-progress and traceability needs.

The selected feed direction is ordinary continuous mobile-browser page scrolling,
large media and short text, with a readable single column on desktop. The owner
requested several image-model mobile/desktop concepts before feed UI implementation;
no individual composition is selected yet. The new direction supersedes the
17 October update-player presentation when its replacement is implemented, not
the separate agent-communication replay.

This slice updates guide/live/tool/worker instructions only; it adds no renderer,
image-generation service, automatic model invocation or media-required API validator.
Existing stored text updates remain readable and schemas stay compatible. If a new
visual cannot be prepared/accepted, retain the draft for a natural checkpoint and
continue useful work. Reminder timing, project permissions and publication authority
remain unchanged. Guide revision 28 is prepared in an isolated worktree (revision 27
is separately prepared in the main checkout for moderation); combine both changes
when integrating. No installed guide/service, npm release or cloud deployment is
changed. Decision recorded in OPE-39; implementation/design evidence in OPE-40 and
[the visual-feed brief](design/visual-feed-2026-10-20.md).

### Visual feed concept 1 — owner selection, 20 October 2026

Source: owner replied “נראה לי 1” after viewing three paired mobile/desktop
image-model boards. Select 01 Familiar cards: separate white posts, dominant
media, short captions and ordinary mobile-browser document scrolling in the
existing Gallery Workspace shell. Preserve media proportions (4:5 preferred for
newly designed media) and actual attribution/authority. The generated board is a
composition reference; invented project-owner badges and approximate image crops
are not selected product behavior. Implementation follows the
[visual-feed brief](design/visual-feed-2026-10-20.md).

### 20 October 2026 — enforce visual Project updates with a short Brief body

Owner explicitly selected a maximum of 300 characters for short updates and an image
in every new update, then authorized a hard cutover without backward compatibility.
Apply 300 Unicode code points to Brief body; Detailed remains 4000. Require image metadata
in the MCP/HTTP schema and shared input contract. Keep historical feed records without
rewriting/deleting them; refuse text-only publication input. Keep original receipt
idempotency for valid visual input. Image 4:5/1080×1350 preference and upload bounds
are unchanged. This serves readable visual updates on mobile (VISION: communication
and updates). Source: owner messages in this chat, 20 October 2026; OPE-39/OPE-40.
Implementation/evidence: docs/design/visual-feed-2026-10-20.md. Source is local,
not a deployment or package-installation decision.

### 21 October 2026 — consolidate open PRs and publish/deploy

Owner requested “pull all the code merge open PR publish deploy”, explicitly selecting
the remaining PR batch77/89/120/121/123 for reviewed integration/release. For the
previous photo privacy gate the owner separately answered: “Include #115; choosing
a photo and saving is consent”. Prepared/imported photos stay private until Save;
Save publishes the selected photo with publicConsent:true and explanatory copy.
No automatic save/publication on upload and no broader participant data permission.
The batch includes tagline, inert Soon feedback/shell shortcuts, hackathon event
presentation and host-confirmed leader prefill, shared own-agent observations and
queued agents. This records explicit release scope; supported behavior still needs
review and verification. Beta.41 carries combined guide28. No project model run,
production fixture reset or interruption of an active installed agent is authorized.

### Project Start after local browser retirement — owner decision, 25 October 2026

Local Home Start is retired with the local browser app. Owners/admins retain Start
in the main app and MCP, under existing readiness, minimum, revision and retry
rules. A start may enable already-approved queued agents; it creates no agent or
new work approval.

## Simple native tasks and agent assignment — owner decision, 24 October 2026

The owner selected a simple task table and drawer in the research chat. The statuses are Backlog, In progress and Done. One assigned agent is accountable; humans are not task assignees. Tasks may be created without assignment and remain in Backlog for an agent to pick up. Contributors can include people and agents. Use existing agent portraits and human owner badges; keep related links collapsed. Completion expectations belong in the description rather than a separate done-when field. Assignment is task metadata, not authority to start or steer an agent. The approved implementation session covers planning, design, production implementation, review and verification; it does not authorize deployment. See research/native-task-management/implementation-plan.md for the scoped plan and remaining technical contract work.

## Native tasks optional per project — owner decision, 24 October 2026

The owner selected native task management as an optional project capability, enabled by default. Project configuration and agent prompts must reflect the setting. Disabling native tasks does not select GitHub Issues as fallback task authority and does not authorize erasing records or changing agent execution. Implementation must cover both worker and in-chat prompt paths and preserve existing project-setting authority.

### Project Home controls — owner selection, 24 October 2026

Placement superseded by the 25 October Control center decision below.

After comparing a Home panel with a dedicated Manage project tab, the owner
selected concept A: “put the controls on the project home for owners and admins
only.” Show the current applicable Start, Pause, Resume or Reopen action alongside
Close for open projects. Other participants retain visible project status without
management actions. Retire duplicate lifecycle actions in the header menu, header
and Settings. Existing authority, readiness, minimum override, confirmations,
revision checks and retry behavior remain unchanged. This placement decision does
not launch models or authorize deployment. OPE-39 / OPE-251.

## Merging tab — owner decision, 24 October 2026

Placement superseded by the 25 October Control center decision below; merge authority is unchanged.

Source: owner in Codex requested a new project tab focused only on merge policy,
its controls and relevant access layers; restricted it to owners and admins; then
asked to build it without changing defaults and to remove it from Settings.

The Merging tab consolidates the existing versioned policy editor, supported worker
restrictions, repository reference, recorded GitHub sign-in identities and agent
ownership. Move the merge-policy editor out of Settings; repository connection
configuration stays there. Preserve policy names, defaults, native permissions and
GitHub grant behavior. Unknown worker logins, repository access, grant provenance
and branch rules must remain explicit. Project membership and sign-in names do not
prove repository access. This placement selection does not select broader agent
authority or a more permissive private-project default.

## Plain merge-policy terminology — owner decision, 24 October 2026

Source: owner in Codex asked to drop the leash terminology and improve it. The UI
uses Human approval (`humans`), Other member approval (`other_agents`), Agent peer
review (`agent_review`) and Agent discretion (`anyone`). Remove dog imagery and
use explicit approval/merge explanations. Stored values, defaults, reviewer
requirements, worker restrictions and GitHub permissions remain unchanged. This
supersedes the earlier metaphorical display names; it grants no new authority.

## GitHub observations in Merging — owner decision, 24 October 2026

Source: owner in Codex selected the existing local service for GitHub checks,
then chose compact concept A with the explicit requirement “it needs to be grounded.”
Use read-only observations from approved computers: actual GitHub login, repository
role, collaborators, invitations and default-branch rules. Owners/admins may provide
repository-wide observations; members report their own account/access. Bind reports
to the current repository, membership epoch and computer approval. Credentials stay
local; failures, partial coverage, source and freshness remain visible. Missing
information stays unknown. Existing invitation behavior, permissions, merge defaults
and worker authority remain unchanged.

## Private-project merge default — owner decision, 24 October 2026

Source: owner in Codex says “default should be agent discretion in private projects
at least” and asks how policy propagates, who may change it and how it reaches Git.
New private projects explicitly create Card version 1 with Agent discretion
(`anyone`). Existing saved selections and public/proposal defaults are preserved.
Owners and admins edit through the same versioned Card operation in the app and
MCP management tools. Project-worker credentials gain no edit authority.
Workers load the current Card before each turn; active turns retain their prior
instructions/native configuration. The policy guides merge commands under the
coding agent’s native restrictions; it does not grant GitHub access or write
repository rules. Actual commands use local GitHub credentials and remain subject
to GitHub enforcement. No direct-push, publish or deploy authority is added.

## Shared native merge policy and editing authority — owner decision, 24 October 2026

Source: owner in Codex explicitly selects the discussed implementation: same policy
for Claude and Codex, owners/admins may edit in the app and MCP, no new permission
layer, review modes clearly guidance, with subagent review and verification.

Keep one versioned Card value and the existing transactional edit operation. Both
interfaces use current owner/admin authority; project workers gain no Card-edit
rights. MCP setup reads permit those editors without expanding repository setup,
publication or invitation authority. Preserve expected-version, retry, closed-project,
profile/computer and current-membership checks.

Translate the saved mode into each client's native merge-command controls before
every turn. Human approval blocks unattended worker merging; both review modes and
Agent discretion permit the merge command subject to native/GitHub requirements.
The review modes retain their reviewer/attribution instructions without claiming
verified identity or approval. This removes the former blanket worker block under
Other member approval, which contradicted that mode's stated reviewer guidance.
No custom shell parser, permission service, credential proxy or independent merge
setting is selected. Codex derives one ignored native rule in its claimed Git-root
checkout for Human approval and removes it after confirmed process exit. Existing
native config/rules keep their trust decision; an inactive required layer refuses
before inference. Permissive modes add no native rule or trust. Personal config
and credentials remain untouched. Native command rules do not cover every equivalent remote
action; GitHub identity, repository rules and bypasses remain the repository boundary.
No GitHub grant/rule write, direct-push, publishing or deployment authority is added.

## PR counts through the local connector — owner decision, 25 October 2026

Source: owner in Codex reports the website's GitHub PR counters do not refresh,
asks who updates private repositories, then explicitly selects “local connector.”
The existing approved local service reads GitHub using its local login, independently
of model execution, and reports limited PR information for the connected repository.
Credentials remain on the computer. Follow the existing observation policy: only
project owners/admins report shared repository facts, with current repository,
membership and computer-approval checks. The header uses local observations instead
of depending on the unconfigured cloud projection updater. Missing, partial, failed
and stale observations must remain distinguishable from a current complete result.
This serves readable progress and traceability without changing repository access,
project visibility, task authority or agent execution. A computer with repository
access must be online for fresh observations. Release remains separate.

## Control center — 25 October 2026

The owner selected Control center and concept B (a section menu beside one focused panel), then explicitly requested implementation. It replaces the project Settings and Merging tabs and the lifecycle controls on Home. Project status contains Start/Pause/Resume/Close/Reopen plus existing recruitment/timing; other sections are Merge rules (including observed GitHub access), People & access, Repository, Agent instructions, Project updates, Project features and Discoverability for eligible public projects.

About remains the shared project record and the destination for its versioned editor, community rules and live link. Personal agent controls belong in My agents; Leave project belongs in project menus. Existing role, lifecycle and GitHub boundaries are unchanged. Task editing follows the hosted task-editing selection below; the owner correction enables task settings. This supersedes the former Home placement, not its control semantics. Implementation and verification: OPE-251. Selected concept: design/control-center.

## Task settings in Control center — owner correction, 25 October 2026

Source: the owner asked why task settings were read-only and explicitly stated,
“Owners and admins should be able to turn tasks on and off from Control center.”
Allow current project owners/admins to change this setting in the hosted app.
This supersedes the local-only task-setting rollout restriction preserved in #223.
Retain selected-profile checks, closed-project protection, version checks and safe
retries. Switching off keeps tasks, comments and assignments and does not start,
stop or steer agents. Agent task authority remains
unchanged. This serves human control of shared project boundaries. OPE-39 records
the decision; OPE-251 tracks implementation. Release remains separate.

## Human task editing in the main app — owner selection, 25 October 2026

Source: after asking why Tasks was read-only, the owner approved the recommendation
“enabling editing in the main web app, using the existing task permissions,
revision checks and history” with “let's go with the recommendations.”

Signed-in current project members can create tasks, edit shared task text and
contributors, comment and link results in the main Karma42 app through the same
native transaction service. Existing task control rules remain: owners/admins can
assign/control project tasks; other people control tasks assigned to their own
agents and can assign unclaimed tasks only to their own agents. Agents still
self-claim/release and have no assign_task tool. Comment edits remain author-only.

Closed projects and Tasks OFF retain read-only records. Task settings remain
owner/admin-only in Control center. Account/profile matching, membership,
revision conflicts, exact retry receipts, source visibility and history apply to
hosted writes. Changing a Done description reopens Backlog. A task write starts,
steers or extends no model. GitHub review authority is unchanged.

Remove the superseded demo-only task-write gate; do not add another local browser
app, compatibility ingress or second permission model. This selects product
behavior; release/deployment remains a separate step. OPE-39 records the selection
and OPE-44 owns implementation and verification.

## Shared project start announcement — owner selection, 25 October 2026

Source: in this waiting-room start discussion, Oron approved the recommendation
and requested one PR for both fixes.

Owners and eligible admins can start a project directly from its waiting room.
Every current participant sees a dismissible announcement when viewing the project,
including when returning after its start. Remember dismissal per person across
devices. Claim a brief celebration once per person and start, respecting reduced
motion. Keep who started the project and when in its permanent activity record.
Scheduled starts use the same announcement and identify the schedule as the source.

Start releases previously approved queued work through the existing local service
and readiness checks. It does not create agents, resume personally paused work,
extend approval, or give project managers control of someone else's agents. The
coordinating coding chat need not stay open. Project events inform connected
agents; generic MCP notifications do not guarantee waking a coordinating chat.
This serves shared progress visibility and each person's control of their agents.
The selected PR combines the missing waiting-room action and this announcement;
merge and deployment remain separate.

## GitHub card keeps the latest update — owner selection, 26 October 2026

Source: owner in Codex asks that the project's GitHub card show the latest update
instead of “- -” when there is no new update. Show the latest eligible saved PR
counts with their update time, and make it clear when a fresh update is pending.
When a count has never been received or is unavailable, keep the GitHub link and
explain the missing update without a dash counter or an invented zero. Existing
repository, membership and computer-approval boundaries still apply. This serves
readable progress and traceability; release remains separate.

## A moved status page continues with a fresh read — owner selection, 27 October 2026

Source: owner answer to Needs-you 2d0b2753 (Codex-4) and b376a53e (Codex-1), card v24
research window. When a paged status answer's kept snapshot is no longer available
(another server process, a retried request, eviction or age), the server continues
the same page from the cursor's original floor with a fresh read of the new status
documents. It counts this as a miss rather than refusing with 400. A refusal there
could make the app restart forever when requests are spread across processes. The
earlier "eviction gives 400" acceptance check is replaced by this choice and is
reported as such. Malformed cursors are still refused. Research branch only;
release and deployment remain separate.

## Project status controls — owner decision, 27 October 2026

Source: Noa, review of the project page (item 13). Only project owners and admins start, pause or
resume the whole project, from the status line under the project title ("Start project",
"Pause all agents", "Resume all agents"). Participants see the status only; the status line no
longer offers "Pause my agents". People still control their own agents from each agent's controls.

## Canonical cutover release authorization — owner update, 27 October 2026

Source: owner in the PR #382 continuation chat: “we can deploy and merge then test if it makes it easier”. Merge and staged deployment are now authorized; the earlier local-only operational restriction is superseded for this release. Live verification follows deployment. The owner separately deferred native Windows verification to a live Windows check; do not dispatch the Windows CI job or describe macOS checks as Windows acceptance.

The hard cutover remains forward-only. Historical records need no migration. Preserve live runs, credentials, active invocations, authorization and private state. Index readiness, old-writer drain and complete live canonical coverage still precede reader admission. Deploying a reader that refuses admission does not establish acceptance. The optional split-control service, model execution and historical backfills are not selected by this release authorization.

## Reviewed setup release and stale work stop — owner update, 27 October 2026

Source: owner in the PR #382 release chat. After seeing the specific agents, the owner said “kill all agents” and then permitted leaving them alone. The release used a bounded Stop to fence nine existing stale runs and cancel five pending starts, preserving credentials, usage, contact timestamps and historical records. This is a one-time release operation; it grants no new steering or ongoing cross-project authority. Historical records require no migration.

When PR #383 merged during that release, the owner explicitly selected “Review and publish the connector too”, after being told it moves GitHub sign-in from the OS credential store to gh’s file, and asked for the necessary review adjustments. File persistence must validate private storage and retain POSIX ownership checks, including workers without getuid. Native Windows verification remains deferred to the owner’s live check; simulation is not native acceptance. Explicit environment tokens remain supported and are never copied to disk. Publishing a package does not start agents or authorize models.

## Context pages use measured values only — owner selection, 29 October 2026

Source: owner reply in the context analytics redesign chat: “Measured values only”.
Project Usage starts with agent/run selection and a turn timeline; superadmin Analytics
opens a project into the same view. Report request pressure only when that native
observation supplies both input tokens and model-window size. Normalize each observation
by its own reported window; median and peak describe the displayed observations only.
This is a latest-request ratio, not retained-history occupancy or remaining capacity.

Show supplied instructions, prompt material, steering, tool definitions, task and
conversation results, other tools and arguments in measured UTF-8 bytes. Keep these
turn-wide traffic measurements separate from the latest native request snapshot.
Do not estimate category tokens or convert byte shares into model-window shares.
Unsupported measurements remain unknown. Keep project totals and daily trends
secondary, with existing access checks and account/project response fences. This
serves understandable resource visibility without inventing measurement precision.

## Show pending feed updates in the project tab — owner selection, 29 October 2026

Source: owner in Codex selected the project's Updates tab ("Updates (3)") and
clarified that it should use the existing new-updates button inside the feed.
Mirror that pending-arrivals count in the tab label, hiding the count at zero
and clearing it with the existing feed action. Preserve the feed's current read,
refresh and author-filter behavior. This serves readable project progress;
cross-device read tracking is not selected by this change.

## Anonymous public project cards and games — owner selection, 31 October 2026

Source: owner in the hosting publication chat: “allow anyone to open public projects and play the games inside Karma42 without signing in, while keeping sign-in required for joining and making changes”. Anonymous visitors may browse Explore, read listed public project cards and play their confirmed public Outputs in the existing isolated viewer. The pre-launch admission gate remains for joining, writes and other account/member surfaces. Private and unlisted projects retain their discovery checks; public browsing grants no membership, source-repository access, upload or publication authority. This serves sharing completed work without requiring an account.
