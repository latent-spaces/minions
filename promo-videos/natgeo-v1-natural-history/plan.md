# Minions: A Natural History (nature-documentary cut)

A gently funny nature documentary in which the minions are the wildlife. A British naturalist watches them self-organise, talk to each other, post what they did and ask for help. The human angle is a small beat: it's Friday afternoon, the agents are hard to spin up and track, there are tokens left for the week, so it's time for a bug bash.

Voice: Kokoro TTS `bm_george` (the owner's pick from the auditions in `voices/`), `lang_code='b'`, speed 0.88 for the film and 0.9 for the social lines. Music and sound effects are synthesised with numpy (string pads, pizzicato, harp, timpani, blips) and ducked under the voice.

## Renders

| File | Format | Length | Notes |
|---|---|---|---|
| `minions-natgeo-v1.mp4` | 16:9 | 1:53 | First full film, six chapters |
| `minions-natgeo-v2.mp4` | 16:9 | 1:53 | The feed is the real `ProjectUpdates` with screenshot posts and a swiped carousel; the last line is now "And now… a nice cup of tea." (owner: the old last line didn't suit George's voice) |
| `minions-natgeo-v3-square.mp4` | 1:1 | 48 s | Tight social cut: title band, big captions, camera moves over the same stage (`work/stage/social.json`) |

Chapters of the full film: I Release (Friday, terminals, token meter, a New task card), II Communication (the real `CommunicationMap` and an overheard transcript), III Dividing the work (fox and cat on the bug board, owl is the self-appointed team lead), IV The feed, V Asking for help (Needs-you card from the frog), VI Rest (job bar, the agents stop), then the ending.

## Source (`work/`)

- `stage/entry.tsx` and `stage/stage.css`: the whole film as a React stage. It renders real Minions components from `apps/web/src/ui` with synthetic data. `?fmt=square` gives the social layout.
- `stage/shots.html` → `shots.mjs` → `stage/shots/*.png`: mock screens of a made-up app, "Tidy", used as feed screenshots.
- `capture.mjs`: Playwright with a fake clock, 30 fps. `FMT=square` captures the social cut.
- `narration.json`, `tts.py`, `tts1.py` → `vo/*.wav`; `social/` holds the social lines and their mix.
- `music.py` → `mix.wav` (full film); `social/music.py` → `social/mix.wav`.
- `check/`, `vcheck/`, `scheck/`, `*sheet.png`: review stills and contact sheets.

Rendered from `main` at `c1b5d94` (19 Nov 2026). Stage port 47321. The ~660 MB of PNG frames aren't included; `capture.mjs` regenerates them.

```sh
node promo-videos/natgeo-v1-natural-history/work/stage/start.mjs &
cd promo-videos/natgeo-v1-natural-history/work
node capture.mjs frames all 113              # 16:9, 113 s
FMT=square node capture.mjs sframes all 48.1 # 1:1, 48.1 s
ffmpeg -framerate 30 -i frames/f%04d.png -i mix.wav -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac -shortest out.mp4
```

Kokoro needs espeak-ng (`brew install espeak-ng`) and `PHONEMIZER_ESPEAK_LIBRARY` / `ESPEAK_DATA_PATH` pointing at it.

All data on screen is synthetic.
