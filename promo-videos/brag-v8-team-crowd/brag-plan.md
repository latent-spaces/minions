# Minions — brag plan v8 (team, crowd)

v4 "team, tight" with v5's crowd of agents in the hook, the new logo and a resolved musical ending. 120 BPM, 20.0 s, 16:9 and 1:1. Stage port 47319. Render with `../render.sh brag-v8-team-crowd 47319 <scratch-dir>` from a checkout of the public `main`.

Owner direction, 17 Nov 2026: v4's video; when it says many agents, show v5's grid of agents; intro copy "Running one agent is easy." / "A whole team should be too."; the grid gathers into the row of eight under the logo; the music should end nicely.

| Time | Scene |
|---|---|
| 0.0–2.0 | Lone fox, on screen from the first frame, hopping on the beat. "Running one agent is easy." |
| 2.0–4.0 | ~70 agent tiles ripple out from the fox and fill the frame. "A whole team should be too." |
| 4.0–4.4 | The crowd pulls into the row of eight and fades as the row appears; the fox takes the head of the row. |
| 4.2–5.5 | Logo + "Your own little swarm of coding agents." |
| 5.5–10.0 | Terminal types the README prompt; "Project created · 3 agents started". "Start it from Claude Code or Codex." |
| 10.0–14.0 | Real `CommunicationMap`. "Your minions work in the background and talk to each other." |
| 14.0–17.0 | sonnet-levels' Needs-you card answered. "They ask when they need you." |
| 17.0–20.0 | Logo, "Runs on your computer. Pause or kill any time.", `github.com/latent-spaces/minions`. Characters settle by 18.6 s. |

## Music (`work/music.py`)

- Same C–Am–F–G groove as v4. The last two bars build F → G with a clap roll and a swell, then land on a C chord (kick, low C, bell chord, sparkle, pad) on the bar line at 18.0 s that rings out to near silence by 20 s. No mid-bar cut and no long fade.
- Effects re-timed to the picture. v4's typing ticks, "agents started" blips and answer clicks played 0.5–1 s late after v4's scenes moved earlier. Added a rising cascade for the crowd and a soft pair for the gather.

Synthetic data only. The big logo uses the halo-free brand copies in `promo-videos/brand/`.

`brag-r1.mp4` / `brag-1x1-r1.mp4`: the first v8 render, where the fox popped in over the first 0.35 s and frame 0 was blank.
