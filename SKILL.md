---
name: animations-to-video
description: Convert HTML animations to rendered MP4 or ProRes .mov video files. Use when handed an HTML animation file, a Claude Design zip (any *.zip from Claude Design containing an HTML animation), or a folder of HTML animations, and asked to render it as a video. Handles up to 4K resolution, alpha channel for ScreenFlow/After Effects/Premiere compositing, and the common seek APIs (window.setStoryTime, window.__seek). Triggers on phrases like "convert this to a video", "render this as MP4", "turn this animation into a .mov", or just being handed a Claude Design HTML/zip after the user has asked for "a video" or "the same as before".
---

# animations-to-video

Render HTML animations to MP4 or ProRes .mov video files using headless Chrome + ffmpeg. Output up to 4K, with optional alpha channel for compositing.

## When to use this skill

The user hands you any of:

- A single `.html` file containing an animation
- A `.zip` from Claude Design (extract first; usually contains one `.html` + assets)
- A folder of HTML animations (e.g., a `lower_thirds/` directory with multiple files)
- A React Stage zip (contains `animations.jsx` alongside the HTML)

...and asks for a rendered video. Common request shapes:

- "Convert this zip to a video"
- "Render this as 4K MP4"
- "Turn these into .movs with alpha channel"
- "Same flow as the others" (after a previous render this session)

## Workflow

### Step 1 — Inspect the input

If the user handed you a `.zip`, extract it to a fresh scratch directory first:

```bash
SCRATCH=$(mktemp -d -t a2v-XXXXXX)
unzip -o "<input.zip>" -d "$SCRATCH"
```

Then enumerate what's inside:

```bash
find "$SCRATCH" -name "*.html" -type f
find "$SCRATCH" -name "animations.jsx" -type f
```

Report what you found in plain English:

- "Found 1 HTML: Skills and Memory Explainer.html — duration is 39.3s"
- "Found 10 HTMLs in `lower_thirds/` — will batch render each one"
- "Found `animations.jsx` — this is a React Stage project. It needs to be patched before rendering (see Step 1a)."

To get the duration, grep the HTML:

```bash
grep -E "const (DURATION|TOTAL)|window\.STORY_DURATION|window\.__duration" "<file.html>" | head -5
```

### Step 1a — React Stage patching (only if `animations.jsx` is present)

React Stage zips need `animations.jsx` patched to expose a seek API and disable interactive UI. Check first whether it's already patched:

```bash
grep -q "RENDER_MODE" "<scratch>/animations.jsx" && echo "already patched" || echo "needs patching"
```

If it needs patching, see `templates/react-stage-patch-notes.md` for the changes. The patch adds:

- A `RENDER_MODE` flag driven by `?render=1` in the URL
- `window.__seek(t)`, `window.__duration`, `window.__ready` exposed when `RENDER_MODE === true`
- Suppression of autoplay, the playback bar, the auto-scale, the persist-to-localStorage effect, the rAF animation loop, and keyboard shortcuts when `RENDER_MODE === true`

For now this patch is manual — use the Edit tool guided by the template. Future versions of this skill may automate it.

### Step 2 — Ask the user for output settings

**Always** prompt via AskUserQuestion with the following three questions in a single call (unless the user explicitly specified all three in their request):

1. **Resolution** (header: "Resolution")
   - **4K (3840×2160) — Recommended**
   - 1080p (1920×1080)

2. **Frame rate** (header: "Frame rate")
   - **30 fps — Recommended**
   - 24 fps
   - 60 fps

3. **Output format** (header: "Format")
   - **ProRes 4444 with alpha (.mov) — Recommended for editing/compositing**
   - ProRes 4444 opaque (.mov) — keeps the page's background
   - H.264 MP4 — small file, no alpha, good for direct delivery
   - ProRes 422 HQ (.mov) — smaller editing codec, no alpha

If the user has already stated some of these in their original request (e.g., "render as MP4 at 60fps"), only ask about the unspecified ones.

If the user has previously rendered files in this session, default the "Recommended" to the same settings they used last time.

### Step 3 — Install puppeteer on first run

The skill's `node_modules/` is created on first use. Check and install:

```bash
SKILL_DIR="$HOME/.claude/skills/animations-to-video"
if [ ! -d "$SKILL_DIR/node_modules/puppeteer" ]; then
  (cd "$SKILL_DIR" && npm install --silent)
fi
```

This takes a couple minutes and downloads ~200 MB (Chromium). Only happens once per machine.

### Step 4 — Render

Run the renderer. Use `run_in_background: true` because renders take several minutes:

```bash
node "$SKILL_DIR/scripts/render.js" \
  --input "<scratch>/<file.html>" \
  --out "<destination>/<output.mov>" \
  --res 2160 \
  --fps 30 \
  --format prores4444-alpha
```

Format values: `prores4444-alpha`, `prores4444-opaque`, `prores422hq`, `h264`.

Resolution values: `2160` (4K) or `1080`. (Other resolutions are technically possible but not exposed in the UI for v1.)

For a multi-HTML batch (e.g., lower thirds), loop over files and render each in turn. They can run sequentially in one background process — don't try to parallelize, the GPU and disk would thrash.

### Step 5 — Place output and report

Place outputs where the user asked. If they didn't say:

- Look for a sibling folder named `03 Exports/`, `04 Animation conversions*/`, `exports/`, or `renders/` in the project tree
- If none found, default to the same directory as the input HTML

Report back: output path, file size, resolution, fps, format, duration.

## Format reference

| Preset                 | Container | Codec      | Pixel format    | Alpha | Typical file size (per minute @ 4K 30) |
|------------------------|-----------|------------|------------------|-------|-----------------------------------------|
| `prores4444-alpha`     | .mov      | ProRes 4444| yuva444p10le     | yes   | ~700 MB                                 |
| `prores4444-opaque`    | .mov      | ProRes 4444| yuva444p10le     | no    | ~600 MB                                 |
| `prores422hq`          | .mov      | ProRes 422 HQ | yuv422p10le  | no    | ~400 MB                                 |
| `h264`                 | .mp4      | H.264      | yuv420p (CRF 16) | no    | ~50 MB                                  |

## Common patterns by use case

- **ScreenFlow compositing over real footage** → `prores4444-alpha`, 4K 30fps
- **After Effects / Premiere editing with a background** → `prores4444-opaque`, 4K 30fps
- **Direct YouTube/social upload** → `h264`, 4K 60fps
- **Lightweight intermediate for further editing** → `prores422hq`, 4K 30fps

## Notes & limits

- The renderer auto-detects which seek API the HTML uses:
  - `window.setStoryTime(s)` + `window.STORY_DURATION` (Hermes / Claude Design pattern)
  - `window.__seek(s)` + `window.__ready` (React Stage, after patching)
  - `window.__seek(ms)` (legacy title cards, time in milliseconds)
- Alpha rendering uses `omitBackground: true` plus a CSS injection forcing `html, body` transparent. If a particular HTML uses a `?bg=` query param convention, the renderer passes `bg=transparent` automatically.
- The renderer hides any `.replay`, `.playback-bar`, or `.controls` elements via injected CSS so preview-only UI doesn't end up in the render.
- React Stage auto-patching is **not** implemented in v1 — see Step 1a.
- The carousel/realtime-only pattern (no seek API, just autoplaying videos) is not supported in v1 — for those, fall back to screen-recording or a custom script.
