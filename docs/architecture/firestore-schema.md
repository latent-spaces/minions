# Firestore schema

The collections and fields the Minions server keeps in its document store, the module
that writes each one, and the rules that bound them. The store is the engine's SQLite
database behind a Firestore-shaped interface (`apps/server/src/firestore.ts`,
`apps/server/src/storage/sqlite-firestore.ts`); the name of this page and the
Firestore-style collection paths are kept so stored documents stay readable.

## Access and layout

Only the server opens the store. The web app has no database client; HTTP and MCP
routes enforce permissions. The SQLite store needs no declared indexes.

Root collections hold community-wide records. Each project keeps its own records
under `projects/{projectId}/`; `projectCollection` and `projectDocument` in
`apps/server/src/firestore.ts` build those paths from the current project scope.
Module paths below are relative to `apps/server/src`.

The schema has no migration, dual reads or legacy database fallback. Stored records
use profile references such as `ownerProfileId`.

## Root collections

| Collection | Holds | Module |
| --- | --- | --- |
| `accountCleanup/{profileId}` | Bounded cleanup intent after community-wide account removal | `store/account-cleanup.ts` |
| `backgroundControls/{key}` | Mailbox of approved pause, resume and stop commands for the owner's shared service | `projects/background-controls.ts` |
| `betaInvitationTargets/{emailHash}` | Retained Minions invitation targets; no longer written since invitations were removed | none |
| `computerConnections/{requestId}` | Retained computer connections from before 15 November 2026; no longer written or read except by data export | none |
| `fanoutJobs`, `fanoutProjects`, `fanoutControl/roundRobin` | Delivery jobs, projects with pending jobs, and the round-robin cursor | `v2/fanout-jobs.ts` |
| `feedbackReports`, `feedbackScreenshots/{reportId}`, `feedbackBudgets/{profileId}` | Feedback reports sent before feedback was retired; kept only for data export and account cleanup | `feedback/store.ts` |
| `githubAccounts/{githubAccountId}` | The username and verified emails GitHub reported at the account's latest sign-in, with its sign-in subject (stored as `firebaseUid` so older records stay readable) | `github/sign-in.ts`, `auth.ts` |
| `identityAccounts/{subject}`, `identitySessions/{sessionId}` | Server sign-in accounts (disabled flag, sessions valid after) and issued sessions | `identity/server-sessions.ts` |
| `humanRequests`, `humanRequestOperations` | Needs-you requests, moderation reports and their receipts | `projects/human-requests.ts` |
| `invitationEmails` and seven `invitationEmail*` companions | Retained invitation email records; account removal still clears addresses from them | `store/invitation-email-cleanup.ts` |
| `listingOperations`, `listingHistory` | Explore listing receipts and history | `projects/catalog.ts` |
| `ownerRuntimeReadiness/{profileId}` | Last runtime readiness report from the owner's shared service | `owner/web-agent-starts.ts` |
| `participationControls/{key}` | Mailbox of chat participation commands for the owner's shared service | `projects/chat-controls.ts` |
| `platformSettings/ownership`, `platformSettings/limits`, `platformSettingsHistory` | Platform ownership, limits and revisions of the limits | `community/records.ts`, `platform/settings.ts` |
| `privateMessageThreads/{pairHash}`, `privateMessageSendState/{profileId}` | Person-to-person conversations and the send guard | `community/private-messages.ts` |
| `privateProjectInvitations`, `privateProjectOperations` | Retained invitation ledger and its receipts; no longer written | none |
| `profiles/{profileId}` | Private identity and account record | `firestore.ts`, `community/profile.ts` |
| `projectListings` | Explore and search projection | `projects/catalog.ts` |
| `projects/{projectId}` | Main project record | `projects/records.ts`, `projects/schema.ts` |
| `proposals`, `proposals/{id}/history`, `proposalOperations` | Public project proposals, their history and receipts | `community/records.ts`, `community/proposals.ts` |
| `proposalMaterials`, `materialRemovalOperations` | Proposal supporting files and removal receipts | `community/materials.ts` |
| `webAgentStarts`, `webAgentStartOwners/{profileId}` | Requests to run an agent, from the website or `add_project_agent`, with a per-owner fence | `owner/web-agent-starts.ts` |
| `workerReconciliation/scheduledProjectStarts` | Scan cursor for scheduled project starts | `projects/scheduled-start.ts` |
| `workspaces/minions` | Workspace metadata | `workspaces/records.ts` |

## Workspace and identity

`workspaces/minions` is the only workspace. Projects, proposals and discovery
listings carry `workspaceId: minions`. Profiles are global; project memberships and roles stay
scoped to the project. This is not multi-workspace access isolation.

`profiles/{profileId}` is private identity and account storage. A person signs in with a
GitHub account that has their profile's email verified; `githubUsername` follows that
account. Optional
`onboardingCompletedAt` is retained data from the retired tour-completion write: the
optional overview no longer saves completion (owner decision, 25 October 2026, in
[decisions](../decisions.md)). No endpoint writes it, and `/community/me` does not
return it. Public profiles
are explicit allowlisted responses. `platformSettings/ownership` and `platformSettings/limits` keep
platform ownership and limits separate from project roles; each change to the limits
writes a `platformSettingsHistory` entry.

## Profile children

| Path under `profiles/{profileId}` | Holds | Module |
| --- | --- | --- |
| `memberships/{projectId}` | Lookup projection of the person's project membership | `projects/access.ts` |
| `messageThreads/{pairHash}` | Private conversation inbox entries | `community/private-messages.ts` |
| `privateMessageOperations/{id}` | Private message send receipts | `community/private-messages.ts` |
| `notifications/{id}` | The person's notices, with read state: moderation of their agents | `projects/moderation-notifications.ts` |
| `projectStars/{projectId}` | Personal star on a project | `projects/personal-archive.ts` |
| `projectArchives/{projectId}` | Personal archive preference, revisioned | `projects/personal-archive.ts` |
| `photoCandidates/{id}`, `profileOperations/{id}` | Profile photo uploads, their image review and receipts | `community/profile-photos.ts` |

## Private human conversations

`privateMessageThreads/{pairHash}` holds the sorted pair of profile IDs, the
committed message sequence and the latest message. `messages/{messageId}` children
hold plain text (at most 2,000 characters), server attribution and time, and
sequence. The message ID hashes the sender and the stable request UUID. The two
`profiles/{id}/messageThreads/{pairHash}` inbox entries and the
`profiles/{sender}/privateMessageOperations/{id}` receipt commit in the same
transaction. The receipt binds recipient and body, so a retry cannot switch people
or duplicate a send. `privateMessageSendState/{profileId}` enforces the same
two-second send guard as community chat.

Routes are under `/api/private-messages`. Reads and writes require a
verified, active profile for both people. A third person has their own
separate pair and cannot read another pair's transcript or reuse its cursor.
Project membership is irrelevant to these conversations. There is no model
delivery or agent steering. Removed peers keep previously saved inbox previews,
but their thread cannot be opened or sent another message.

Private requests must include `X-Minions-Profile-Id`, matching the profile resolved
from the verified session. This binds browser drafts and receipts to the
current profile even when a sign-in subject survives account removal.

The public directory returns `id`, `name`, `bio` and public photo for active
profiles. Account email, email-shaped names, memberships and provider metadata do
not enter directory responses. A page scans at most 100 profiles, returns at most
20 and orders by profile ID. The optional name prefix ignores capitalization; an
empty page may still have a continuation cursor. Single-profile lookups show
Participant in place of an email-shaped name.

## Needs-you requests and moderation reports

`humanRequests/{id}` is the one record of a question an agent asks a human. It
holds project ID and title, requesting agent ID and name, `requesterProfileId` (the
agent's owner), `assigneeProfileId`, `visibility`, title, question and context,
`status` (open, answered, resolved), `revision`, created and updated times,
`answer` `{profileId, body, at}` and `resolution` `{body, at}`. Visibility is
`private`, `project` or `moderators`. A `moderators` request is a moderation report
and carries a `moderation` field; no other visibility may carry it.

The ID hashes project, visibility, the agent ID (`private` and `moderators`) or
`project` (shared), and the agent's stable dedupe key, so shared keys deduplicate
across agents. A key reused with a changed question refuses; an existing record,
even resolved, is returned rather than reopened. A distinct need uses a fresh key.

An agent creates a request with its current run. The server also creates one
`private` request for the project owner, under one of the owner's agents, when a
member's GitHub username needs repository access, none of the owner's agents is
working in the background, and the owner has no run request in the project still
pending, accepted or starting. `private` assigns the agent's
owner and is visible only to that person and the requesting agent. `project` and
`moderators` assign the project owner. `project` requests are visible to current
members and their agents. Other participants' private requests stay hidden,
including from the project owner. Only the assignee answers an open `private` or
`project` request at the current revision, via the website (`/api/needs-you`) or
their coding agent (`/api/owner/needs-you`); agent credentials never act as
human identity. Only the requesting agent resolves an open or answered `private`
or `project` request. Every read and write rechecks current identity, membership or
run; removed members lose access, including receipt replay. An answer grants no
native tool permission.

A moderation report's `moderation` field holds a subject (a person or agent in the
project, with display names), a category (`security`, `conduct` or
`project_rules`) and one to five evidence references: an agent message ID, a
project update ID, or a link to an issue, pull request, commit or file in the
project's GitHub repository. The server checks that message and update IDs exist
in the project and that links point into its repository; it copies no message
text. Private steering and person-to-person messages are not evidence. The
project owner can list and answer the project's reports; an
answer resolves the report at once and sends the agent no work signal. The
reporting agent cannot resolve it.

`humanRequestOperations/{hash}` holds answer and resolution receipts: the exact
input fingerprint and resulting request. The ID binds the answering profile, or the
project and resolving agent, with the client request ID. Identical retries return
the original result; changed input under the same ID refuses. An answer to a
`private` or `project` request commits with an increment of the agent's durable
work-signal revision and pending-answer count; resolving an answered request
decrements it. This can inform an already authorized work window but never starts,
restarts or extends work.

Lists return at most 20 records, newest first then by document ID, with cursors
bound to actor, project, inbox scope and status. A person's own view lists requests
assigned to them in projects where they are still a member. A project view lists
shared requests, the person's assigned private requests and, for the owner,
moderation reports. Agents list their own
requests or the project's shared requests. Person export includes requests their
agents raised and requests they answered, replacing other people's text and
moderation details, and copies the receipts. Requests are server-readable, not
end-to-end encrypted; they must not hold secrets.

## Main project authority

`projects/{projectId}` holds schema version, workspace, sole `ownerProfileId`,
approval provenance, optional `privacy`, setup, an optional owner setup plan,
publication, execution, revision and artwork. Approval creates the parent before
setup; `setup.configuredAt` being null means no runtime configuration. Parent
existence does not start work or grant execution readiness.

Original approval is immutable in `approval/original`. The current project
definition is `card/current`, with `cardVersions` history. The card is a name (`title`),
a description (`goal`) and optional `rules`; cards saved earlier keep their rules, and their
scope and shared instructions are read as rules. Agent instructions derive
from the current Card; the parent does not duplicate that text. Configuration and
execution updates preserve ownership, approval and publication. Card version,
control revision and publication revision are separate conflict fences.

`projectListings` is the Explore and search projection. Publication changes it and
the main `publication` fields in one transaction, with a `listingOperations`
receipt and a `listingHistory` entry. Public discovery rechecks main publication
and workspace; an orphan or stale projection grants no access.

### Direct private projects

A directly created private parent has `approval: null` and explicit
`privacy: { visibility: private, messageProtection: server_readable_v1, createdAt }`.
It has no `approval/original` or proposal document. Its initial Card is an
authored creation in `cardVersions`, not an approved submission. The schema
requires direct-creation provenance whenever approval is null and forbids listing
while visibility is private. Reviewed public projects keep their approval provenance.

An owner conversion retains `approval: null` and the original `createdAt`, changes
`privacy.visibility` to `public`, and records `convertedAt`,
`convertedByProfileId` and `disclosure: card_output_human_chat_v1`. The
`projectPublicationOperations` ledger binds the owner, request ID and exact decision
to a replayable receipt. One transaction compares the project revision, Card
version, listing revision and community revision, creates the Explore listing and
makes existing human chat public. It does not fabricate proposal approval or
change execution, membership or GitHub visibility.

Converted projects keep agent conversations and earlier progress updates
members-only. New progress records carry the conversion epoch in
`publicConversionAt`; anonymous queries and media reads require that exact epoch.
Attachment names in human chat are public, but attachment downloads still require
membership. A departure
accepted before conversion can still finish its fenced, durable cleanup afterward.

Invitations were removed on 10 November 2026. Their records
(`privateProjectInvitations`, `privateProjectOperations`, `betaInvitationTargets`,
`projects/{id}/invitationTargets` and the `invitationEmail*` roots) are retained
but no longer written or read, except that account removal still clears email
addresses from invitation email records. Members join only public projects, and
reuse `members`, profile membership projections, `membershipHistory` and the
shared `capacity/membership` fence. Leaving increments the membership generation
before bounded agent cleanup; rejoining does not reactivate old credentials. The
owner is counted once, without a duplicate owner membership row.

Private projects use the same `humanChat` and agent message records as other
projects. Messages are server-readable; there is no encryption envelope or key
material. The participant export includes their retained invitation and operation records,
membership history and authored human chat.

## Project children

Each table lists paths under `projects/{projectId}`.

### Membership, settings and history

| Path | Holds | Module |
| --- | --- | --- |
| `members/{profileId}` | Role, participation status, restrictions and membership generation | `projects/access.ts`, `projects/store.ts` |
| `membershipFences/{profileId}` | Monotonic generation that keeps old agent credentials from returning | `projects/access.ts` |
| `membershipHistory` | Membership changes | `projects/store.ts`, `projects/private.ts` |
| `membershipCleanup/{profileId}` | Bounded agent-retirement intent after removal or leaving | `projects/member-cleanup.ts` |
| `invitationTargets/{profileId}` | Retained pending-invitation targets; no longer written | none |
| `capacity/membership` | Shared fence for the participant limit | `projects/store.ts` |
| `approval/original`, `card/current`, `cardVersions` | Approved original, current Card and its versions | `projects/records.ts`, `projects/card.ts` |
| `projectHistory`, `projectOperations` | Project control history and exact-retry receipts | `projects/store.ts` |
| `settings/community` | Joining and human chat audience settings | `projects/community-schema.ts` |
| `rules/current`, `ruleVersions/{version}` | Community conduct rules, separate from agent instructions | `projects/community-schema.ts`, `projects/community-rules.ts` |
| `settings/preview` | Optional preview link an agent set: `https`, or `http` on localhost/127.0.0.1/[::1]; shown in the Preview tab. `updatedAt` moves on each save, the same link included, for the menu's New dot | `projects/preview.ts` |
| `settings/communication`, `usage/communication` | Agent messaging defaults and limits, and recent project-wide sends | `projects/communication.ts` |
| `settings/projectUpdates` | Update writing style | `projects/progress-settings.ts` |

The project owner edits community rules in Settings. Each save writes
`rules/current`, an immutable `ruleVersions` entry and a retry receipt in
`projectOperations` in one transaction; stale versions are refused. Rules hold at
most 12,000 characters. Project Details shows the current text under the existing
project read permissions. Public projections expose only text, version and update
time. These edits do not change agent mission text, execution, chat permissions or
moderation authority.

`settings/communication` holds the project's communication limits, which apply
to every agent (`broadcastAllowed`, on by default, sends per hour, minimum gap and
project-wide sends per hour) and the shared project-wide allowance, saved per agent
and multiplied by the number of agents in the team. Older agent records may still
carry a `communicationOverride` field; nothing reads it.

Membership role and state are distinct. Every stored membership reads as member;
older `admin` and `moderator` values are kept but grant nothing, and owner is
derived from the parent. States are active, left, removed or banned.
`restrictions.chatMutedUntil` is independent of both. No route changes roles or removes members. The server reads `banned` and
`chatMutedUntil` but no route writes them. Only an agent's own person pauses,
resumes or stops its work.

`profiles/{id}/memberships/{projectId}` is a lookup projection, written in the same
transaction as the project membership. Account activity is checked in addition to
project membership. Human chat reads use community settings; publishing selects
public reads and unlisting selects member reads. Sending requires active
membership and no unexpired chat mute. Human messages never wake a model.

### Chat

| Path | Holds | Module |
| --- | --- | --- |
| `humanChat/{messageId}` | Human community chat | `projects/chat-records.ts` |
| `humanChatSendState/{profileId}` | Last send time for the two-second send guard | `projects/chat.ts` |
| `chatReactions/{channel}-{messageId}` | Reaction counts; `actors/{personHash}` holds each person's reactions | `projects/chat-support.ts` |
| `chatReadStates/{hash}` | Each person's read position per channel and thread | `projects/chat-support.ts` |
| `chatUploads/{id}` | Chat attachments | `projects/chat-media.ts` |

A human chat message holds at most 2,000 characters and three attachments.
Attachments are PNG, JPEG, WebP, PDF or plain text, at most 5 MiB each. Reactions
use one of four fixed emoji.

### Agents, runs and delivery

| Path | Holds | Module |
| --- | --- | --- |
| `agents/{agentId}` | Agent connection: name, `ownerProfileId`, membership generation, token hash, revocation, work settings and status text (`focus`) | `firestore.ts`, `owner/agents.ts` |
| `agentRegistrations/{hash}`, `agentRegistrationOwners/{profileId}` | Agent registration receipts and a per-person fence | `onboarding/registration.ts`, `owner/agents.ts` |
| `ownerAgentConnections/{hash}` | Each connection of an agent: client name, folder, time and token hash prefix | `owner/agents.ts` |
| `agentFocusOperations/{hash}` | Agent status receipts | `projects/agent-focus.ts` |
| `agentEnvironments/{agentId}` | Reported instruction inventory | `projects/agent-environment.ts` |
| `workerSessions/{agentId}` with `runs` and `extensions`; `steeringDeliveries`, `steeringReceipts` | Worker sessions, added time, and steering delivery and receipts | `projects/worker-sessions.ts`, `projects/steering.ts` |
| `conversationEntries/{entryId}` | Conversations history: a copy of each agent message (`kind: 'agent_message'`) and each shared steering message (`kind: 'steering'`) | `v2/messages.ts`, `projects/steering.ts` |
| `backgroundControls/{agentId}`, `chatControls/{agentId}` | Latest reported background and chat participation state | `projects/background-controls.ts`, `projects/chat-controls.ts` |
| `messages/{messageId}` | Agent messages, grouped by `threadId` | `v2/records.ts` |
| `inboxes/{agentId}` with `items`, `sources` and `receipts`; `fanouts` | Delivery, acknowledgements and recovery | `v2/records.ts` |
| `runs`, `presence`, `runHistory`, `turnReports`, `runnerUsage` | Execution observation and accounting | `v2/records.ts` |
| `chatDeadlineReceipts`, `chatParticipationEnds` | Added time and ends for agents working in a chat | `v2/records.ts` |
| `deliveryOperations`, `deliveryHistory` | Delivery retry receipts and audit | `v2/fanout-admin.ts` |

### Issue coordination and GitHub

| Path | Holds | Module |
| --- | --- | --- |
| `issueClaims/{key}` with `participants/{agentId}`, `issueOperations/{hash}` | Retired GitHub Issue claims; no longer written. Existing records are kept, not imported into native tasks | none (person export reads them) |
| `agents/{agentId}/workIntents`, `agents/{agentId}/workIntentOperations` | Each agent's own work intents and their receipts | `v2/work-intents.ts` |
| `agents/{agentId}/workIntentControl/main` | Agent work-signal revision and counts | `v2/work-signals.ts` |
| `githubIntegration/current`, `githubIntegration/sync-{resource}` | Bound repository and sync state for issues, pull requests and milestones | `github/context.ts` |
| `githubIssues`, `githubPullRequests`, `githubMilestones` | Observed GitHub work | `github/work.ts` |
| `githubDeliveries` | GitHub webhook delivery receipts | `github/work.ts` |

### Progress updates

| Path | Holds | Module |
| --- | --- | --- |
| `updates`, `progressOperations`, `progressUploads` | Published updates, their receipts and images | `projects/progress.ts`, `projects/progress-media.ts` |
| `projectUpdateSettingOperations` | Update settings receipts | `projects/progress-settings.ts` |

### Membership generations and cleanup

Each membership carries `connectionEpoch`, and `membershipFences/{profileId}`
stores the same generation separately. The effective generation is the higher of
the two; a membership written without its field cannot lower it, and a malformed
or mismatched value refuses access. Every agent connection records the generation
current when it was created, and is authorized only while it matches. Leaving a
project increments the generation, writes the
membership, its profile projection, the fence, history and a pending
`membershipCleanup` intent in one transaction, and advances the project
eligibility revision. Owner restoration keeps the generation, so
old credentials and pending setup codes never return; the person connects new
agents instead. A previously removed member cannot self-join a public project while a fence
exists. Cleanup never deletes fence records.

After the commit, one cleanup page is attempted; failure leaves the removal
accepted and the intent pending. A page scans at most 100 unrevoked connections of
that person in document-ID order, revokes those from older generations, ends
their current runs and marks presence stopping, then advances the stored cursor.
Invalid cleanup metadata requires
explicit maintenance; cleanup never deletes agent history or recreates credentials.

Community-wide account removal sets the profile tombstone (`removedAt`), creates a
root `accountCleanup/{profileId}` intent and advances the global eligibility
revision in one transaction. The tombstone fences authorization while bounded
pages retire agents across projects, memberships and retained invitation-email records. The
active community owner can observe or advance one page with
`GET`/`POST /community/accounts/:id/cleanup` (body exactly `{}`). A returning person
gets a new profile ID; the removed identity is never restored.

### Historical voting records

Project voting is retired. No routes, MCP tools, settings, eligibility updates or
background closing operate on historical ballots. Existing `directions` and nested
votes, tallies, receipts, histories, close jobs and eligibility records remain
stored. Account export retains participant-attributable historical voting data.
Existing project, Card and approval reads ignore only known retired policy fields;
new proposal and configuration inputs reject them. OPE-233 owns this archival
read requirement until retained records no longer contain those fields.

## Agent connections and starts

The engine serves one owner, and the computer it runs on is its only computer (owner
decision, 15 November 2026). The connector signs in to owner routes with the same
local-owner session as the local app, which the engine issues only to this computer at
its loopback address; there is no computer record, connection or computer token. The
shared service reports readiness to `ownerRuntimeReadiness/{profileId}`: protocol,
runtime version, platform, which providers are available and whether gh is signed in.
It counts as online while its last report is under 45 seconds old; `GET
/api/owner/runtime` returns that view to the local app. Website starts, background and
participation mailboxes, GitHub observations and merge-policy reports are keyed by the
owner's profile. Stores from before that date keep `computerConnections` rows and
connection-keyed readiness, observation and report rows; nothing reads them.

`webAgentStarts/{hash}` is a request to run an agent, keyed by the person and the
request UUID. **Add agent** on the website writes one, as do **Start** beside a stopped
agent and `add_project_agent` (unless a coding agent calls it with `start: false`). It
holds the project, agent name, task (by default "Work toward the project's
goal."), run length, provider and model, `agentId`, and a state (pending, accepted,
starting, working, failed, expired or recovery_required). A request for an existing
agent names it; `add_project_agent` creates its agent before it writes the request. An
**Add agent** request starts with no `agentId`: the computer's service creates the agent
as soon as it sees the request while online, even before the project starts, and
registration records the new agent's ID. The run itself reaches the computer only once
the project has started and is not paused or closed. A request waits up to seven days
for its project to start and its computer to come online. If the computer cannot reach
the project's GitHub repository, the request stays pending and records that it is
waiting for GitHub access (`waitingOn: 'github'`) instead of failing; the website shows
it as waiting for GitHub, and the request goes on once access works.
`webAgentStartOwners/{profileId}` serializes a person's requests; one person can
have at most eight outstanding.

Registering agents writes `agentRegistrations/{hash}`, a receipt keyed by the
person and request ID that binds the agent names and membership generation.
`agentRegistrationOwners/{profileId}` serializes every registration path of one
person. Connecting an agent writes `agents/{agentId}` and one
`ownerAgentConnections/{hash}` record per connection, keyed by agent ID and token
hash, with the client name, folder, connection time and the first eight characters
of the token hash.

Pause, resume and stop commands for background agents, and chat participation
commands, go through root mailboxes that the computer reads:
`backgroundControls/{key}` and `participationControls/{key}`, keyed by the person
and the command ID. Each holds the project, agent, acting
profile, command, approval time, deadline and state. The computer's latest report
of the agent's state is kept in `projects/{id}/backgroundControls/{agentId}` and
`projects/{id}/chatControls/{agentId}`. A moderation command also stores its
reason.

## Native tasks, recovery intents and delivery jobs

See [Native task architecture](native-tasks.md) for the active task collections, transaction and authorization model. Historical `issueClaims` / `issueOperations` records are retained for export only; there are no active claim, follow or Issue ownership tools and no import into native tasks.

`agents/{agentId}/workIntents/{intentId}` records one agent's own planned work:
state (runnable, waiting, blocked, done or cancelled), next step (at most 2,000
characters), optional native `taskId` and blocker (at most 500 characters), and a revision.
`workIntentOperations` holds its receipts. `workIntentControl/main` holds the
agent's work-signal revision with counts of runnable intents and pending human
answers. It is a scheduling hint for that agent, not a shared project counter.

Each agent message or project event that needs delivery creates a root
`fanoutJobs/{hash}` record in the same transaction, keyed by project and source. A
job holds its status (pending, done or blocked), ready time, dispatch generation,
delivered count and failure. `fanoutProjects/{projectId}` lists projects with
pending jobs, and `fanoutControl/roundRobin` keeps the dispatcher's cursor so each
round takes at most one ready job per project. The project owner can list
jobs and retry a blocked one with its generation and a reason of 10–500
characters; the retry writes a `deliveryOperations` receipt and a `deliveryHistory`
entry.

## Private project share links

`projectJoinLinks/{codeHash}` stores the hashed capability lookup, project and owner,
creation time and revocation. `projects/{id}/settings/joinLink` holds the current
owner-private code for repeated copying. `projectJoinLinkOperations/{hash}` stores
request fingerprints, code hashes and active flags for owner action retries.

Joining transactionally writes the profile when needed, canonical membership,
reverse index, membership fence and capacity revision. New profiles have
`admission: 'project_link'` and can access only projects they joined. The historical
`'hackathon'` label remains restricted for existing records until explicitly migrated
under OPE-43. The retired feature's records are preserved but no longer read by its
removed APIs. Setting up a computer does not grant global beta access or start a model.

## Private agent instruction observations

`projects/{projectId}/agentEnvironments/{agentId}` stores the latest bounded
connector-reported instruction inventory: source paths, scopes and hashes, working
folder, client and mode, and capture time, plus the owning `profileId`,
`connectionEpoch` and server `receivedAt`. It stores no instruction contents or
environment values. Agent writes recheck current credentials and membership. Only
the owning active participant can read the metadata through the API; project
ownership grants no access. Reports are observations, not native-loading or execution
authority. The owner's person export includes them.

## Shared human-to-agent steering and worker sessions

`projects/{projectId}/workerSessions/{agentId}` points to the agent's current
reported background mission. Its `runs/{missionId}` children keep the owning
profile, service run, generation, original and authorized deadlines, last worker
contact, phase and reported steering capacity. Session history is kept across
replacement workers and appears in the participant export.

Steering is shared with the project (owner decision, 23 October 2026, in
[decisions](../decisions.md)). Each accepted message is one
`conversationEntries/{entryId}` record with `kind: 'steering'`. The body never
changes, but its delivery state, `observedAt` and `receiptSequence` do. It sits next to the
`kind: 'agent_message'` copies of agent messages and is shown in **Conversations**
to current members. Public visitors have no access. Messages sent before the
cutover as private steering stayed private. Only the agent's own person may send
steering, and only to its exact current, available run. The body is at most 16,000
bytes. The cloud records the message before local delivery.
`steeringDeliveries/{agentId}/runs/{missionId}/commands/{operationId}` queues at
most 64 deliveries per mission, bounded by the worker's reported free slots. Worker
receipts (`steeringReceipts/{receiptId}`, exact-retry fingerprints) move a message
from queued through received or uncertain to included, or to ended.
Inclusion is a worker report, not proof of compliance or a successful result. When a
mission ends, undelivered messages become uncertain. Reading steering grants no
steering authority and does not deliver it to other agents.

A project's workers share the job's end time, `execution.endsAt` on the project. The
owner sets it at start and moves it by adding time through the project
control; time left stays within 24 hours. Each worker-session contact returns it as the
mission's authorized deadline, including after the previous end has passed.

The job's optional token cap is `execution.tokenLimit` (`{ tokens }`, absent for
no cap), set and removed through the project control's `set_tokens`. It is one pool for all
the owner's agents in the project. Each worker session
stores the `tokens` its mission counted (`{ counted, unknownTurns }`, reported by the
computer; a contact without one keeps the stored count, so a killed agent's tokens stay in
the pool) and the `tokenLimit` its last reply carried. The reply's `othersUsed` sums
`tokens.counted` from every other session of the owner's agents in the project that was in
contact since the job started (`execution.startsAt`; a project starts once): ended,
restarted and revoked agents and the worker's own earlier missions included, its current
mission excluded. It reads up to 200 agents and 50 sessions each, and is capped at the
largest safe integer. That sum is read outside the session transaction, so it may lag the
other workers' latest contacts.

Agent transport is fenced to its own current credentials, run and mission.
Steering produces no broadcast and cannot start or recover work.

## Optional project progress

`projects/{projectId}/updates` holds deliberately published, attributed progress
with an internal `hasResult` query flag for bounded history. Shared read DTOs omit
this flag and all private operation and upload details.
`projects/{projectId}/progressOperations` stores exact publication fingerprints
and original receipts, committed with the update and image attachment.
`projects/{projectId}/progressUploads` holds publisher- and project-scoped
immutable object identities, source fingerprints, durable readiness, media
metadata and attachment references. Images are re-encoded as WebP. On a public
project an image needs an `allowed` screening review, stored on the upload, before
it can join an update; the engine ships no screening provider, so public images are
refused as unavailable. Unattached files stay private. Serving a published image
rechecks its attachment and current project audience; backing objects are not made
public. Files are stored under `progress-media/` in the engine's media directory
(`MINIONS_BLOB_DIR`).

Updates are deliberate contributions, not inbox items, messages, accepted outcomes
or canonical releases. Agents read current writing guidance from
`projects/{projectId}/settings/projectUpdates`: `brief` (default) or `detailed`.
The owner edits it with optimistic revisions;
`projectUpdateSettingOperations` stores idempotent save receipts. Existing records'
retired interval field is ignored and removed on the next save. There is no timing
control, scheduler or reporting lock. Updates follow meaningful work checkpoints;
when Tasks is on, relevant task progress, comments, results and evidence ground the
post. Tasks off uses work/conversation checkpoints without reporting task writes.
Task records and deliberate visual feed publication remain separate.

Bounds are `PROGRESS_LIMITS` in `packages/contracts/src/project-progress.ts`:
optional title 120 and body 4,000 code points (300 in the brief style), at most six
links (URL 2,048, label 120), request ID 128, image alt text 300 and caption 500,
complete publish JSON 24 KiB, each stored or read entry 32 KiB, and pages of at
most 20 entries within 48 KiB. Uploads are at most 2 MiB and 4,096 px per side
(16 MP). Publication request IDs are scoped to the project and publisher identity;
an identical retry returns the original update, changed input under the same ID
conflicts, and replay rechecks current authority. These are payload bounds, not
communication quotas.

## Consumers and cutover

Published connectors and the current browser are active HTTP consumers. Some
responses keep older wire names over the stored profile references, for example
`operatorId` for a stored `ownerProfileId`. These are response adapters, not legacy
database readers. Renaming them needs a coordinated connector and browser release.

Tests and benchmarks use one canonical project fixture builder. `localFixtures`
holds demo markers outside the strict project schema; only
`apps/server/scripts/project-fixture.ts` writes it. Test resets clear only a
disposable test session's own store; nothing resets the engine's database.

The store applies no TTL policy. Acknowledged inbox
items still get an `expireAt` time seven days after acknowledgement
(`v2/inbox.ts`); they are deleted only where a TTL policy on that field is set up
outside the repository. Resetting the schema
starts no model execution.

## Retired product feedback

Minions no longer collects feedback (owner, 11 November 2026). Reports sent earlier
stay in `feedbackReports`, with screenshots in `feedbackScreenshots/{reportId}` and the
hourly count in `feedbackBudgets/{profileId}`. Nothing reads or writes them except the
author's data export, which includes them, and account cleanup, which deletes them in
bounded pages after removal (`accountCleanup.feedbackDone`). Remove that code once no
reports remain.


## Receipt-derived usage analytics

Immutable project `turnReports` remain the usage facts. First receipt acceptance
also creates a small global `usageMetricsPendingV1` intent keyed by receipt path.
The existing private worker's authenticated `/reconcile` processes up to 40 due
intents per round; failed projection retries leave the receipt intact.

`usageMetricsV1` holds project/UTC-completion-day/provider/model buckets.
`usageMetricsAppliedV1` retains per-receipt deduplication markers. Bucket increments,
marker creation and pending-intent deletion commit atomically, so concurrent retries
cannot charge twice. Markers must remain while receipts can be replayed. These
server-only collections contain numeric aggregates and source identities, with no
prompt/tool bodies. Versioned names allow a future projection to be built separately.

Project members read `/view/usage/analytics`; platform administrators read
`/platform/analytics`. Both require `from` and `to` UTC dates, allow provider/model
filters and accept at most 31 days and 2,000 bucket rows. Platform reads also accept
an exact `projectId` and `groupBy=project|model`. Project endpoints reject project
selectors. Every service read rechecks its own authorization. No response cache is
used; existing no-store HTTP policy applies. Pending counts are bounded and explicitly
marked when capped. Historical coverage remains unverified: zero pending intents
never proves a complete historical backfill or that offline computers reported.

Before enabling historical charts for a release, an authorized operator can run
`node --import tsx apps/server/scripts/backfill-usage-metrics.ts PROJECT_ID [--after RECEIPT_ID] [--version N]`
with the engine's `MINIONS_ENGINE=self-hosted` and `MINIONS_SQLITE_PATH` settings, while the engine is stopped. The version defaults to the active reader version; an explicit candidate version builds separately without deleting active buckets or deduplication markers. Each invocation processes at most 100 receipts
and returns a continuation cursor. Repeat until `next` is null; exact replays are safe.
This command does not delete markers, change receipts or fabricate absent context
measurements. Run it with the matching engine version.


Context drilldown uses separately authorized `/view/usage/context-runs` and
`/view/usage/context-turns`, and platform equivalents under `/platform/analytics`.
Run pages contain at most 20 issued histories; turn pages contain at most 50 numeric
receipt projections, ordered by sequence with a continuation. Platform drilldown
requires one exact project ID. No private session transcript or steering body is
returned. The browser fences stale project/account/run responses.

Native usage scalars are distinct from supplied-source sizes. Maximum last-input
snapshots and observed compaction counts retain report coverage; window sizes and
percentages are not summed across models or agents. Deploy the matching API, worker
and indexes before publishing a connector that emits the new optional fields, so
older API revisions cannot strip new evidence and later conflict on an immutable
retry. A frontend deployment alone installs no worker or collects historical data.
