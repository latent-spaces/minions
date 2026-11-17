# Minions promo videos

Every promo render made so far, with the plan, copy, music, source code and
check stills needed to revise or re-render it. Nothing is overwritten: each cut keeps its own folder or numbered file.

All on-screen data is synthetic. The stages render real Minions UI components
(`apps/web/src/ui`) with made-up agents and projects. No live engine, credentials or model runs are involved.

Videos, audio and images are stored with **Git LFS**. Run `git lfs install` before
cloning or pulling, or you'll get small pointer files instead of the media.

## The cuts

| Folder | Angle | Renders | Length |
|---|---|---|---|
| [`timelapse/`](timelapse/) | Time-lapse of a swarm working on the live Communication map | `renders/v1-swarm-timelapse-1x1.mp4`, `minions-timelapse-v2…v5-20agents.mp4` | ~30 s |
| [`brag-v1-team/`](brag-v1-team/) | "One coding agent is a chat. Minions is a team." Punchy and playful, 120 BPM | `brag.mp4` (16:9), `brag-1x1.mp4` (square) | 20 s |
| [`brag-v2-chaotic/`](brag-v2-chaotic/) | "One agent? Cute." All caps and fast, 150 BPM | `brag.mp4`, `brag-1x1.mp4` | 20 s |
| [`brag-v3-your-call/`](brag-v3-your-call/) | "Your agents. Your computer. Your call." Calm and warm, 96 BPM | `brag.mp4`, `brag-1x1.mp4` | 20 s |

Each `brag-*` folder contains:

- `brag-plan.md`: angle, tone, palette, music and the storyboard with scene timings. Start here to revise.
- `share-copy.txt`: the caption to post with the video.
- `brag.jpg`, `brag-1x1.jpg`: poster frames.
- `work/stage/`: the animated React page that gets recorded (`entry.tsx`, `stage.css`, `index.html`, `start.mjs` dev server).
- `work/capture.mjs`: deterministic frame capture (Playwright, fake clock, 30 fps).
- `work/music.py` → `work/music.wav`: the generated soundtrack.
- `work/check/`, `work/stills/`, `work/sqstills/`: contact sheets and key frames for review.

`timelapse/` contains `source/` (the stage `timelapse.tsx` plus earlier `timelapse.v1/v3/v4` variants, `serve.mjs`, `record.mjs`), `renders/` and `contact-sheets/`.

The raw PNG frame dumps (~1 GB) aren't included because the capture scripts regenerate them.

## Re-rendering

The stages import the app's real components. They were rendered from `main` at
**`3baa57a`** (16 Nov 2026). Since then, `apps/web/src/ui/claude-prompt` and the
`lucide-react` dependency have been removed from `main`, so re-render against that commit:

```sh
git worktree add ../minions-promo 3baa57a
cp -R promo-videos ../minions-promo/
cd ../minions-promo && npm install

# Brag cut, e.g. v3 (stage ports: v1 47312, v2 47313, v3 47314; capture.mjs knows its own)
node promo-videos/brag-v3-your-call/work/stage/start.mjs &                 # preview in a browser
node promo-videos/brag-v3-your-call/work/capture.mjs frames all            # 16:9 PNG frames
FMT=square node promo-videos/brag-v3-your-call/work/capture.mjs sqframes all   # 1:1 frames
node promo-videos/brag-v3-your-call/work/capture.mjs check 2,5,9           # stills at given seconds
(cd promo-videos/brag-v3-your-call/work && python3 music.py)               # writes music.wav (numpy, scipy)

# Time-lapse
PORT=47320 node promo-videos/timelapse/source/serve.mjs &
node promo-videos/timelapse/source/record.mjs http://127.0.0.1:47320/ tl-frames
```

Encode the frames with ffmpeg, for example (brag frames are `f%04d.png`, time-lapse frames are `f%05d.png`):

```sh
ffmpeg -framerate 30 -i frames/f%04d.png -i music.wav -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac -shortest brag.mp4
```

To stay on current `main` instead, swap the `lucide-react` icons for `@phosphor-icons/react` and inline the start-prompt text from `claude-prompt`.

When you make a new cut, add a new numbered file or folder. Don't replace an existing render.
