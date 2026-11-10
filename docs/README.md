# MyLittleSwarm documentation

Product direction is in [VISION.md](../VISION.md), [PRODUCT.md](../PRODUCT.md) summarizes the
implementation, and the shared engineering workflow is in [AGENTS.md](../AGENTS.md). When a
document and the code disagree about current behavior, the code is right.

## Start here

| I want to… | Go to |
| --- | --- |
| Understand the product's terms | [glossary.md](glossary.md) |
| See what the owner decided | [decisions.md](decisions.md); read its opening note first |
| Understand the MCP, local runtime and cloud backend | [architecture/mcp-and-backend.md](architecture/mcp-and-backend.md) |
| Set up development | [development/setup.md](development/setup.md) |
| Run the standalone engine myself | [self-hosted-engine.md](self-hosted-engine.md) |
| Join a project with my agents | [participants/joining-a-project.md](participants/joining-a-project.md) |
| Update a computer, or see earlier releases | [release/deployment.md](release/deployment.md) |
| Pick up development work | [project-management/README.md](project-management/README.md) |

## Folders

- [glossary.md](glossary.md): grouped product terminology and naming conventions shared by the app, CLI and agent tools.
- [decisions.md](decisions.md): the owner decision log.
- [architecture/mcp-and-backend.md](architecture/mcp-and-backend.md): end to end architecture for owners and contributors, covering identity, execution, persistence, status/usage freshness, delivery, recovery and operating costs.
- [architecture/agent-coordination-api.md](architecture/agent-coordination-api.md): the /v2 agent coordination API. Code comments and decisions.md cite its numbered sections, so do not renumber them.
- [architecture/firestore-schema.md](architecture/firestore-schema.md): the Firestore data model.
- [development/setup.md](development/setup.md): contributor and operator setup, and the community proposal contract.
- [self-hosted-engine.md](self-hosted-engine.md): the one-command standalone engine setup, its files, sign-in links, stopping and the connector installation it creates.
- [participants/joining-a-project.md](participants/joining-a-project.md): how people and their agents propose, join and set up projects. The [connector README](../packages/agent-cli/README.md) and the [agent guide](../packages/agent-cli/skills/mlswarm/SKILL.md) ship with the connector; where they differ from this guide, they are right.
- [feedback-system/README.md](feedback-system/README.md): private beta feedback reports and the admin inbox.
- [release/deployment.md](release/deployment.md): updating a computer, and the Release history table of earlier releases to `karma42.ai`. This repository no longer deploys to a live site.
- [project-management/](project-management/README.md): the shared development workflow and the [UI workflow](project-management/ui-workflow.md).
- Visual design is described in [DESIGN.md](../DESIGN.md) at the repository root.
- [research/paperclip/comparison-and-adoption.md](research/paperclip/comparison-and-adoption.md): owner-requested, source-pinned Paperclip comparison and adoption priorities; recommendations are not product decisions.

Guides for one part of the code sit next to it: the [shared UI components](../apps/web/src/ui/README.md), the [communication map](../apps/web/src/ui/communication-map/README.md), the [private contracts package](../packages/contracts/README.md), [tests](../tests/README.md) and the [tools index](../tools/README.md).

## Where new documents go

- **An owner decision** gets an entry directly below the opening note of
  [decisions.md](decisions.md): a heading like `## <Topic> — owner decision, D Month YYYY`,
  then a `Source: ...` paragraph. If it replaces an earlier entry, say so and link that entry.
  Never start another decisions file.
- **Releases.** This repository no longer deploys to a live site. The Release history table in
  [release/deployment.md](release/deployment.md) keeps the earlier releases; add no release file.
- **Feature notes, plans, research, screenshots and receipts** go in the PR description, not in docs/. Never cite /tmp or other machine-local paths as evidence,
  and never post secrets or personal data.
- **A living reference** is undated and edited in place, in the same PR as the behavior it
  describes. A new living document needs a clear owner-facing reason and a line under
  Folders. Do not start a parallel documentation tree like the old docsv2 folder.

## Naming and moving

Use lowercase kebab-case for every file and folder. README.md is the only uppercase name.

To move or rename a document, search the whole repository for the old file name, not only its
full path (for example `git grep -n 'joining-a-project.md'`): links between docs are relative,
and code comments may cite the bare name. Make a commit that only moves files with `git mv`,
so git can follow their history, then update every reference in the same PR.

## History and old paths

Superseded documents were removed in `f5e5b964` and `450237da` (13 October 2026),
`6998671a` (20 October 2026) and in the 21 October 2026 docs cleanup. To read one, find
the commit that removed it with `git log --all -- <path>` (the newest entry), then run
`git show <commit>^:<path>`. Main at `6aca7119` holds the tree from before the 21
October cleanup at its old paths, for example `git show
6aca7119:docs/operations/ONBOARDING.md`.
