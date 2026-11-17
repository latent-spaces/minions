# Shared contracts

`@minions/contracts` owns shared lifecycle types and the side-effect-free lifecycle
observation used by the server and web app. It authorizes no mutations: server routes
select authoritative data and enforce permissions. Website action labels live in
`apps/web/src/ui/lifecycle-presentation.ts`.

Build before consumers with `npm run build:contracts`. The root `npm ci` installs
all workspaces from `package-lock.json`. Runtime exports are compiled JavaScript
with declarations; consumers reference the package name instead of server source.
