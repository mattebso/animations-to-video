# animations-to-video

A Claude Code skill that converts HTML animations (Claude Design exports, Hermes-style explainers, React Stage zips) into rendered video files — MP4, ProRes 4444 with alpha, ProRes 422 HQ, and friends. Up to 4K at any common frame rate.

Built at [Metics Media](https://www.youtube.com/@MeticsMedia) for our editorial workflow — Claude Design generates HTML animations, an editor needs them as drop-in video clips for ScreenFlow / Premiere / After Effects. Open-sourced because it's useful for anyone doing the same.

## What it does

You hand Claude an HTML file or a Claude Design zip and say *"convert this to a video."* Claude will:

1. Extract the zip (if applicable) and inspect what's inside
2. Ask you (via a chat prompt) for resolution, frame rate, and output format
3. Spawn headless Chrome, drive the animation frame-by-frame using its seek API
4. Pipe PNGs into ffmpeg to write the final video file
5. Place the output where you asked

## Install

Two steps. Takes about three minutes the first time (puppeteer downloads ~200 MB of Chromium).

```bash
# 1. Clone the repo into your Claude Code skills folder
git clone https://github.com/mattebso/animations-to-video.git ~/.claude/skills/animations-to-video

# 2. Install dependencies
cd ~/.claude/skills/animations-to-video && npm install
```

You also need `ffmpeg` available on `$PATH`:

```bash
brew install ffmpeg
```

That's it. Next time you open a Claude Code session, the skill auto-loads.

### Updating

```bash
cd ~/.claude/skills/animations-to-video && git pull && npm install
```

## Usage

In a Claude Code session, say things like:

- "Convert this zip to a video: @some-animation.zip"
- "Render this as 4K 60fps MP4: @intro.html"
- "Turn these lower thirds into ProRes .movs with alpha: @lower_thirds.zip"
- "Same flow as the others" — Claude will reuse the settings from your last render

Claude prompts you for resolution / fps / format, runs the render in the background, and tells you when it's done.

## Supported inputs

- **Single HTML file** — any animation exposing a `window.setStoryTime(s)` or `window.__seek(t)` API
- **Claude Design zip** — extracted automatically; usually contains one HTML + an `assets/` folder
- **Folder of HTMLs** — batch-renders each one (e.g., a `lower_thirds/` directory)
- **React Stage zip** — supported once `animations.jsx` has been patched (see `templates/react-stage-patch-notes.md`)

## Supported outputs

| Preset                | Use case                                            | Codec         | Alpha |
|-----------------------|-----------------------------------------------------|---------------|-------|
| `prores4444-alpha`    | ScreenFlow / AE / Premiere compositing              | ProRes 4444   | ✓     |
| `prores4444-opaque`   | Same workflow but you want the page's background    | ProRes 4444   | ✗     |
| `prores422hq`         | Editing intermediate, smaller files                 | ProRes 422 HQ | ✗     |
| `h264`                | Direct YouTube/social upload                         | H.264         | ✗     |

Resolution: 1080p or 4K (3840×2160). Frame rate: 24, 30, or 60 fps.

## Repo layout

```
animations-to-video/
├── README.md                                # this file
├── LICENSE
├── SKILL.md                                 # the instructions Claude reads when the skill triggers
├── package.json
├── package-lock.json
├── scripts/
│   └── render.js                            # the renderer (puppeteer + ffmpeg)
└── templates/
    └── react-stage-patch-notes.md           # manual patch guide for React Stage animations.jsx
```

`node_modules/` is gitignored — `npm install` populates it after cloning.

## Direct CLI usage (skip Claude)

If you want to render without going through Claude:

```bash
node ~/.claude/skills/animations-to-video/scripts/render.js \
  --input  /path/to/animation.html \
  --out    /path/to/output.mov \
  --res    2160 \
  --fps    30 \
  --format prores4444-alpha
```

Flags:

- `--res 2160` or `--res 1080`
- `--fps 24` | `30` | `60`
- `--format prores4444-alpha` | `prores4444-opaque` | `prores422hq` | `h264`

## How it works

Headless Chrome loads the HTML at a 1920×1080 CSS viewport with `deviceScaleFactor=2`, so screenshots come out at 3840×2160 (4K). The renderer auto-detects which seek API the page exposes (`window.setStoryTime`, `window.__seek`, etc.), then for each frame:

1. Calls the seek function with the current timestamp
2. Waits two requestAnimationFrames for React to commit + paint
3. Captures a PNG with `omitBackground: true` (when rendering alpha)
4. Pipes the PNG to ffmpeg over stdin

ffmpeg writes the chosen codec with the chosen pixel format.

## Authoring notes for Claude Design HTMLs

If you're writing HTML animations that this skill should render cleanly, expose one of:

```js
// Pattern A — Hermes / Claude Design convention
window.setStoryTime = (s) => { /* seek to s seconds */ };
window.STORY_DURATION = 39.3;       // seconds
window.__storyReady = true;          // set when ready to be seeked

// Pattern B — generic
window.__seek = (s) => { /* seek to s seconds */ };
window.__duration = 39.3;            // seconds
window.__ready = true;               // set when ready
```

Either works. Pattern A is the convention used by Claude Design today.

## Known limits

- **React Stage projects need manual patching first.** The framework runs an interactive playback bar, autoplay, keyboard shortcuts, and a localStorage persist effect that all need to be gated behind `RENDER_MODE`. See `templates/react-stage-patch-notes.md` for the diff to apply. (Future versions of this skill may automate the patch.)
- **Carousel / realtime-only animations** (no seek API, just autoplaying videos) aren't supported — those need a different capture strategy.
- **First-run cost.** `npm install` downloads ~200 MB of Chromium. Fine on a creative's machine, awkward in a CI environment.

## Contributing

PRs and issues welcome. If you hit something the skill doesn't handle — a new animation API shape, a new format need, a bug — open an issue or a PR.

Bug reports should include:

- The HTML or zip you tried to render (or a minimal reproduction)
- The settings you chose (resolution / fps / format)
- The output from the renderer (terminal logs)

For larger new features, open an issue first to discuss before sinking time into a PR.

## License

MIT. See [LICENSE](./LICENSE).
