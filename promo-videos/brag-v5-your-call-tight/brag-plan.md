# Minions — brag plan v5 (your call, tight)

Revision of [`brag-v3-your-call`](../brag-v3-your-call/). Same angle, copy, palette, 20.0 s length and bar-line timings (96 BPM, bar 2.5 s), so `work/music.wav` is reused unchanged. 16:9 only. Stage port 47316.

**Angle:** not scale — control. A few agents of your own, on your computer, and you hold every switch.
**Share caption:** "Your agents. Your computer. Your call."

## What changed from v3

v3 had ~12 s of frozen frames (ffmpeg `freezedetect=n=0.003:d=0.8`) and long fades through a near-empty canvas. v5 has no frozen span before the final poster hold (from 18.5 s).

- **Hook moves from frame 0:** a crowd of ~70 agent tiles ripples in around the fox ("You don't need a hundred agents.") and thins out until the fox is alone.
- **Continuous gentle motion:** every scene has a slow push-in; tiles bob; the setup stepper counts 1 → 2 → 3 and "How long?" changes 30 min → 1 hour under the cursor; "Starting 2 of 3…" after Start; the job bar's time-left clock and token meter tick; each agent's focus line updates with a soft highlight; the Needs-you card pulses while waiting and the frog wiggles.
- **Transitions:** the outgoing scene fades and lifts over 0.2 s and the next one rises in straight after. No ghosted double captions, no stretch of blank canvas.
- **Kill confirmation is readable:** clicks moved earlier (Pause 15.31, +30 min 15.94, Kill 16.25), so "Kill this agent? It cannot be undone." holds for ~1.2 s on a red-tinted row with larger text.
- **Outro:** `npm run setup` plus `github.com/latent-spaces/minions` (the repo is public now).

## Storyboard

| Bar | Time | Scene |
|---|---|---|
| 1 | 0.0–2.5 | Crowd of tiles thins to one fox. "You don't need a hundred agents." |
| 2 | 2.5–5.0 | Cat and frog join. "Just a few. And you're in charge." |
| 3 | 5.0–7.3 | Wordmark + "Your own little swarm of coding agents." |
| 4 | 7.3–10.0 | Setup card: stepper to 3, 1 hour, Start → Started, "Starting n of 3…". "Nothing starts without your yes." |
| 5 | 10.0–12.5 | Job bar ticking over three working agents whose focus updates. "See what each one is doing." |
| 6 | 12.5–15.0 | Frog's Needs-you card answered. "They ask you when they're stuck." |
| 7 | 15.0–17.4 | Pause → Paused; +30 min; Kill → confirmation. "Pause it. Kill it. Give it more time." |
| 8 | 17.4–20.0 | Wordmark, "Your agents. Your computer. Your call.", `npm run setup`, repo URL; hold from ~19.2 s. |

Synthetic data only. Setup values (1 hour, 500K token cap) are illustrative UI text, not claims.
