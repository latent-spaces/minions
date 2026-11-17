# Minions engineering instructions

Minions is a local application for one person and their coding agents. Read the
[README](README.md), [product overview](PRODUCT.md) and relevant current source before
changing behavior. Keep product changes explicit; documentation cleanup does not
grant new runtime or repository permissions.

## Working practices

- Inspect recent commits, status and diff. Preserve concurrent edits and active work.
- Prefer codebase-memory-mcp for code discovery when indexed; use file search for
  non-code files or when the graph is insufficient.
- Keep changes cohesive. Remove superseded implementation with its replacement.
- Keep shared contracts, implementation and related documentation together.
- Do not delegate work without authorization. Do not merge or release unrelated work
  merely because a branch or proposal exists.
- Keep credentials, local records and personal data out of commits and shared logs.

## Runtime and platforms

The [connector README](packages/agent-cli/README.md) describes the shared service in
`packages/agent-cli/src/service/` and worker engine in `packages/agent-cli/runtime/`.
Use current source and contracts rather than historical plans. Preserve live
participant state, credentials and active model invocations.

Design tooling, installers and runtime behavior for Windows and macOS; preserve
Linux support. Check platform capabilities before using permissions, process
ownership, signals, shells or file locks. Preserve POSIX security checks, and fail
clearly when a required guarantee is unavailable. Review paths with spaces,
npm/npx launching, file URLs and process cleanup on both platforms. Report native
checks separately from simulations; a macOS pass does not establish Windows support.

## Validation

Keep tests small and fast: typechecks and core package smoke tests, run with
`npm run test:all`. Add tests only when the typecheck and core cannot guard the
behavior. Delete tests for removed behavior. See [tests](tests/README.md).

Use the actual local application for UI verification, with an isolated absolute
`MINIONS_ENGINE_HOME` and a free `MINIONS_ENGINE_PORT`. Preserve occupied ports and
other checkouts. Keep test data separate from everyday engines. Real model runs
require explicit approval.

GitHub Actions remains manual-only. Do not dispatch CI unless explicitly requested.
Record the problem, resulting behavior, relevant validation and remaining limits
in the PR. Keep docs focused on current behavior; plans and verification receipts
belong in the PR rather than dated files under docs/.

## UI development

Preserve the light design, nested project sidebar and Minions brand. Before a new
screen or substantial visual change, compare image-model concepts and present the
new direction before implementation. Concepts use synthetic data and do not prove
supported behavior or measured results.

Production UI lives in `apps/web/src/ui`. Keep one implementation per surface.
Storybook is optional, and its automatic skill/plugin workflows are not required.
If chosen, stories import production components with synthetic inputs and stay out
of the product bundle. Verify integrated behavior in the actual local application.
See [DESIGN.md](DESIGN.md) and the [UI workflow](docs/project-management/ui-workflow.md).
