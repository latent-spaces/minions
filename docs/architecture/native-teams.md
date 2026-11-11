# Native teams

Teams let project agents organize themselves without changing task ownership,
human steering, repository access or execution. Configurable collections are a
separate selected direction and are not implemented here.

## Capability and clients

Teams are OFF unless `ProjectRecord.nativeTeams.enabled` is explicitly true.
The setting has its own revision. Current project owners/admins manage it through
Settings → Features; membership and account checks are enforced by
the server. Disabling Teams hides its tab and refuses team mutations, including
retries, but retains every record and read. It never changes tasks or agent runs.

The human Teams tab is a read-only directory with a detail panel, active/archived
filter, literal case-insensitive name search, member roster and newest-first
history. It uses the existing Gallery Workspace presentation and agent portraits.
On phone widths, opening a team replaces the directory with detail; Close or
Escape returns focus to the selected row. Explicit refresh rereads the directory
and selected team. Project-scoped realtime invalidations refresh the directory
and selected roster/history automatically. An active view also reconciles every
60 seconds; hidden/inactive views do not poll. Reconnects perform fresh authorized
reads, and refreshed detail pages never combine different team revisions.

Background agents discover `read_teams` and, when enabled, `manage_team`. In-chat
participants use `get_team_tools` and `call_team_tool` with an approved
`participation_ref`; discovery is scoped per participation and invocation rechecks
the current setting. Worker discovery intersects the fresh remote catalog with
the bundled strict schemas. Mission, run, membership and token boundaries remain
authoritative. The ON/OFF state is included in each worker turn's current context.

## Agent permissions

| Operation | Authority and effect |
| --- | --- |
| Read/list | Valid project access; available while Teams is OFF |
| Create | Calling agent creates a named team and joins as its first member |
| Join | Calling agent joins an active team; multiple teams per agent are allowed |
| Leave | Current member leaves for itself, including while archived |
| Archive/restore | Any current team member, without creator/leader privilege |

There is no target-agent input. Self means the authenticated caller, including
when the caller's person is a project owner/admin. Creation records provenance
and grants no leadership. Archive/restore preserve the member roster and history
and have no task or execution side effects. Archived teams refuse new joins.
Leaving relinquishes restoration authority; a team that becomes empty while
archived has no member able to restore it. Administrative recovery, human
membership controls, peer removal and editing a team's name/purpose remain
outside the selected implementation slice. Project membership/revocation checks
still apply to agents retained in a historical roster.

New mutations require a writable, running project under the existing agent
policy. Closed projects remain read-only. Team actions do not deliver messages
or wake agents.

## Transactions, history and bounds

All records live under the project:

- `nativeTeams/{teamId}`: name, purpose, creator, archive state, member count,
  timestamps and revision.
- `nativeTeams/{teamId}/members/{agentId}`: self-membership state and join/leave times.
- `nativeTeams/{teamId}/activity/{eventId}`: immutable actor/action, revision and team snapshot.
- `nativeTeamReceipts/{hash}`: agent/request-scoped fingerprint and historical result.
- `nativeTeamSettingOperations` and `nativeTeamSettingHistory`: attributed setting retries/history.
- `nativeTeamProgress/{00..15}`: bounded revision shards for shared realtime watches,
  updated atomically with each new mutation, never by a historical receipt replay.

Each existing-team mutation supplies its observed revision. Authority, state,
membership, audit and retry receipt are checked/committed in one transaction;
concurrent changes cannot silently replace each other. Reusing a request ID with
different input refuses. An identical retry returns `replayed: true` and its saved
historical snapshot without applying it again; clients must reread current state.

Directory pages default to 20 and allow up to 50 entries, bounded to 64 KiB before
MCP attribution. Name search scans up to 200 candidates and can return an empty
page with a cursor. Rosters and history have independent cursors; history is also
byte bounded and orders by the unique per-team revision. Pages are live rather
than snapshots. The human UI refuses to combine detail pages from different
revisions. No full-project membership array is stored in a team document.

Names and purposes are attributed untrusted context in MCP, including historical
snapshots and retries. Their author is the creator because text edits are not
exposed. Text that claims approval grants no additional authority.
