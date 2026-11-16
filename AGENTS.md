# Minions project workflow

## Vision alignment and careful evolution

Read [VISION.md](VISION.md) before product, architecture, implementation or data-model
work. It is the central product-direction reference. Apply agreed tenets and
explicit owner policies; open choices, historical plans and existing code are not
new product decisions.

Tie material changes to the participant need and tenet they serve. If behavior conflicts
with the vision, explain the concrete mismatch and discuss adapting it, deferring it or
an explicit pivot before implementing the dependent choice. Continue independent
authorized work; routine aligned fixes need no fresh vision approval.

Do not silently rewrite product meaning. Propose substantive vision changes with evidence,
tradeoffs, affected behavior/data contracts and the exact wording; adopt them after an
explicit owner decision. An existing explicit selection needs recording, not another
confirmation. Follow [the vision change process](VISION.md#evolving-the-vision-with-care),
update current wording and dated decision records; git history preserves earlier versions.
Editorial corrections may proceed normally; vision edits grant no new operational authority.

Linear is no longer used for this repository's development workflow. Do not use
Linear app connectors or configure a project-specific Linear MCP server. Existing
Linear links and issue identifiers are historical references, not a requirement to
read or update Linear. Keep source, selected decisions and validation in the
repository and relevant PR; do not select a replacement tracker without an owner
decision. See [the shared development workflow](docs/project-management/README.md).
Do not assign/delegate another person or agent without authorization.

Whether project agents use GitHub Issues and comments as their source of truth is
a separate product decision; repository access and review authority retain their
own explicit product decisions. Existing coordination proposals are not implemented
just because they appear in a plan or concept.

Prefer codebase-memory-mcp for code discovery when this repository is indexed; use file search for non-code files and when the graph returns insufficient results.

## Runtime implementation continuity

Current runtime behavior is described in [the connector README](packages/agent-cli/README.md)
and implemented in `packages/agent-cli/src/` (the shared local service is in
`src/service/`) and `packages/agent-cli/runtime/` (the worker engine). The original
hard cutover plan (`docs/research/connector-runtime-2026-10-17.md` at commit `5d37c854`)
is kept in the repository's git history. Before each slice or delegation, read the active
work scope and gather the relevant decisions, current source commit and
symbols, pinned upstream references, shared contracts and focused acceptance.
Freeze shared contracts before parallel implementation. Keep material discoveries,
contract/code changes and affected decision/test updates together in the same
PR; routine aligned engineering can proceed, while changed product behavior or
authority still needs an explicit owner decision. Resume from actual source and
evidence, not a stale handoff. Keep the hard cutover free of dual production
runtimes or legacy fallback.

## Cross-platform engineering — owner update, 21 October 2026

Design and review local tooling, connectors, installers and runtime behavior for
both Windows and macOS from the start; preserve Linux support where applicable.
Do not assume POSIX APIs, uid/gid ownership, permission bits, shell syntax, signals,
executable names or path conventions exist on Windows. Check platform capabilities
before using them, preserve the available security checks, and fail clearly when
a required guarantee cannot be provided. Review npm/npx command launching and
quoting, paths with spaces, file URLs, process cleanup and file locking on both
platforms. A macOS-only test pass is not Windows acceptance.

Run native Windows and macOS checks when available; otherwise state precisely what was simulated and what
still needs native verification. Never weaken POSIX security checks to make a
Windows path pass, or use shared stash/reset operations to reproduce a bug while
other sessions have work in progress.

## Small, fast tests — owner decision, 15 November 2026

Keep the test suite a small, fast core: typechecks plus a handful of smoke tests per
package (see [tests](tests/README.md)). `npm run test:all` runs it. Do not add
regression or coverage tests by default; add one only when it guards something a
typecheck and the core cannot, and keep it fast. Verify behavior in the actual local
application. Delete tests for removed behavior rather than adapting them.

## Batch work and integrate related PRs

Prefer PRs containing a cohesive batch of completed, tested work. Group related
changes into a reviewable result, with a clear description and relevant validation.

Before an authorized merge or release, check for other open PRs from Noa
(`noashpinat`). Review their readiness, conflicts and overlap with the current work,
resolve issues and merge ready changes into `main`. Then run the relevant checks,
and push the consolidated `main`. This repository does not deploy to any site; a
release means updating local computers from `main`. Drafts and design proposals still need review; their existence alone
does not make their behavior an approved product decision.

## GitHub CI only on explicit request — owner update, 29 October 2026

GitHub Actions checks stay manual-only. Do not dispatch CI by default for changes,
PRs, merges or releases; run it only when the owner explicitly asks for CI.
A merge request alone does not request CI. Keep focused local
validation and required release checks; report native checks that were not run.
Do not restore automatic workflow triggers without an owner decision.

## Remove superseded implementation as work lands

When replacing behavior, remove dead branches, duplicate helpers, obsolete prompts and their setup references in the same change. Rewrite current instructions rather than appending contradictory guidance. Git history is the archive for removed records and deleted source.

Keep compatibility only for an identified active consumer or migration requirement. Record the consumer, removal condition and owning development work. Do not add permanent fallback paths for hypothetical clients. Preserve live participant state and credentials; code retirement does not authorize deleting production data or interrupting an active model invocation.

## Docs describe the current product — owner decision, 22 October 2026

Docs describe the current product. Do not add dated release, evidence, verification or research files under docs/. Record each release as one row at the top of docs/release/deployment.md's Release history; put evidence in the PR. docs/design/ keeps its own conventions.

## Visual concepts before UI implementation

Before implementing a new screen or a substantial visual change, generate image-model concept mockups and compare a small set of distinct directions. Use the model's visual prior to explore hierarchy, composition and craft, grounded in current product truth and representative UI. Present new concepts before implementing a new visual direction; reuse already approved concepts for integration. Product UI uses Minions (short form minions for identifiers); the repository is `latent-spaces/minions`; earlier history is in `karma42-swarm`.

Concept imagery is exploratory, not evidence of supported features or measured state. Correct invented connection/readiness claims, mark synthetic data explicitly and preserve the distinction between project approval and execution. Keep prompts and selected concept references with the design work; verify changes through the actual local application and focused checks. Previously approved concepts and Storybook visuals remain design references; reviewing them does not require running Storybook. Real API and permission behavior remain authoritative.

## Owner-led beta decisions — latest update, 7 October 2026

Follow [the shared development workflow](docs/project-management/README.md) for current work and evidence.

The owner now wants to choose product behavior where real code and the storyboard differ. This supersedes the earlier autonomous visual-selection instruction. Present the concrete difference, alternatives and consequences before implementing the dependent choice. Record explicit answers with source/date in docs/decisions.md and the affected PR. A recommendation, concept, preselected answer or elapsed time is not a decision. Continue independent work while choices are pending; do not turn the whole register into a blanket blocker.

Preserve the approved light design, nested project sidebar and Minions brand. The owner selected Project Card concept 2 (editorial document with side rail) on 7 October; this settles layout only. Card edit/version/capacity behavior, control placement, project admission, beta agent scope, GitHub authority and voting differences retain their own feature gates.

## Local-first workflow — owner update, 8 October 2026

Owner update, 8 October 2026: the actual local application is the primary UI development and verification environment. Storybook is optional: use it when useful to explore a new screen that does not exist yet, develop the visual language, or inspect isolated component states. It is not a required step for every UI change, test, review, commit or release. This explicit owner instruction overrides automatic Storybook skill/plugin requirements for this repository; do not invoke their mandatory story, CLI or review workflow unless Storybook is chosen for the task.

Keep one implementation of each integrated UI surface. Production presentation components and styles live in `apps/web/src/ui`. If Storybook is chosen, its previews must import those components with synthetic inputs; stories and fixtures never enter the product bundle. The former `design/navigation-prototype` workspace has been retired. Do not create a second UI implementation for previews. Storybook does not replace actual local API, authentication and permission checks.

Before starting work, inspect recent commits, status and diff and pull `main` with fast-forward only when the checkout is clean. Never overwrite parallel work. Complete an integrated screen slice with actual local verification and an optional shared design preview; remove superseded markup/styles in that slice. Preserve existing owner-selected policies; discuss concrete behavior differences before changing them.

Use the actual local application and the local engine (`npm run setup`) with an
isolated `MINIONS_ENGINE_HOME` and a free `MINIONS_ENGINE_PORT` for iteration. Default to no model execution; real local model runs must be explicitly selected,
with a model available to the operator and the existing pause/stop/token visibility. Keep
local demo data and credentials separate from the owner's own engine and from the
everyday Karma42 install (`~/.karma42`, port 59698). Do not run resetting tests against
an engine that holds data someone uses.

No Storybook service or port is assumed to exist. Check occupied ports before starting any preview and preserve sibling checkouts and other people's processes. Live services, credentials, model execution and fixture records stay outside shared UI. The removed 6006 product Storybook stays removed. See [the shared UI workflow](docs/project-management/ui-workflow.md).

There is no cloud deployment; this repository does not connect to karma42.ai.
Periodic Git pushes remain authorized. Record verified implementation and remaining acceptance as visible checklists in
the relevant PR; comments alone are not an adequate progress view.

## Usage measurements

Pin the model explicitly (for example `--model`) in any run whose usage is compared; otherwise Claude Code and Codex pick defaults that differ between agents, so token numbers stop being comparable.

On subscription accounts, report usage in tokens. Dollar figures are the client's estimate at API prices, and `costUsd: 0` with `costReports: 0` means unknown cost, not zero.
