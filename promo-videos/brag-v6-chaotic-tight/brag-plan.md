# Minions — brag plan (chaotic, tight) · v6

Revision of `brag-v2-chaotic`. Same angle, length (20.0 s), 150 BPM grid and `work/music.wav`. Changes:

- **Wordmark (3.2–5.6):** slow push-in, kick on every beat, bar-line punch at 4.8 that flips the background to blue; the subtitle slams in and the characters hop on the beat.
- **Prompt (5.6–7.6):** push-in after the prompt lands; fox/cat/frog pop in next to "3 agents started" and hop; "GO." re-punches to "GO. GO." at 7.2 with a background swap.
- **Map (7.6–12.0):** zoom controls hidden, map larger and inside the frame, traffic pairs re-wired so no labels overlap, focus text shortened so nothing is cut off; punch on every word change plus a slow drift.
- **Close your chat:** small `/exit` window in the lower right so the map stays visible; afterwards a stronger push-in and a "Chat closed · 6 agents still working" pill.
- **Pause / Kill / Your call:** one style — the same white pill with icon slams in on ink, red and blue (filled stop square for Kill, check for Your call).
- **Outro:** characters keep hopping and the wordmark pulses on the beat until 19.2, then settle for the poster; adds `github.com/latent-spaces/minions` under `npm run setup` (the repo is public now).

Stage port 47317. 16:9 only (no square render for this cut).

---

Original v2 plan:


**Angle:** one agent is cute; Minions is a whole swarm, and it doesn't stop when you close your chat. Same product truth as v1, played FAST and LOUD.
**Hook:** "ONE AGENT?" → "CUTE." → the animal agents multiply 2 → 8 → 32 → 128 on the beat.
**Share caption:** "One agent? Cute. Minions runs a whole swarm on your computer."

Tone: `chaotic` — ALL CAPS, heavy Inter, ink/white/pastel flashes, zoom punches, shake on slams. Landscape 1920×1080, 30fps, 20.0s.
Identity kept: italic Minions wordmark, Offbeat animal characters, real CommunicationMap, real start prompt, Needs-you card markup.
Music: 150 BPM (beat 0.4s, bar 1.6s), A minor (Am–F–C–G), four-on-the-floor, 16th hats, saw bass, impacts on slams. All cuts on the 8th grid.

| # | Time | Scene |
|---|---|---|
| 1 | 0.0–1.6 | Ink. Huge fox. "ONE AGENT?" → "CUTE." |
| 2 | 1.6–3.2 | Grid multiplies 2 → 8 → 32 → 128 on beats, pastel flashes. "MORE." "MORE." "WAY MORE." |
| 3 | 3.2–5.6 | Wordmark slam with shake. "YOUR OWN LITTLE SWARM OF CODING AGENTS." |
| 4 | 5.6–7.6 | Terminal: real prompt types in half a second. Stamps "3 AGENTS." "GO." |
| 5 | 7.6–10.0 | Real map, punch zoom; beat words "BUILDING." "TALKING." "REVIEWING." |
| 6 | 10.0–12.0 | Chat window slams shut: "CLOSE YOUR CHAT." → "THEY KEEP GOING." (agents keep writing) |
| 7 | 12.0–14.4 | Red pulse, dog raises hand: "UNTIL THEY NEED YOU." Card answered: "ANSWER. DONE." |
| 8 | 14.4–16.4 | "PAUSE." "KILL." buttons slam; "YOUR CALL." |
| 9 | 16.4–20.0 | Characters rain in; wordmark; "RUNS ON YOUR COMPUTER." + `npm run setup`. Settles for the poster. |

Synthetic data only; generic agent names. (v6: the repo is public, so the outro shows its URL.)
