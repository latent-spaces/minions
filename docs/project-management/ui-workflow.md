# UI development

Production components and styles live in `apps/web/src/ui`. Use the shared design
system in [DESIGN.md](../../DESIGN.md) and keep one implementation of each surface.

For a new screen or substantial visual change, compare image-model concepts and
review the direction before implementation. Use representative synthetic inputs;
concepts do not establish supported features, connection state or measured results.

Verify changes through the actual local application. Use an isolated absolute
`MINIONS_ENGINE_HOME` and an available `MINIONS_ENGINE_PORT`; preserve other engines,
checkouts and occupied ports. Start no model runs without explicit approval.
Check desktop and phone widths, keyboard access, and relevant loading, empty and
error states. Include screenshots and remaining validation limits in the PR.

Storybook is optional. If useful for exploration, its stories import production
components with synthetic inputs; fixtures never enter the product bundle.
Storybook does not replace integrated application checks.
