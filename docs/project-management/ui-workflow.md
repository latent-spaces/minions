# Shared UI and local integration

The actual local application is the primary development and verification environment. Storybook is optional for exploring new screens, developing the visual language or inspecting isolated states; it is not a required gate for every UI change or release. Previously approved designs remain references. The real application supplies authenticated scoped data and actions. Product policy differences require the owner's decision.

## One presentation implementation

Production UI components, styles and decorative assets belong in `apps/web/src/ui`. The actual application imports these files; if Storybook is chosen, previews must import the same components. Stories and synthetic fixtures stay outside the product bundle. The former `design/navigation-prototype` workspace has been retired. Shared presentation code does not import sign-in, API clients, model runners or prototype data. Server-backed filters and paging stay in application controllers. Do not fetch a responsibility endpoint for every card or download the entire project directory to reproduce fixture-only filters.

WorkspaceNavigation, AgentCard and the application shell stylesheet are shared product presentation. There is no retained prototype page-body implementation; do not recreate a second live API implementation for previews.

Avatars use the approved offbeat 2D set: four human choices in Settings and twelve
animals assigned by immutable agent ID, independent of provider or model. Actual
provider metadata determines only the separate coding-tool badge. Pastel owner
grouping, consented photos, custom portraits and separate persona hats remain.
Canonical 192px heads fill up to 184px of the same square in every still and
12-frame lossless strip. The deterministic facial rig locks alpha and static
pixels, with independent timing, reduced-motion and visibility handling. Working
focuses, stopping relaxes, attention holds, ordinary states blink and offline,
revoked or unknown stay still. Real new message IDs trigger one acknowledgment;
history/replay do not. Appearance grants no permissions. Whole-set switching is
deferred. For every integration, visually inspect actual app placements at small
and large sizes on desktop/mobile, including hats and state transitions; maximize
the face without clipping, size jumps or overlap. Save screenshots and acceptance
limits with the work. The workspace character-exploration/RUNBOOK.md owns the
repeatable asset and per-integration alignment procedure.

## Development and acceptance

1. Inspect recent commits, status and diff. Fast-forward clean main before work; preserve concurrent edits.
2. Choose a bounded screen slice and inspect relevant existing PRs and prerequisites. Separate design changes from policy choices.
3. Use the approved presentation or discuss a new concept first. Choose Storybook only when it helps explore a new screen, visual language or isolated states. If selected, add relevant stories using the shared components. No automatic Storybook skill, CLI or review gate applies otherwise.
4. Verify the actual loopback application with relevant desktop, phone-width, keyboard and missing/empty/error states. Check Storybook as well if it was used in this task. Models stay off. Keep resetting suites away from your engine's database and preserve occupied ports and sibling work.
5. Commit source and its tests together; link screenshots and receipts from the PR instead of committing them. Update the visible PR checklist and push periodically. When used, Storybook review proves presentation, not backend behavior or deployment.
6. This repository no longer deploys to a live site; the actual local application is the acceptance environment. Storybook's static build is a separate design review artifact.
