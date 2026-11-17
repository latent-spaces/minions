# Shared UI: preserve the current design

Extract existing controls incrementally before changing their appearance. Product
components live here; presentation previews reuse them. No second implementation
or new visual theme is needed for extraction.

`theme.css` owns the shared baseline colors and typography. `../styles.css` keeps
the native button rules and the `.primary`, `.soft` and `.danger` styling.

`Button.tsx` is the shared native button boundary. Use `<Button>` with the same
HTML attributes, `className`, events and React 19 `ref` as the existing button.
It adds no DOM wrapper, classes, CSS or default `type`: an omitted `type` retains
native submit behavior, and explicit `type="button"` remains explicit. Existing
disabled, pressed, focus and form behavior is preserved.

For example: `<Button type="button" className="primary" disabled={busy}
onClick={save}>Save</Button>`. Keep page actions and permission decisions in their
existing controllers. Do not invent style variants during this extraction.

`Dialog.tsx` is the shared native dialog boundary. It forwards HTML attributes,
events and React 19 refs without wrappers or added styling. Modal opening, closing,
focus and lifecycle handling remain with each consuming controller.

## Personal project overview

`PersonalProjectGroups` groups the current bounded directory page into Projects I own,
Projects I joined (any role other than owner) and Waiting for approval (proposals, plus
owned projects that are approved but not yet published), shown in one grid. Two chips, All and Archived,
switch between the current and archived lists and count this page's projects that match the search. Each entry is
an `ExploreProjectCard` with the role as its category and its cover: the screenshot on the project's newest update, else its reference image, else the gradient. The existing
lifecycle presentation supplies its status, action and destination: the proposal editor,
Settings or the project's Tasks page. The card's ⋯ menu holds the star, Project settings
for owners or Leave project (which opens Settings) for private joined projects, Copy
project link and Archive for me. A proposal's menu holds Open proposal and Archive for
me. Archived cards drop Archive for me and show a Restore button instead.

In the Current view, Projects I own starts with the dashed `ClaudePromptTile`: the example
prompt for starting a project from a coding agent, with Copy and Edit. With no projects it
is the only thing on the page (the website has no create
screen). The component never fetches or saves
project data; archiving and starring arrive as callbacks.

## Project cards

`ExploreProjectCard` is the one project card for My projects and onboarding.
Its swatch shows a `cover` image when given one, otherwise `projectGradient(projectId)`, which the project header cover,
the stamps without a cover and Starting soon also use; the setup modal
seeds it from the draft name. Real cards use the immutable project ID, so renames keep
their gradient; onboarding and previews use explicit synthetic IDs. Onboarding passes a category icon from `CATEGORY_ICONS` in `project-look.ts`; personal
cards pass `icon={null}` and have none. A private project shows a lock on the swatch,
and My projects cards add a ⋯ menu.

Under the swatch sit, top to bottom:

- the category or role, the title and a two-line summary;
- one meta line: the status tag (on My projects cards its help is its tooltip and
  screen-reader text), Minimum reached on an open project that has met it, then the
  visibility or people label, such as People unknown;
- the seats while recruiting: a 4px bar, `2/4` and the time left to the start date;
- a thin outlined action button at least 44px tall.

The action reads View project unless the caller passes a label; My projects passes the
lifecycle action, such as Continue proposal, Publish project or Open project. Cards show
no cover images, captions, initials or calendar block.

The title button stretches over the whole card, so the card opens from anywhere; the
action button sits above it and keeps its own click. On hover or keyboard focus the swatch folds from 92px to
40px and the white grows while the card keeps its height; reduced motion turns the fold
off. Grids hold 4 cards a row, 5 when the section is at least 1080px wide; below a 900px
viewport they hold 2 from 560px and 1 below. `ClaudePromptTile` is the dashed, card-sized button
that copies the example prompt.

`catalogProjectPresentation` maps catalog projects through the same lifecycle
presentation as personal cards, as seen by a guest, so card labels follow the existing
project status rules.

## Agent details

An agent page (`Detail` in `Agents.tsx`) has a header (photo, name, coding tool, model and
the day it was added), a status line with when the agent was last heard from and its focus,
its Tasks, and Usage and Persona side by side. The person the agent works for also gets one
run control (Start, Pause or Resume) and a ⋯ menu with Local environment and Remove agent.
Communication limits are a project setting only (Settings).

Usage is one line (output and run time); opening it shows input, total, cache and tool calls.
The Persona panel (`AgentPersona.tsx`) is one menu: Clean default (empty text), Build,
Review, Share progress, Project rules and Custom. Choosing a preset saves it; Custom shows
a text box with Save. Each preset with text has a ? that shows the exact text it adds to the
agent's instructions. Only the person the agent works for can change it, while the agent is
not removed, is on their current connection and the project is not closed; everyone else sees
the choice's name. The stored value is optional plain text of up to 2,000 characters, not a
role or permission. A reread never replaces unsaved or pending text; an unconfirmed save
keeps Retry, and after an error Load saved persona rereads it.

Steering is submitted through the shared local service from the coding chat. New steering is recorded in member-visible Conversations before delivery; hosted Conversations is read-only.

## Notifications bell

`NotificationsBell` sits at the foot of the menu, as a Notifications row, and its popover
opens upward when there is more room above it. There is no top bar (owner, 11 November
2026); on phones a slim row keeps only the menu button and the logo. Its badge counts open Needs you requests plus unread
updates and disappears when nothing needs the reader and every update is read. The popover
has two keyboard-accessible tabs (`role="tablist"`, arrow keys, Home/End), each with its
count; it opens on **Needs you** while anything waits there, otherwise on **Updates**.
The header row holds **Notifications** and, on Updates, the text button **Clear all**; the
tabs sit below it with their counts as small grey pills, hidden at zero. Every row has an
ink unread dot, an avatar or grey system icon, one sentence ("**Agent** needs your answer:
title" or "**Moderator** requested Pause for **Agent**: reason", clamped to two lines) over
the project name, and a compact age on the right (now, 5m, 3h, 2d, then the date).
Needs you lists open requests, newest first; they leave only when answered, so they have
no Clear. Updates lists unread moderation notices: opening a row marks it read and opens
that agent; its small X (`Clear <reason>`) marks it read in place; **Clear all** calls
`POST /api/owner/notifications/read-all`, which marks every unread notice read, not only
the loaded page. The footer link **View all requests** shows on Needs you only. The empty
Updates tab reads "You're all caught up". Controls are text-only or thin white, never filled.
The bell and the Needs you inbox share one read of the open requests (React Query,
`use-needs-you-page.ts`): one poll and one realtime refresh. The shared response is held
only while a view shows it and is dropped when the account changes.

## Project-management requests

Project-management reads (GET) have no request budget: the engine serves one owner on
this computer, and reloading or switching tabs must never be refused. Writes have 60 per
minute per person, and a refusal returns `rate_limited` with Retry-After. The web transport (`authorized-request.ts`) shares identical in-flight
management GETs for one account, profile and path. After a 429 it holds every management
read for that account until Retry-After passes (60 seconds when absent, at most 5
minutes). It caches no completed response and never replays writes. Worker and steering
panels keep their loaded information while throttled; new steering sends wait for a
successful read.

## Project home

The project's main page is Tasks (the `overview` route section; there is no Home tab). It is the same for private and public projects, before and after start. Before start,
`ProjectStatusPanel` says who starts the project, and the activity feed appears only
after start; private projects disable the other tabs for everyone except the owner
until start. Before and after start, Tasks shows the project cheat sheet (below).
There is no people
list, role control or invitation entry: Minions is for one person and their agents.

## Member project home

There is no project-start notice. The server keeps one start
record per project (who started it and when; scheduled starts share it), which the
status panel reads. No browser observation launches work.

The project's sections are Tasks, Communication, Preview, Teams, Agents, Usage and Settings
(`PROJECT_TABS` in `App.tsx`; each hides when its feature or the viewer's role rules it out).
They are links in the menu, below New task and above My agents; the header has no tab row.
Preview gets a New dot (`k42-nav-new`, named "Preview, new") when its page changed since this
person last opened Preview in this browser (`preview-seen.ts`).
My agents shows only the rows that fit the menu's remaining height (agents that need you
first); the rest are behind "+N more", a popover list, so the menu does not scroll for them.
When not even one row fits, a strip of small avatars (named on hover) takes its place.

Requests for help live in Communication (owner, 12 November 2026): `Conversations.tsx`
pins `WaitingRequests` (`NeedsYou.tsx`) above the conversations, "Waiting for an answer · N",
and the menu link carries the count of open requests assigned to the viewer
(`k42-nav-count`; accessible name "Communication, N waiting for you"). Each `RequestItem`
is a short message: "Agent → You" with age and visibility, the question as the headline,
one paragraph (context, plus `attempted` on requests stored before that date), lettered
choices with "Something else…" typed inline, then Send answer. A card waiting on the viewer
is tinted butter; an answered card keeps its receipt until the page is left. There is no
project Needs you section; the global Needs you page (`view=needs-you`) lists requests
across projects, and the bell opens the request's project Communication (moderation
reports open the global page).
The New task dialog's Assign to is optional: a row of agent avatars, where hovering or
focusing one names the agent and its person, and clicking the chosen one unassigns it.
Project updates (`ProjectUpdatesFeed.tsx`) are not a tab: they fill a full-height right
panel (360–460px, growing with the screen) that runs from the top of the page, beside the header and every section. Started projects open the panel on Map. The Updates tab counts unseen posts while Map is selected; it clears when the latest post becomes visible, not merely when the panel mounts. The seen marker is browser-local, scoped to the account and project. A trailing + means earlier unread pages have not been loaded. Below 1200px the panel collapses to a button named for the selected view, with the same unseen count, and opens as a drawer. Hidden drawers do not mark updates seen. Waiting rooms retain their updates-only panel. Old `section=tasks` and `section=updates` links fall back to Tasks.

Avatars use transparent pose atlases and code motion. Occasional gaze lasts 10–15 seconds with a neutral gap, only while Idle, Waiting or Finished; a Working agent writes and a Talking agent speaks in short beats instead; blinking remains independently timed. Eligible pokes get a 420ms squash/stretch and select blink/bounce (55%), smile (20%), wink (15%), surprise (7%) or a three-pose cosmic face meltdown (3%, 1.2 seconds). Wild effects now come from pokes. See [the character asset guide](assets/characters/offbeat/README.md).
Each update is a photo-feed card (`ProjectProgress.tsx`): a small byline with how long ago, the
image, then a headline and one line of caption, and links as small pills. An update with up to
five images shows them as slides that swipe sideways, with arrows, a 1/5 counter and dots; every
slide takes the first image's shape, between portrait 4:5 and wide 1.91:1. An image the author
made carries a small Concept badge. Clicking an image opens it larger. A long caption from before
the 140-character limit is cut at 150 characters with "more".
Settings has an owner-only Updates card (`UpdateSettings.tsx`): how often (5, 15 or 30 minutes),
what to post about (results, blockers, decisions, summaries; at least one), Slides on or off (on
by default) and extra instructions of up to 1000 characters, saved together.

Tasks opens with a strip of setup notes (the waiting room, Add your agent, preparation),
then `ProjectTasks` on the left and the map on the right; when the main column is under
960px wide (a container query) the map goes under the tasks. With native tasks off, the page is the strip and the map. The sidebar's **Add
task** button, the project menu's primary (ink) action above My agents, goes to Tasks and opens the New task dialog: one prompt box
(its first line becomes the title, the rest the description; ⌘/Ctrl+Enter adds it), an optional assignee and Add; it shows only when Tasks is on and the viewer
can add tasks. A task created with an assignee is created first, then assigned; if the
assignment fails the dialog says so and offers Retry assigning. Below the assignee is
**Message to …**, prefilled with “Please take a look at this new task.” and required while
shown: it goes to the person's own agents only, so to the chosen agent when it is theirs, or to
all their agents in the project when the task is unassigned. The create request carries it
for an unassigned task, the assignment request for an assigned one. Another person's
chosen agent gets only the usual assignment notice, and the field is hidden.

Clicking a task opens its own page (`taskRoute` in `route.ts`, `task=` in the URL): the
strip and the map are hidden, and the page has Back (to the parent task, or to Tasks) and
breadcrumbs from the top-level task down. The page lists the task's subtasks with their
assignee and status, a done/total ring (done or canceled; pending proposals don't count)
and a quick Add subtask field. An agent's subtask is a proposal: it shows a Proposed badge
and, for owners, Accept and Decline. The list nests subtasks under their parent
(`nestTasks` in `task-model.ts`) with a collapse toggle and the ring; the board stays flat.

The list's controls live in its column headers: Task has a search icon (or press /) that opens
a search field in place, searching as you type; Assigned agent and Status are header filters
whose filter icon fills, with the chosen value as a pill, while set. Refresh, New task and the
List/Board switch sit beside the Tasks title. The board, and the list under 720px where the
headers are hidden, keep a slim bar with search and the filters. Title search is fuzzy
(`nativeTaskTitleMatches` in the contracts): case and accents are ignored, and every word must
match in any order, as text in the title or, for words of four or more letters, a title word
or its start one typo away. The server and agents' `list_tasks` use the same matcher.

On Tasks, `ProjectActivity.tsx` renders the lazily loaded
`ProjectCommunication` card (see [Conversations on
Tasks](#conversations-on-tasks)) once the project is set up. Before
setup, `ProjectHomePreparation` takes the card's place. the cheat sheet
(`ProjectCheatSheet.tsx`) lists the main things to ask a coding chat, one short copyable prompt per
action (`project-chat-prompt.ts`), starting with Add an agent; copying runs nothing. How each
prompt is done lives in the Minions guide, not in the prompt. It is the Tasks table with
each prompt in monospace and a copy button, opened in a popup from Cheat sheet in the project
menu. Tasks does not carry the table: while you have no agent in the project, `AddAgentNudge` shows
a small Add your agent reminder that opens it at Add an agent, until you add one or close it
(per project, on this device). `ProjectStatusPanel` sits in the project header above the repository
bar for every member. It shows Active with a timer, Paused, Ready to start (the owner; everyone else sees
Waiting for the owner to start) or Closed. Other people also see the job's end time and time left
there; the owner sees them, and adds time, only in the job bar above the Agents cards. It exposes
controls for the viewer's own agents and applicable project controls for the owner.
Only the project owner sees the lifecycle controls there: Start with the job length, then
icon buttons beside the project name for Pause all agents or Resume all agents, Close project, or
Reopen project when closed. Each icon names itself on hover and focus, and each action keeps its
confirmation. Existing readiness and owner-only below-minimum override still apply. Before start, non-owners see the waiting-room callout ("Waiting for people
and agents to join."); the project-started notice is one line ("Alex started the project") with
Got it. Notices and empty states keep a one-line headline and at most one short sentence. Settings
keeps project configuration only.

`ProjectHeader` shows the cover, stamp and title with no fact line or avatar strip under it
(owner, 26 October 2026); status cards such as a paused project still render there. Its
actions are Add agent, Copy project link (a public project's link, copied to the clipboard)
and the ⋯ menu. The repository bar shows the GitHub repository, Open PRs and Merged PRs and,
on the right, the project's reported token usage from `/usage` (`useProjectUsage` and
`ProjectUsageFigures` in `ProjectUsage.tsx`): Input excluding cache reads and Output. The
figures are hidden until an agent reports them.
`project-home.css` scopes the layout. 

In Project updates, the first shown update stays in place while someone reads and newer
updates arrive; a button counting the new updates, or being at the top when the feed
refreshes, shows them. Earlier updates load as the end of the feed comes into view, or
with Load earlier updates; a failed load offers Retry earlier updates. An agent author's
name opens that agent's page. Add update, hidden in closed projects, opens Add
project update. Every update needs an image (PNG, JPEG or WebP, up to 2 MiB) with a
description.

The project Agents section (`section=agents`) is the card directory, `CommunityDirectory`
with agents only; there is no separate My agents view. Above the cards the owner sees
`JobLimitsBar`, one row once the job has started and while the project is open: the job's
time left with **+ 30 min**, and the token cap with Set cap or Change cap and its exact-number
editor; the longer explanations are the values' hover text. Each of your own agent cards
has an icon-only Start, Pause or Resume in its corner (`AgentCardRun`), not in a closed
project or while the whole project is paused. Each card shows a status chip, the agent's focus as
the headline ("Last focus", dimmed, once it is not running) and one task: the one in progress,
else the most recently changed one assigned to it (the `/agents` row's `task`). Removed
agents are excluded, and the search matches name prefixes across the directory and is kept
in `q`. A card, or an agent link from conversations, updates or Needs you, opens the agent's
page. An agent that works with you in a chat shows Wake, Add time and End on its page
(`ChatWork`). The agent page's Back goes back in history when the app opened the page, and
otherwise to the cards with the same search. `parseRoute` keeps `agent` and `q` only on
Agents addresses.

Remove is available for your own agents in the ⋯ menu on the agent's page.
It permanently revokes project access and removes the identity from active lists,
counts, recipient discovery and the live map. Historical messages, contributions,
usage and direct detail links remain. The live graph uses the active roster and
current revocation observations; historical traffic cannot add retired nodes back.

The public reader's Agents
section shows the read-only `Agents` directory to signed-in viewers; guests see the
sign-in preview.

Web Add agent entry points are hidden in the project header, sidebar, Agents section
and communication map. People add agents through Minions MCP in their local coding
agent. The unmounted `AddAgent` dialog and existing creation APIs/runtime are retained
for this visibility-only change; accepted work continues normally. Revisit
the retained dialog when the owner decides whether web creation will return.
There is no computer approval page, connections card or computer picker: the engine's one
computer is implicit (owner, 15 November 2026). `npm run setup` sets up its coding agents and
GitHub, and an old `?view=owner-connect` link opens My projects. The global My agents page has been
removed; agents remain in their projects.

Page headings use `PathHeading`: a breadcrumb trail above a single h1. The trail starts
at Home, which opens My projects, followed by the route-backed parent levels. Separators are
decorative and levels wrap; on screens up to 700px wide only the direct parent stays in
the trail and earlier levels move into a menu. Levels navigate through `go` when it is
given and `routeBase` is not; otherwise they are plain links that check
`mayLeaveProject()` on click. `trail={false}` renders the h1 alone. Member project pages use
`ProjectHeader`: on pages that are not tabs its title becomes an h2, and, except on
agent pages, a trail-less `PathHeading` gives the page title. Global pages also use it. Section headings and
dialog titles stay plain headings.

### Shared project chat

`ChatTimeline.tsx` and `chat.css` present both the human and the agent timelines:
chronological scrolling, date separators, and safe Markdown and code.
`useChatHistory.ts` accumulates cursor-paged history and bridges missed refresh windows.
Signed-in project views refresh from shared authenticated realtime invalidations and
reconcile every minute while visible. Public chat outside the member workspace keeps its five-second refresh, including signed-in nonmembers. `chat-history.ts`
holds the shared ordering (creation time, then message ID) and merge rules.
`Conversations` owns the read-only agent conversation list and thread.

Authenticated browser updates use `/api/realtime`: Firestore query listeners shared
per server replica emit topic names, and the browser refreshes existing authorized
read endpoints. Each tab shares a stream per account/project plus an account inbox
stream. Tokens stay in headers. Account-wide invalidations apply the readers’ project membership and moderator checks before reporting activity. Hidden tabs close their streams; returning and
reconnecting invalidate current data. Events are coalesced, and failed connections
retry with backoff. Slow readers are disconnected rather than buffered indefinitely.

Subscriptions cover the latest 50 human messages and conversation entries, the
latest reaction change, the first 21 Needs you records per status/visibility filter,
unread notifications and the existing 16 canonical status revision shards. Loaded
older history is reconciled by reads, not an unbounded Firestore watch. Message and
Needs you inbox reconciliation runs every minute; the all-current blocker overlay retains its 15-second check for records outside the watched windows. Project-directory refreshes, unread
counts, presence, canonical status expiry/pause checks and external GitHub checks
retain their existing periodic checks. The communication frame refreshes from
events after its existing five-second cache window, with minute reconciliation.
The current-state endpoint remains the map's only status reader; events carry no
status values, execution commands or delivery acknowledgments.

User-facing contract:

- **Ordering and anchoring.** Both timelines show oldest at the top and newest at the
  bottom, and open on the latest page. Load older messages prepends; refreshes keep the
  loaded history and the reader's place. New messages follow the bottom only while the
  reader is already there; otherwise a Latest messages button (or "3 new messages")
  returns to the latest. The conversation list is ordered by latest activity.
- **Gaps.** When a refresh shares no message with the loaded history, it reads up to
  three older pages to close the gap and leaves the loaded history unchanged until it
  does. A larger gap shows "More messages arrived than fit in one refresh." with Load
  missing messages, so the middle of a busy conversation is never silently dropped.
  Reads time out after 15 seconds, and a refresh tick is skipped while an earlier read
  is still in flight.
- **Safe Markdown.** Messages show sender identity, exact-time tooltips on timestamps,
  accessible scroll regions, a Copy code button and horizontally scrollable code and
  tables. Raw HTML stays text, links allow only HTTP(S), and Markdown images become
  "(open image)" links, so nothing loads from an author-chosen image host until the
  reader opens it.
- **Drafts and sending.** Community chat keeps one draft per account and project in the
  tab's session storage. Enter sends and Shift+Enter adds a line, in community chat. A pending message
  shows "Sending…" or "Not confirmed · Retry the same message below.", and success is
  announced as "Message sent.". If the draft cannot be stored, the composer says "Draft
  could not be saved in this tab. Keep this page open." The full page's header notes
  "Messages here do not instruct agents."
- **Retry with the same request ID.** An unconfirmed send stays pending, and Retry
  message resends it with the same request ID. Only a definitive refusal (a 4xx other
  than 408 or 429) clears it. While it is pending, a send is never resent automatically
  or given a new ID.
- **Agent conversations** are read-only. Each message shows the agent, an AI agent badge
  and a recipient label (to a name, or to the whole project) that shows addressing, not
  proof of delivery, reading or action. Reading a thread sends nothing to any agent.
- **Scope and access.** Both chats remount for each account and project, so switching
  hides the previous history and conversation titles. In community chat and in an agent
  thread, a 401, 403 or 404 clears the loaded messages and shows "This conversation is
  unavailable or your access changed." with Check access again.

`ChatFeatures.tsx` supplies server-backed search (Search messages; not in the dock) and
Copy link in both chats, reactions and Reply in community chat, attachments,
linked-message context and unread counts. Community chat attachments open only for
current project members. An agent message links its owner only while that owner's
profile exists and has not been removed; the public projection carries no owner.

### Conversations on Tasks

`ProjectCommunication` is the communication map in the project's right panel, under the
panel's Updates / Map switch. The project live
link appears separately in Project updates.

Above the map is one toolbar row (owner, 26 October 2026): the All owners select, an
overlapping strip of the project's people and agents (each agent avatar carries its
owner's badge; past eight a "+N" chip), the Copy project link icon button on a public
project, then Zoom out (−), Fit map and Zoom in (+) on the right, and the full-screen
button. There is no 2D/3D switch: the product map is always 2D.

The card shows the live view only; it has no timeline or replay controls. Messages to
the whole project draw no connections.

The card reads these routes under `/api/view/communication`:

- `/api/view/communication` itself, with `range=recent`: metadata of the messages from
  the last five minutes, newest first, at most 500 rows, with full bodies only for the
  newest 30.
- `/traffic` (the map's connections), `/roster` (every agent) and `/agents` (states,
  below). [The communication map
  guide](communication-map/README.md#how-the-home-card-feeds-the-map) gives their page
  sizes, refresh times and error messages.

While Updates is shown, the card rereads its frame every five seconds. Every `/api/view`
request rechecks sign-in and membership; view reads have no request budget. A 429 on the frame keeps the loaded view, shows "Updates
will resume shortly." and waits for the Retry-After time (60 seconds by default).

`CommunicationMap` draws connections on a canvas and avatars in SVG, and fetches
nothing. Its layout worker, controls, message passes and data loading are described in
[the communication map guide](communication-map/README.md).

Avatars share the bundled offbeat 2D animal set (`character-set.ts`) with the
agent directory. Immutable agent IDs select faces independently of tool/provider;
owner IDs retain pastel grouping. `CharacterAvatar` renders fixed canonical
geometry and decoded lossless direction/reaction/action pose atlases; separate persona hats use crown/brim anchors.
Unknown owners use a neutral background and the same asset pool. People choose
one of four human characters, Robot or Alien in Settings, or keep a consented custom photo. The twelve animal agent identities remain unchanged. State and the latest
agent-authored focus come from `/api/view/communication/agents/current`, the map's only
status read: a first read, then the changes since the last one, every 15 seconds (see the
[map guide](communication-map/README.md#how-the-home-card-feeds-the-map)).
A state is the first of these that applies:

1. **Revoked**: the agent is revoked, or its owner is no longer an active member with
   the matching connection.
2. **Needs you**: an open request from that agent is assigned to the viewer, who owns
   the agent or the project. Other viewers never see it.
3. **Waiting**: the agent's start is still queued, including a website-added agent that
   its computer has not created yet.
4. **Stopped** or **Finished**: the run ended, or its worker session stopped, completed
   or passed its deadline.
5. **Working**, **Idle**, **Waiting**, **Paused** or **Blocked**: contact from
   the agent's current run within the last 90 seconds.
6. **Offline**: older contact from the current run. The browser also turns a live state
   Offline once its 90 seconds pass without a newer successful read.
7. **Unknown**: no contact from the current run, or no successful read yet.

If the read fails, the card shows "Current agent states are unavailable. Communication
history is still shown." The projection never includes request contents or private
steering messages. The Needs you check reads only whether a matching request exists,
using the service's `humanRequests` equality index.

Hovering or focusing an avatar opens a tooltip with its current status, its latest focus
with when it was reported, and its last contact. Clicking it, or pressing Enter or
Space, also highlights it; clicking again removes the highlight. Clicking a
connection opens Conversations at its latest message. Hovering or focusing a pipe
shows the first 160 characters of that message and an Open conversation link. The
preview uses the existing authorized message reader; bodies stay out of traffic
metadata and layout workers. Escape, a click outside, the mouse wheel or another
key press closes the tooltip. Drag the map to pan, or focus it and use the arrow keys
to pan. Use + or - to zoom and Home to refit; the Zoom out (−), Fit map and Zoom in (+)
buttons do the same. There is no agent switcher or automatic camera follow: inspect an
agent by hovering, clicking or focusing its portrait.

On the live map each avatar shows its state label and marker, and a working agent shows
its latest focus. The tooltip for one of your own
agents also offers its Start, Pause or Resume control. Dark charcoal-violet, thin rubber pipes retain
three minutes of direct-message history. A 1.4-second visual pass repeats every
3.6 seconds with independent pair phases, including traffic already sent. New
message IDs alone trigger avatar acknowledgments; visual replay never sends a
message. Physical attraction still decays with its 15-second half-life and ends
after 45 seconds, independently of pipe visibility. Under reduced motion no
passes are drawn, agents move
without easing and the working dot stops.

Full screen
opens the card as a modal dialog and asks the browser for full screen; Escape or Exit
full screen closes it. If the canvas or layout worker fails, the map shows Map
unavailable with Retry map. Viewing the map only reads; the run controls change project work.

Settings is one page. Its first card, Project, holds the project card: name, description and
rules (`CardSettings`, with version history), explained by a ? note beside the title. Everyone
sees them as text first; the owner's Edit opens the form, and Save or Cancel closes it. Members
and closed projects get no Edit button. The owner also gets three more cards: All agents
(`CommunicationLimits`, which every agent in the project follows), Updates
(`UpdateSettings`) and Features (Tasks and Teams toggles). Pause, Close and Reopen stay in the
project header. Each setting's
explanation sits behind an `InfoTip` ? button: hover or focus shows it, a click or tap keeps it open
until Escape or a click elsewhere. There is no Merge rules or Repository screen.

Usage's "Now · latest turn per agent" shows each agent's request as a share of its context
window, with the window size, when the agent reports them (Codex and Claude agents do;
others read "Not reported"). Minions's own setup (instructions and tool
definitions) is hatched, as in Karma42. There is no supplied-context-by-day chart, no
per-agent context timeline and no exact-values section.
