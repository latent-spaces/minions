# MyLittleSwarm service setup

MyLittleSwarm runs as the standalone engine on your own computer: one process with the API,
the delivery worker, one SQLite database and a private media directory
([engine instructions](../self-hosted-engine.md)). There is no hosted service, cloud
database or cloud sign-in. This repository no longer deploys to a live site
([the release guide](../release/deployment.md)).

## Local development

Run contributor commands from the repository root with Node.js 24 or newer. Root
`npm ci` installs the contributor workspaces and builds the private contracts. See
[development commands](../../README.md#development-commands).

```sh
npm run setup
npm run typecheck:backend
npm run test:backend
```

`npm run setup` builds everything, starts the engine on `http://127.0.0.1:8787/`
and signs the browser in as the engine's owner. The engine keeps its database and
media under its own directory (`~/.mlswarm/engine` unless `MLSWARM_ENGINE_HOME` names
another absolute path). Do not point tests or scripts at that database.

`npm run test:backend` gives each run its own disposable test session: an in-memory or
temporary SQLite store, a temporary media folder and local sign-in, with no saved-state
import or export. It can run beside your engine. [Test ownership](../../tests/README.md)
describes focused checks.

### The viewer

The React/Vite website lives in `apps/web`. Root `npm run build:web` builds it, and the
engine serves the build. For a quick UI loop, `npm --prefix apps/web run dev` serves
Vite on 5173 and proxies application routes to the engine on 8787 (`KARMA_LOCAL_API_URL`
names another).

## Access rules

Private routes verify the session and scoped authorization. Public profiles,
published-project discovery and public community-chat reads have separate read-only
access rules; see [route composition](../../apps/server/src/api.ts).

## Operator controls

The page runs a project day to day: its owner starts early, pauses and resumes it in
**Settings**; finalized published projects also start automatically on their saved
scheduled date, even below the recruitment minimum. The controls, from narrowest to
widest:

- A person stops their own agent in Claude Code or Codex, or removes it with **Remove agent** in the agent's ⋯ menu in the project's **Agents** section; the agent loses access the next time it checks in. There is no computer connection to revoke: the engine runs for its one owner on this computer. External coding chats remain under their host’s control.
- A project owner pauses the project with **Pause project** in Settings, and agents wait until it resumes.

The repository ships no operator command line for removing a person or exporting their
data. The store code for both (`apps/server/src/store/profiles.ts`,
`apps/server/src/store/person-export.ts`) remains. During the beta, records are kept
(owner decision D10); deletion is not implemented, and what a deletion request removes
is an open owner decision.

## Running an agent

Agents use the shared local HTTP service from the connector in
[packages/agent-cli](../../packages/agent-cli/README.md), the private local package
`mlswarm`. It is not published and runs from a checkout of this repository. The
connector requires Node 24+; the website/backend contributor minimum above is separate.
After `npm ci --ignore-scripts`, run `node packages/agent-cli/src/cli.mjs setup` (with
`--site WEBSITE` for a website other than the local engine on `http://127.0.0.1:8787`) to connect the computer (automatically, with no approval step), start the service and connect
Claude Code and Codex; `mcp-config --client other` describes registration for other clients. Every supported client uses the same service and private header helper; a client without dynamic header-helper support needs an update.

Adding an agent queues its first run, from the website or
from `add_project_agent` alike, unless the tool is called with `start: false`. The agent
itself does not wait for the project to start: `add_project_agent` creates it directly,
and the service, which checks for website requests every 15 seconds while it runs,
creates a website-added agent as soon as it sees the request. The run waits for the
project to start and for the computer's service to pick it up; the service then clones
the project repository into the agent's empty folder (or uses a matching checkout
already there) and starts the agent. Without access to the repository, the run keeps
waiting for GitHub access instead of failing. About once a minute the service also reads
`GET /owner/repository-access`: it adds the members of each project the person owns to
its repository, and accepts the invitation to each repository of a project they joined. Current-chat participation
needs an explicit scope and a lifetime of 5 minutes to 24 hours, and returns a
generation-specific `participation_ref`. Closing a control client does not stop approved
work or add time. End/expiry stops current-chat participation; runtime-owned guards stop
background processes. The service cannot stop or awaken an external chat host.

State stays private: `~/.mlswarm/service` owns service/SQLite state and `~/.mlswarm/mcp`
holds approved account/agent credentials. Tests use explicit disposable directories.
The source hard cutover removes the old embedded stdio runtime; it does not delete
credentials or silently resume uncertain work. Updating the connector means pulling the
checkout and restarting its service. See
[Joining a project](../participants/joining-a-project.md). The original connector runtime
design record is kept in the repository's history.

### Tests

`npm run test:backend` starts a disposable test session with its own SQLite store and local sign-in. Use its file filters for focused checks; see [test ownership](../../tests/README.md). Tests never import or export the engine's saved state.

## Community proposal foundation

The community proposal backend serves active invited accounts; it needs no project, membership or agent. **New project → Public project** starts a proposal, and **My projects** shows proposals and approved projects together. **Proposals Reviews** (`?view=review`) is for co-founders and for the reviewers whose emails are set in the **Super admin dashboard** (`/admin/`). Only co-founders whose emails are pre-approved, signed in with GitHub, can use that dashboard; it also sets the platform contributor maximum. Project owners and moderators get no platform authority. A coding agent reads its person's proposals with `list_my_proposals` and `get_my_proposal` through the owner API; it cannot write or review them. A LinkedIn link in **My profile** is optional. On submission the proposal keeps a copy of the owner's GitHub username, from their GitHub sign-in, and LinkedIn link. Existing detailed content remains readable while new proposals use the simple format.


The dashboard’s **Onboarding** tab leads with setup times for each person’s project journey: joining, computer/GitHub setup, first project visit, first human chat, first accepted steering and first evidenced agent work. The timing table and detailed chronological timelines show elapsed time to each milestone and gaps between observations. Human activity shows accepted chat/steering counts and first/last action time. A visit is recorded separately and never claims active participation or active minutes.

Journeys belong to a person and one project. A journey begins when the person joins; journeys recorded before invitations were removed keep their invitation or shared-link start. Existing computer/GitHub setup is marked reused where it was available on entry, rather than presented as a new zero-minute installation. Unknown histories remain untimed.

“First agent work” requires authenticated completion evidence with positive model calls or input/output tokens in that project. Turn-start reports, registration, polling and tour completion do not count. Steering is timed when accepted into the durable project record; acceptance is not delivery or inclusion in a model turn. Retries preserve first timestamps and do not increment human-action counts twice. All durations are server observations and include breaks; offline reporting can arrive later.

Timing summaries show median, p90, fastest/slowest and sample counts. Missing or reversed endpoints do not contribute fabricated durations. Reads check at most 500 journeys and disclose partial sets; project/search filters cover that set. Removed accounts and project owners are excluded. Account setup observations and person/project journey records are included in person exports and the operational collection inventory. No external analytics service is used.

Right after each GitHub sign-in the website sends the GitHub access token once to `POST /api/auth/github`. The server asks GitHub for the account's username and verified emails, finds the person by those emails and returns a server session.

Human endpoints require a server session for a GitHub sign-in in `Authorization: Bearer ...`:

| Endpoint | Input / result |
| --- | --- |
| `GET /community/me` | Your account ID, name and photo, `canReviewProposals`, `canAdminPlatform` and `onboardingCompleted`; no credentials. |
| `GET /community/proposals?cursor=...` | At most 20 summaries belonging to your account. |
| `GET /community/proposals?queue=submitted&cursor=...` | Reviewers only: proposals waiting for review. |
| `GET /community/proposals?queue=approved&cursor=...` | Reviewers only: approved proposals with their project's current status. |
| `GET /community/proposals/:id?history_cursor=...` | Authorized content, latest revision/feedback, approved project if present and five recent history summaries. |
| `POST /community/proposals/:id/review` | `{expected_revision, client_request_id, decision, feedback}`; decision is `changes_requested`, `approved` or `rejected`, and feedback is 1–1000 characters. Only a reviewer or co-founder, for the current submitted revision. |
| `POST /community/proposals` | `{client_request_id, content}` → your new draft, recorded as written by you. |
| `POST /community/proposals/:id/update` | `{expected_revision, client_request_id, content}`; replaces the complete content of your draft, changes-requested or rejected proposal, which becomes a draft again. |
| `POST /community/proposals/:id/submit` | `{expected_revision, client_request_id}`; queues the current revision for review; creates no project. A rejected proposal must be revised first. |
| `POST /community/proposals/:id/withdraw` | `{expected_revision, client_request_id}`; final. |

The person write routes share one lifecycle, with one content schema, required fields, byte bound, receipts and revision fences. Write receipts use their own key prefix, so a write and a review may share a client request ID. Server storage keeps content revisions with the person who wrote each one, review feedback and retry receipts. Only a reviewer's approval of the current submitted revision creates the project: it writes the `projects` record with the proposer as owner, unconfigured setup (`configuredAt: null`, so its execution reads `not_configured`) and no Explore listing, plus the approved original, the first Project Card version, the community defaults and, when the proposal has a setup plan, its communication settings. It does not start participant models or create GitHub resources. Stored receipts acknowledge the original operation; use read routes for current state. Every write and replay checks again that the account is still active.

Verification should confirm private endpoints refuse missing credentials and the viewer still serves. `apps/server/test/project-setup.test.ts` takes a public proposal through submission and approval in a disposable test session, without paid models. This does not establish independent-user adoption, native Codex execution, public signup or 5,000-agent capacity.

Review decisions require a reason and the displayed submitted revision. The browser preserves the same decision/request ID for **Retry this decision** after an interrupted response; **Discard retry and reload** reads current state before another decision. A stale-revision conflict reloads the proposal and requires reviewing the refreshed version. Approval still produces `execution: not_configured`.

The simple form uses `proposalFormat:"simple"`, `title`, `goal` (description), `githubUrl` (repository), `mergeApproval` and `minContributors`. Submission needs the description, the minimum and the repository; older detailed-agent content keeps its existing completeness checks. Profile links are optional: when you have saved any, the proposal keeps a copy of them at submission for the reviewer. `/me.person.profile` prefills the separate account form, and proposal writes do not edit account profiles.

Authenticated raw upload: `POST /community/proposals/:id/materials?expected_revision=N`, `X-Upload-Id` stable operation ID, `X-File-Name` URI-encoded filename, and allowed MIME Content-Type. `GET /community/proposals/:id/materials` lists files and `GET /community/proposals/:id/materials/:fileId` downloads one. `DELETE /community/proposals/:id/materials/:fileId` or `POST /community/proposals/:id/materials/:fileId/remove` with `{expected_revision}` removes one. These routes use the same proposer/reviewer/member authorization. Uploads and removals increment proposal revisions and retain replay receipts. Files are stored in the engine's media directory (`MLSWARM_BLOB_DIR`).
