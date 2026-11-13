# Offbeat 2D pose characters

Twelve animal agent identities and six personal choices: four original humans,
Robot and Alien. Robot/Alien are personal choices only. Agent hashing and existing
people's unsaved four-human defaults stay stable. Consented photos stay supported.

## Assets and export

The canonical portrait is poses/<id>-neutral.png, 192px with a head contained within
184px and its original proportions. Each poses/<id>-<bank>.webp is a lossless,
transparent 960×960 atlas: nine 320px cells. Extra transparent room permits hands
and cosmic bursts without shrinking the head. A cell is rendered at 166.667%
around the logical 192px portrait, offset −33.333% in both axes.

- Directions: up-left/up/up-right, left/neutral/right, down-left/down/down-right.
- Reactions: neutral/blink/smile, delight/surprise/wink, cosmic face meltdown
  anticipation/peak/recovery. Never literal egg imagery.
- Animal actions: neutral/take pen/write A, write B/put pen/needs-you hand,
  blocked gesture/message acknowledgment/acknowledgment recovery.

Source sheets, exact built-in imagegen prompts, rejected attempts and metrics live
outside the app in character-exploration/pose-migration-v1/. Its build.py accepts
--characters followed by IDs (requires Pillow, NumPy and SciPy). One fixed affine
scale per source bank matches the original head proportions; per-pose translation
registers the upper head, excluding hands and new neon accents. No per-frame
fit-to-bounds resizing. All banks share the identical neutral pose. Production
WebP and neutral PNG writes use atomic replacement. Original artwork and the old
renderer are archived outside the app for historical comparisons.

## Renderer and interaction

CharacterAvatar/character-motion/character-ambient/character-poke/character-assets
provide one visual owner and permanently mounted, decoded banks. Pending/failed
sheets show the canonical face. Late decodes from replaced sources cannot change
the current pose. Decode resources are shared and unused entries bounded; work
banks are loaded when needed. Actual worker state and badges remain authoritative.

Working writes, stopping puts the pen away, attention gestures stay distinct and
messages are deduplicated. Completed/idle do not force a celebration. Blinking
retains independently phased 16–27-second timing. Fine-pointer gaze lasts 10–15
seconds with a 2–5-second initial delay. Start intervals are about 14.1–20
seconds (15% fewer episodes than the earlier duration-plus-two-second cadence);
the neutral gap is about 4.1–5 seconds.
Direction sectors use a 70px dead zone and 0.12-radian hysteresis. Continuous gaze
is a lab override. Ordinary blink and gaze finish their own turns without overlap.

Eligible pokes get a 420ms squash/stretch and choose: standard blink/bounce 55%,
smile 20%, wink 15%, surprise 7%, cosmic face meltdown 3%. The rare reward uses
three poses over 1.2 seconds; it is poke-triggered rather than autonomous. Repeated
pokes do not stack or queue rewards. State/message acting retains priority.
Reduced motion, hidden/offscreen and quiet states suppress decorative behavior.
Pokes are local presentation events; they never send messages or run workers.
Accessible poke targets remain separate from navigation: directory names/cards,
sidebar chips and map selection/inspection keep their normal actions.

Hats stay independent sprites in hats/ with geometry.json crown/brim anchors.
Face and hat share the squash transform; provider/status/presence badges remain
fixed to the UI. Gaze-only hat adjustment is reviewed separately from neutral,
reaction and work anchors.

Squash and sector logic adapt page-mascot at commit
76a44ed9180063bf4852b9dd724b656f4a828ac7, copyright 2026 Kamran Ahmed. The full MIT
notice is in ui/licenses/page-mascot.txt.

## Integration acceptance

Review actual app desktop/mobile placements and 24/32/40/64/96px sizes by eye:
map, sidebar, cards, tasks, messages, profile/popover, settings and shared badges.
Check maximum face fit, ears/chin, hats, labels, badge clearance, pipe occlusion,
neutral/state/reward handoffs, delayed/failed loading, reduced motion, keyboard
poking, navigation and saved personal choices. Mixed-handoff stress checks must
show one opaque head/bank, no size jump and no stale queued effect. Screenshots
verify fit; inspect live movement too. Identify unavailable/empty surfaces rather
than claiming them visually reviewed.
