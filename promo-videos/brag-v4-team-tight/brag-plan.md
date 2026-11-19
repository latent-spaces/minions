# Minions — brag plan (v4: team, tightened)

A revision of `brag-v1-team`, with the same angle, music (`work/music.wav`, 120 BPM) and 20.0 s length. What changed and why:

- **No still frames.** Freeze detection showed ~8 s of frozen frames in v1. Each scene now has a slow camera push-in, and the characters hop on the beat. Only the final ~1 s poster hold is still.
- **Moving from frame 0.** The hook caption slides in and the fox hops on every beat.
- **Shorter mid-video wordmark** (4.0–5.5 s instead of 4.0–6.5 s), so the terminal starts at 5.5 s and the typing gets 2 s.
- **Map labels fit.** Focus lines are short, so nothing is cut off. `sonnet-levels` switches from Working to Needs you on screen at 12.5 s, which sets up the next scene.
- **Faster Needs-you scene.** The cursor arrives 0.5 s sooner and the dog hops once the answer is sent.
- **Outro has a destination.** The Pause and Kill chips are replaced by `github.com/latent-spaces/minions` (the repo is public now). The characters hop until 19.0 s.
- Rendered at 16:9 only. Square was not rendered.

Stage port: 47315.

---


**What it is:** Minions runs a small team of Claude Code / Codex agents on your own computer, in the background, talking to each other through one project, while you steer from your chat.
**For:** developers who already use one coding agent and want several working at once without losing control.
**Sets it apart:** local (one engine, one SQLite file), agents are a visible team (animal characters on a live map), they ask *you* when stuck, and nothing starts without your yes.
**Hook:** one lonely fox agent → a whole swarm pops in.
**Share caption:** "One coding agent is a chat. Minions is a team."

Tone: `default` — punchy, playful, clean. Landscape 1920×1080, 30fps, 20.0s.
Identity: the app's Gallery Workspace system — white canvas, ink #141414, accent #0066ff, Inter Variable, italic wordmark, the real Offbeat animal characters (pose atlases) and the real `CommunicationMap`.

Music: 120 BPM (beat = 0.5s, bar = 2s), C major-ish pluck + soft kick/clap, cuts on beats.

## Storyboard (all real components/assets; data is synthetic)

| # | Time | Beats | Scene |
|---|---|---|---|
| 1 Hook | 0.0–2.0 | 1–4 | One fox (real CharacterAvatar) alone. "One coding agent is a chat." |
| 1b | 2.0–4.0 | 5–8 | Seven more animals pop in on eighth notes. "Minions gives you a team." |
| 2 Reveal | 4.0–6.5 | 9–13 | Italic wordmark "Minions" + "Your own little swarm of coding agents." |
| 3 Start | 6.5–10.0 | 14–20 | Chat window types the real start prompt ("Use the minions skill: create a Minions project…"); reply "Project created · 3 agents started". Caption "Start it from Claude Code or Codex." |
| 4 Map | 10.0–14.0 | 21–28 | Real CommunicationMap: you + 6 agents, messages flying. "They work in the background — and talk to each other." |
| 5 Needs you | 14.0–17.0 | 29–34 | Cat agent raises its hand (needs_you pose); real Needs-you card markup with a question; choice A gets picked, Send answer. "They ask when they need you." |
| 6 Outro | 17.0–20.0 | 35–40 | Wordmark + "Runs on your computer. Pause or kill any time." + `npm run setup`. |

Privacy: no real names/data. Agent names are generic (`claude-builder`, `codex-tooling`…), the person is "You". The repo is private, so the outro names the setup command, not a URL.

## New-logo render (17 Nov 2026)

`brag-newlogo.mp4` (16:9) and `brag-1x1-newlogo.mp4` (square), rendered against the public `main` (`e6d6888`). Changes from `brag.mp4`:

- The italic "Minions" text is replaced by the current `BrandLogo` (gradient creature mark + `minions` wordmark) in the reveal and the outro.
- The terminal types the copyable prompt from the current README, "Use the minions skill to build me a 2D game with a small swarm.", instead of the removed `claude-prompt` text.
- Icons come from the app's Phosphor set (`apps/web/src/ui/icons`) instead of the removed `lucide-react`. The map is the current `CommunicationMap`.
- Square only: the outro row of eight characters is a little smaller so it stays inside the frame.

The stage source in `work/stage/` now needs the current `main`; the older `brag.mp4` was rendered from `3baa57a`.
- The outro keeps only `github.com/latent-spaces/minions`; the `npm run setup` pill is gone (owner, 17 Nov 2026).
- The big logo uses halo-free copies of the brand PNGs (`promo-videos/brand/*-clean.png`). The app's originals carry near-invisible pixels that smudge above the wordmark at video size.
- The map caption reads "They work in the background and talk to each other." without the dash (owner, 17 Nov 2026).
