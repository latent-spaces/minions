# Shared development workflow

Linear is no longer used for this repository's development work. Do not use its
app connector or configure a project-specific Linear MCP server. The dedicated
Linear connection for this repository has been removed from the local Codex and Claude Code
configuration. Other projects' connections and existing credentials are preserved.

Existing Linear links and issue identifiers remain historical references. They do
not require reading or updating Linear. No replacement tracker has been selected.
This development workflow does not change how MyLittleSwarm project agents manage their
own work or their repository and review authority.

## Working protocol

1. Read [VISION.md](../../VISION.md), [AGENTS.md](../../AGENTS.md) and the relevant
   current source and owner decisions before choosing a bounded work slice.
2. Inspect recent commits, status and diff; preserve concurrent work. Reuse relevant
   open PRs and inspect prerequisites before implementation.
3. Keep the problem, scope, unresolved owner choices and remaining acceptance
   visible in the relevant PR. Do not assign or delegate another person or agent
   without owner authorization.
4. Keep material contract, code, decision and test changes together. Verify the
   actual implementation and identify untested cases explicitly.
5. Link implementation and validation before marking work complete. Put feature
   notes, plans, screenshots and receipts in the PR, not new files under docs/.
   The repository remains the source for architecture and selected policies.
6. Push periodically. Deployment remains an agreed release or milestone step.

See [the shared UI workflow](ui-workflow.md) for local application development and
acceptance. Earlier Linear workspace, project and milestone mappings remain in git
history.
