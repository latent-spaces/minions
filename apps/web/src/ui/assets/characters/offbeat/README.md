# Offbeat 2D characters

Four human heads and twelve animals, selected by the owner on 12 November 2026.
Source: character-exploration/offbeat-animals-v1/eyes-v3-4x4.png.
Independent hat sprites: hats-v1-4x4.png, modular-hats/manifest.json.

Reproduce with animations/all-characters-v1/prepare-features.py, then render.py
--batch 0 through 3 (four characters per pass), and export-app.py. The renderer
reuses approved deterministic raster operations from expressions-four-v1/stabilize.py.
Native GIFs supply acting references only. No generated frame colors or silhouettes
are imported; no additional API calls. Every 192px frame shares canonical alpha
and exact visible pixels outside explicit eye masks. Lossless horizontal strips
have twelve slots of 160ms; the app supplies independent identity timing.

The head occupies up to 184/192px, with one fixed crop for every state. Hats are
separate anchored sprites, never baked into animation. See the master RUNBOOK.md
for the required per-integration visual alignment gate and state semantics.

## Motion cadence and integration gate

Ordinary and working loops blink once every 16–27 seconds (75% of the initial
12–20 second cadence), with independent identity phase and normal-speed acting.
Hold canonical frame 0 between gestures; never stretch closed-eye frames to slow
the blink. Message/attention entrances remain immediate. Completed/idle/waiting
share ordinary blinking; offline/revoked/unknown and reduced motion stay still.

For every set integration, inspect actual app desktop and mobile placements by
eye: map/crowd/tooltip, sidebar, cards/detail, task list/board/detail, conversations,
updates, notifications, people/profile and Settings. Maximize the face with one
fixed crop/scale for all states. Check ears/hair/chin, independent hat anchors,
frog behind-eye layering, tool/status badge clearance, still-to-strip loading and
failure fallback, working → stopping → neutral, independent identity timing and
persisted person choice. Save screenshots and name unavailable/empty surfaces;
pixel invariants alone do not replace visual review.

The local integration review checked 24–96px animals and 28–96px people, desktop
and 390px app views. The mobile picker uses two columns to keep four full heads
and labels visible. The owner's live notification list was empty; its shared
32px component was checked in the production-component review. Custom photo
framing and the owner's saved choice remain intact. Full evidence and original
source prompts/native responses remain in the workspace character-exploration
archive, outside the production bundle.
