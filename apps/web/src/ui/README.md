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
prompt for starting a project from Claude, copied on click (the website has no create
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

The Persona panel (`AgentPersona.tsx`) offers Clean default (empty text), Build, Review,
Share progress, Community rules and Custom; choosing one fills in its text, and
nothing is stored until Save. Only the person the agent works for can edit it, while the
agent is not revoked, is on their current connection and the project is not closed;
everyone else sees the saved text read-only. The stored value is optional plain text of
up to 2,000 characters, not a role or permission. A reread clears old read errors but
never replaces unsaved or pending text. An unconfirmed save keeps Retry original save
for an exact retry, Discard edits and load saved persona appears after a pending save or
an error, and Reset to default saves empty text.

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

Authenticated project-management reads (GET) use their own 120-per-minute budget per
person; writes have 60 per minute, and a refusal returns `rate_limited` with
Retry-After. The web transport (`authorized-request.ts`) shares identical in-flight
management GETs for one account, profile and path. After a 429 it holds every management
read for that account until Retry-After passes (60 seconds when absent, at most 5
minutes). It caches no completed response and never replays writes. Worker and steering
panels keep their loaded information while throttled; new steering sends wait for a
successful read.

## Project home

The project's main page is Tasks (the `overview` route section; there is no Home tab, owner decision 11 November 2026). It is the same for private and public projects, before and after start. Before start,
`ProjectStatusPanel` says who starts the project, and the activity feed appears only
after start; private projects disable the other tabs for everyone except the owner
until start. Before and after start, Tasks shows the project cheat sheet (below).
[Selected concept](../../../../docs/design/waiting-room/README.md). There is no people
list, role control or invitation entry: MyLittleSwarm is for one person and their agents
(owner decision, 10 November 2026).

## Member project home

There is no project-start notice (owner, 11 November 2026). The server keeps one start
record per project (who started it and when; scheduled starts share it), which the
status panel reads. No browser observation launches work.

The project's sections are Tasks, Preview, Teams, Communication, Usage and Settings
(`PROJECT_TABS` in `App.tsx`; each hides when its feature or the viewer's role rules it out).
They are links in the menu, below Add task and above My agents; the header has no tab row.
The New task dialog's Assign to is optional: a row of agent avatars, where hovering or
focusing one names the agent and its person, and clicking the chosen one unassigns it.
Project updates (`ProjectUpdatesFeed.tsx`) are not a tab: they fill a full-height right
panel (360–460px, growing with the screen) that runs from the top of the page, beside the header and every section. Below 1200px the panel collapses to an Updates button at the bottom right that
opens it as a drawer. Old `section=tasks` and `section=updates` links fall back to Tasks.

Tasks opens with a strip of setup notes (the waiting room, Add your agent, preparation),
then `ProjectTasks` on the left and the map on the right; when the main column is under
960px wide (a container query) the map goes under the tasks. With native tasks off, the page is the strip and the map. The sidebar's **Add
task** button, the project menu's primary (ink) action above My agents, goes to Tasks and opens the New task dialog: one prompt box
(its first line becomes the title, the rest the description; ⌘/Ctrl+Enter adds it), an optional assignee and Add; it shows only when Tasks is on and the viewer
can add tasks. A task created with an assignee is created first, then assigned; if the
assignment fails the dialog says so and offers Retry assigning.

Clicking a task opens its own page (`taskRoute` in `route.ts`, `task=` in the URL): the
strip and the map are hidden, and the page has Back (to the parent task, or to Tasks) and
breadcrumbs from the top-level task down. The page lists the task's subtasks with their
assignee and status, a done/total ring (done or canceled; pending proposals don't count)
and a quick Add subtask field. An agent's subtask is a proposal: it shows a Proposed badge
and, for owners, Accept and Decline. The list nests subtasks under their parent
(`nestTasks` in `task-model.ts`) with a collapse toggle and the ring; the board stays flat.

On Tasks, `ProjectActivity.tsx` renders the lazily loaded
`ProjectCommunication` card (see [Conversations on
Tasks](#conversations-on-tasks)) once the project is set up. Before
setup, `ProjectHomePreparation` takes the card's place. the cheat sheet
(`ProjectCheatSheet.tsx`) lists the main things to ask a coding chat, one short copyable prompt per
action (`project-chat-prompt.ts`), starting with Add an agent; copying runs nothing. How each
prompt is done lives in the MyLittleSwarm guide, not in the prompt. It is the Tasks table with
each prompt in monospace and a copy button, opened in a popup from Cheat sheet in the project
menu. Tasks does not carry the table: while you have no agent in the project, `AddAgentNudge` shows
a small Add your agent reminder that opens it at Add an agent, until you add one or close it
(per project, on this device). `ProjectStatusPanel` sits in the project header above the repository
bar for every member. It shows Active with a timer, Paused, Ready to start (the owner; everyone else sees
Waiting for the owner to start) or Closed. Other people also see the job's end time and time left
there; the owner sees them, and adds time, only in the job bar above My agents. It exposes
controls for the viewer's own agents and applicable project controls for the owner.
`ProjectControlsCard` on Tasks shows lifecycle status and the
applicable Start, Pause, Resume or Reopen action, plus Close for open projects,
only to the project owner. Existing readiness and owner-only below-minimum
override still apply. Before start, non-owners see the waiting-room callout ("Waiting for people
and agents to join."); the project-started notice is one line ("Oron started the project") with
Got it. Notices and empty states keep a one-line headline and at most one short sentence. Lifecycle
controls also appear in the header; Settings keeps project configuration.

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
name opens that agent under All agents. Add update, hidden in closed projects, opens Add
project update. Every update needs an image (PNG, JPEG or WebP, up to 2 MiB) with a
description.

The project Agents section (`section=agents`) defaults to My agents: the Steer your
agents panel, a My agents / All agents filter, `MyWorkerControls` with the owner's
`JobLimitsBar` above the agent rows (the job's end time with Add time, and the token cap
with its exact-number editor; once the job has started, not in a closed project) and `YourAgent`, which lists your agents
here with status, focus and limits, and how much of the per-person agent limit you use.
All agents (`filter=all`) renders `CommunityDirectory` with agents only; each card shows
the agent's status. Removed agents are excluded, and the search matches name prefixes across the
directory and is kept in `q`. Agent links from
conversations, updates, Needs you and directory cards open the agent under All agents;
agent names in `YourAgent` open it under My agents. The
agent page's Back goes back in history when the app opened the page, and otherwise to
the list with the same filter and search. `parseRoute` keeps `agent`, `q` and `filter`
only on Agents addresses.

Remove is available for your own agents in Your agents and on the agent detail page.
It permanently revokes project access and removes the identity from active lists,
counts, recipient discovery and the live map. Historical messages, contributions,
usage and direct detail links remain. The live graph uses the active roster and
current revocation observations; historical traffic cannot add retired nodes back.

In a closed project My agents says the project is closed and read-only, and `YourAgent`
lists your agents without Add agent, Change limits or Remove. Before the owner sets up
the project, My agents says no agent can be added yet. The public reader's Agents
section shows the read-only `Agents` directory to signed-in viewers; guests see the
sign-in preview.

Web Add agent entry points are hidden in the project header, sidebar, Agents section
and communication map. People add agents through MyLittleSwarm MCP in their local coding
agent. The unmounted `AddAgent` dialog and existing creation APIs/runtime are retained
for this visibility-only change (OPE-230); accepted work continues normally. Revisit
the retained dialog when the owner decides whether web creation will return.
`YourAgent`'s Change limits dialog hands over a prompt for the coding agent, where
limits are chosen. Without an approved computer it shows `SetupCard` instead.
The **My computers** page, linked at the foot of the menu, (`MyComputers.tsx`) uses the shared
`MyComputersPage` list. It shows computer names, reported connection status and
approval expiry, with Revoke access as its only management action. The global
My agents page has been removed; agents remain in their projects. Revocation ends
the computer grant and every associated agent across projects. The confirmation
explains that background work stops when the computer receives the revocation;
external coding chats remain under their host's control. Interrupted server cleanup
stays visible with Finish revoking. Ambiguous older associations require verified
reconnection or project-level revocation before computer revocation can proceed.
Setup remains in Karma progress and the project connection flow.

Page headings use `PathHeading`: a breadcrumb trail above a single h1. The trail starts
at Home, which opens My projects, followed by the route-backed parent levels. Separators are
decorative and levels wrap; on screens up to 700px wide only the direct parent stays in
the trail and earlier levels move into a menu. Levels navigate through `go` when it is
given and `routeBase` is not; otherwise they are plain links that check
`mayLeaveProject()` on click. `trail={false}` renders the h1 alone. Member project pages use
`ProjectHeader`: on pages that are not tabs its title becomes an h2, and, except on
agent pages, a trail-less `PathHeading` gives the page title. Global pages and computer approval also use it. Section headings and
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
panel's Updates / Map switch (owner, 11 November 2026). The project live
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
request rechecks sign-in and membership and counts against one budget of 60 reads per
minute per person and project. A 429 on the frame keeps the loaded view, shows "Updates
will resume shortly." and waits for the Retry-After time (60 seconds by default).

`CommunicationMap` draws connections on a canvas and avatars in SVG, and fetches
nothing. Its layout worker, controls, message passes and data loading are described in
[the communication map guide](communication-map/README.md).

Avatars use the same bundled animal portraits as the agent directory
(`animal-family.ts`), with stable owner families/colors, a shared face-focused crop,
a thin silhouette outline and the agent's persona hat. Unknown owners use a neutral
background and the same current asset pool. State and the latest
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
connection opens Agent conversations, at the thread of a recent message from one agent
to the other when the card has one. Escape, a click outside, the mouse wheel or another
key press closes the tooltip. Drag the map to pan, or focus it and use the arrow keys
to pan. Use + or - to zoom and Home to refit; the Zoom out (−), Fit map and Zoom in (+)
buttons do the same. There is no agent switcher or automatic camera follow: inspect an
agent by hovering, clicking or focusing its portrait.

On the live map each avatar shows its state label and marker, and a working agent shows
its latest focus. The tooltip for one of your own
agents also offers its Start, Pause or Resume control. Each direct message makes one
1.4-second pass along its connection; connections fade with a 15-second half-life and
disappear after 45 seconds. Under reduced motion no passes are drawn, agents move
without easing and the working dot stops.

Full screen
opens the card as a modal dialog and asks the browser for full screen; Escape or Exit
full screen closes it. If the canvas or layout worker fails, the map shows Map
unavailable with Retry map. Viewing the map only reads; the run controls change project work.

The Control center Merge rules section is available only to the owner. It contains the
versioned merge-policy editor, supported worker restrictions and bounded access
records. Control center → Repository configures the repository only. `MergingAccess`
renders server-projected identities and explicit unknown GitHub access facts; it
does not fetch credentials or private agent environment reports.

Usage's "Now · latest turn per agent" shows each agent's request as a share of its context
window, with the window size, when the agent reports them (Codex and Claude agents do;
others read "Not reported"). MyLittleSwarm's own setup (instructions and tool
definitions) is hatched, as in Karma42. There is no supplied-context-by-day chart, no
per-agent context timeline and no exact-values section.
