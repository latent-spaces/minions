# Offbeat 2D characters

Four human heads and twelve animals, selected by the owner on 12 November 2026.
Source: character-exploration/offbeat-animals-v1/eyes-v3-4x4.png.
Independent hat sprites: hats-v1-4x4.png, modular-hats/manifest.json.

Reproduce normal blink/state assets with animations/all-characters-v1/prepare-features.py, then render.py
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


## Rare native effects and cursor gaze

Owner selection, 12 November 2026: keep the wild native effects as-is, without
cleanup. The sixteen `*-rare.webp` strips preserve visible pixels and alpha from
four native transparent GIF batches (12 frames, 160ms, 384px 2x2 masters).
`rare-geometry.json` supplies one fixed neutral placement per character. No
per-frame fitting, color cleanup, facial mask or reconstruction is applied.
The rejected masked-cleanup experiment is not an export input. The native
originals, exact prompts/requests, usage and `export-app.py` remain outside the
bundle in character-exploration/offbeat-animals-v1/animations/rare-effects-v1/.

The app crossfades briefly at the entrance/exit and schedules independent rare
one-shots: 30–120 second initial delay, then 90–210 second intervals, with a shared
30-second start cooldown across visible avatars. Work/message/attention acting
takes priority; reduced motion, hidden/offscreen and stale/offline states cancel
ambient effects. Native face distortions remain intentional. Hats remain separate.

The `gaze/` images contain original pupil pixels and their neutral eye base,
extracted without new generation. Their zero-offset composition, with the original alpha mask, is verified
against the canonical image. Each pupil sprite must contain visible pixels;
near-opaque source pixels are accepted rather than requiring alpha exactly 255. Fine-pointer gaze runs for 10–15 seconds, starting every
14–24 seconds with independent initial delays, at least two seconds neutral between glances, a shared passive pointer listener,
bounded 8/192-unit pupil offsets and a smooth neutral return. No head or hat movement.
The pointer-relative approach was informed by
[nilbuild/page-mascot](https://github.com/nilbuild/page-mascot/blob/76a44ed9180063bf4852b9dd724b656f4a828ac7/src/mascot.tsx)
(MIT, Kamran Ahmed); our continuous pupil math is independently implemented and
uses no directional sprite sheet or package dependency.

Acceptance includes exact native strip pixels, exact zero-offset gaze pixels,
web build, unit tests, real browser rare playback and cursor reversal, unchanged
avatar bounds, reduced-motion suppression, hats, character persistence, fallback,
and visually inspected desktop/390px app screenshots. The raw Chrome review
loops for convenience; application cadence is controlled by character-ambient.ts.

The lab enables a CharacterPreview context for continuous gaze inspection; the
app's default context keeps occasional timing. Pointer updates notify a shared
external store directly, with mousemove fallback. Browser acceptance checks
nonempty visible pupil pixels as well as left/right movement; changing a CSS
transform alone is not sufficient evidence of a working export.

Pupil travel is capped at 8/192 units, with a faster distance response, so small
avatars visibly look toward the pointer. Effects are mutually exclusive: state
and message acting take priority; only one of rare, gaze or normal blink is
visible at a time. Lab-only continuous preview does not change app cadence.
