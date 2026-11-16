# Private shared contracts

`@minions/contracts` owns shared lifecycle types and the side-effect-free lifecycle observation used by the server and the identified beta.9 browser fallback. It authorizes no mutations. Server routes still select authoritative data and enforce permissions; website action labels live in `apps/web/src/ui/lifecycle-presentation.ts`. There is one observation calculation. Remove fallback consumption only when the matching deployed API/website migration has been accepted (OPE-53), not during this source move.

Build before consumers. The single root `npm ci` installs every workspace from the root `package-lock.json` and builds this package through the root `prepare` script. After editing it, rebuild with `npm run build:contracts`. This package itself has no publish or install hooks. Runtime exports are compiled JavaScript with declarations; consumers reference the package name instead of server source.
