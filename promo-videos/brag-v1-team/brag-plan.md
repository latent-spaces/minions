# Minions — brag plan

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
