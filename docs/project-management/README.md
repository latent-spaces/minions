# Development workflow

1. Read [AGENTS.md](../../AGENTS.md), the relevant source and package documentation.
2. Inspect status, recent commits and existing work. Preserve concurrent edits.
3. Keep a bounded change, including shared contracts and documentation. Discuss
   substantive product or permission changes before implementing them.
4. Run focused local checks and verify UI changes in the actual local application.
5. Describe the problem, resulting behavior, validation and remaining limits in the PR.

Use an isolated engine for development. Keep personal data, credentials and
verification receipts out of the repository. GitHub Actions runs the core checks on
pull requests and pushes to `main`. See [setup](../development/setup.md),
[tests](../../tests/README.md) and the [UI workflow](ui-workflow.md).
