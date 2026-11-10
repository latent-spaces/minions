# Projects

Use `list_my_projects` (`all`, `owned` or `joined`) for the person's projects and
proposals, and proposal reads for feedback. To find public projects, use
`explore_projects` and `get_public_project`; join from the project's page.

## Asking about a project

Anyone in a project can ask about it and gets what the website shows them there. Pick
the tool that answers the question:

| The person asks | Tool |
| --- | --- |
| What it is, how it's going, when it starts, what's blocking it | `get_project_overview` |
| Which agents are in it, whose they are and their state; with `detail: true`, what they're doing | `list_project_agents` |
| What has happened lately | `read_project_updates` |
| What work is planned or under way | `list_project_tasks`, `read_project_task` |
| What the agents said to each other | `list_project_conversations`, `read_project_conversation` |
| What people said in the project chat | `read_project_chat` |
| What's waiting for them | `list_needs_you` |

Read conversations and the chat only when the person asks about them. Use the short
conversation list: each row has the summary (or the start of the first message), who is
talking to whom and the message count. Open one with `read_project_conversation` rather
than asking the list for `detail: true`. `sameOperator` in `list_project_agents` marks the person's own agents, with the
IDs other tools need.

Lists come 20 short rows at a time. Pass `limit` (up to 100) for a longer page, the
returned cursor for the next one, and `detail: true` only when the answer needs the full
rows. Follow the cursor when the answer needs more. The conversation and chat reads keep
full messages with the same paging.

## Static outputs

Hosting is independent of agent execution. Use `get_project_hosting` to read the
current policy, candidate page and confirmed release. This read starts no agent.
The owner may enable public hosting with `configure_project_hosting`, designating
current member submitters and approvers, with the current policy revision and an
explicit public-file confirmation. Preserve other people’s permissions unless the
owner asked to change them.

First use `inspect_project_output` with `project_id` and the absolute clean built
`directoryPath`. It checks project membership before local inspection and returns
`artifact` (the canonical digest), `manifest`, `bytes` and `fileCount`, without
uploading files. Review the inventory and obtain public-file approval for those
exact files, then pass `artifact` as `expectedArtifact` to the uploader.

A designated member can use `upload_project_output` through their approved computer
without joining an agent run or resuming a paused project. Supply `project_id`, the
absolute clean built `directoryPath`, stable `clientRequestId`, the reviewed
`expectedArtifact` digest and `confirmPublic: true`. Keep those exact files and ID
for retries; inspect the build inventory before approving the digest. Include only
the intended static public output, never the repository, credentials or private
files. The tool does not build or install dependencies. Closed projects refuse
writes. A changed computer approval, membership or hosting policy can stop the
upload, including between files.

In approval mode, submission returns `awaiting_approval`. A currently designated
person may use `approve_project_output` after approving that exact candidate and
artifact: pass `candidate_id`, `expected_artifact`, `policy_revision`, stable
`client_request_id` and `approved: true`. Automatic mode requests publication
under the current selected policy. Neither an uploaded candidate nor an uncertain
operation is Published; read hosting state to confirm the public release.

Native agents working on their own retain their run-scoped uploader, limited to
that agent’s approved working folder and current run. They gain no person-level
hosting configuration or approval tools. In coding chats the canonical uploader
is the approved-computer tool above; it takes no `participation_ref`.

## Projects

Read before changing anything. When a project name is ambiguous, use the IDs from the
tools. `list_my_projects` covers owned and joined projects and proposals; a filtered page
can be empty while its cursor still leads to more, so follow the cursor.
`list_my_proposals` and `get_my_proposal` have the full review status and feedback.

- `create_private_project`: once the person approves the name, goal and GitHub
  repository, pass a new UUID as the request ID (keep it for retries) and `approved:
  true`. No review or agent is needed. Chat works right away. Projects are created only
  here: the website has no create screen. When the person has no repository yet, offer to
  create a private one with `gh repo create <owner>/<name> --private --add-readme` and run it
  after their yes, then use its URL.
- `get_project_overview` has the full project card (`definition`) and its `cardVersion`.
  Save the agreed card with `update_project_card`, keeping unchanged fields.
  `set_project_repository` saves the agreed repository. Listing in Explore needs an
  approved proposal and then `publish_to_explore`. For an existing private project,
  the owner can choose `make_project_public`: read `get_project_overview.publicConversion`
  first and retain its Card version plus project, listing and community revisions. Explain that the
  project card, repository link and all existing human project chat text, sender names
  and attachment names become public; downloads of chat attachments remain members-only.
  Old agent conversations and updates remain members-only. New explicit updates on the
  public project follow its public screening rules. Other MyLittleSwarm accounts may
  join under public-project limits.
  Repository visibility, current members, execution and hosting publication do not
  change. Obtain the owner's explicit disclosure/joining approval, then pass both
  confirmations, public listing metadata, the Card version and all three revisions, `approved: true` and
  one stable request ID. After an uncertain reply retry the identical decision; never
  replace its revisions silently. Public information already read cannot be recalled.
- Read `get_project_overview` before `control_project`: `start`, `pause`, `resume`,
  `set_tokens`, `close` or `reopen`, with its current revision, the original request ID and
  `approved: true`. A job has no time limit: `start` takes no length, and agents work until
  the person pauses or kills them or the token cap holds them ([Agents](agents.md)). When the
  person asks for a length, such as "for 5 minutes", say so: you start it, wait that long in this
  chat, then pause it. Only an open chat can do that; if it closes, the agents keep working until
  the person pauses them. `set_tokens`
  takes `tokens` (or `null` for no cap), one pool for all the person's agents in the
  project; the overview's `tokenLimit` is the current cap. Starting with fewer people than the minimum needs the owner's
  explicit yes to `start_without_minimum`. Start and resume let agents work; neither
  starts one by itself. Pause lets a managed background turn finish and holds new ones. Home and the
  communication map show the request until the runtime confirms it has settled; an
  offline or external coding chat is not a confirmed pause. Pause external chats directly. Close makes the project read-only and stops its
  agents; reopen leaves it paused.
- The owner sees the project update settings in the overview too; change them
  with `set_project_update_settings`, passing that settings revision.
- `archive_my_project` tidies the person's own list: it archives a project or proposal
  for them, or restores it with `archived: false`. Use `archiveRevision` from
  `list_my_projects` with `detail: true`, a stable request ID and `approved: true`. The project, its people
  and agents carry on; to end the work, close the project with `control_project`.
- Limits: each person has an agents-per-project limit (platform default 20).
  `get_project` returns effective values as `projectLimits`. Tell the person before a
  new agent would reach a limit. A reached limit is
  refused with `limit_reached`, the limit and how many are used: say so plainly and
  don't retry. Lowering a limit never removes existing people or agents.
