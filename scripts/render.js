// animations-to-video renderer
//
// Drives a Claude Design HTML animation frame-by-frame in headless Chrome,
// pipes PNG screenshots into ffmpeg, and writes a video file.
//
// Auto-detects the animation's seek API:
//   - window.setStoryTime(s) + window.STORY_DURATION + window.__storyReady  (Hermes / Claude Design)
//   - window.__seek(s)       + window.__duration     + window.__ready        (React Stage, post-patch)
//   - window.__seek(ms)      + window.__duration                              (legacy title cards)
//
// Usage:
//   node render.js \
//     --input  /abs/path/to/animation.html \
//     --out    /abs/path/to/output.mov \
//     --res    2160        # or 1080
//     --fps    30          # 24 | 30 | 60
//     --format prores4444-alpha  # prores4444-alpha | prores4444-opaque | prores422hq | h264

const puppeteer = require('puppeteer');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const { pathToFileURL } = require('url');

// ── arg parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    }
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));

const INPUT  = args.input;
const OUT    = args.out;
const RES    = parseInt(args.res    || '2160', 10);
const FPS    = parseInt(args.fps    || '30',   10);
const FORMAT = args.format || 'prores4444-alpha';

if (!INPUT || !OUT) {
  console.error('usage: render.js --input <html> --out <file> [--res 2160|1080] [--fps 24|30|60] [--format prores4444-alpha|prores4444-opaque|prores422hq|h264]');
  process.exit(2);
}

// ── ffmpeg presets ──────────────────────────────────────────────────────
const FFMPEG_FORMATS = {
  // ProRes 4444 with alpha — yuva444p10le carries alpha, profile 4 = 4444
  'prores4444-alpha':  ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-qscale:v', '11', '-vendor', 'apl0'],
  // ProRes 4444 without using alpha (background baked in, but same container)
  'prores4444-opaque': ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-qscale:v', '11', '-vendor', 'apl0'],
  // ProRes 422 HQ — smaller editing codec, no alpha
  'prores422hq':       ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le',  '-qscale:v', '9',  '-vendor', 'apl0'],
  // H.264 — small, no alpha, broad compatibility
  'h264':              ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p'],
};
if (!FFMPEG_FORMATS[FORMAT]) {
  console.error(`unknown --format: ${FORMAT}. options: ${Object.keys(FFMPEG_FORMATS).join(', ')}`);
  process.exit(2);
}

const ALPHA = FORMAT === 'prores4444-alpha';

// ── Babel detection ─────────────────────────────────────────────────────
// Pages that use in-browser Babel (`<script type="text/babel">`) crash
// Chromium when combined with deviceScaleFactor=2 — the JSX compile + a
// hi-DPR render context is too much for headless. Workaround: render
// Babel pages at DSF=1 (native CSS resolution) and upscale via ffmpeg.
const sourceHtml = fs.readFileSync(INPUT, 'utf8');
const USES_BABEL = /<script[^>]*type=["']text\/babel["']/i.test(sourceHtml);

// ── viewport math ───────────────────────────────────────────────────────
// CSS viewport stays at 1920×1080 (so the HTML lays out at its designed size).
// For non-Babel pages: deviceScaleFactor scales the screenshot natively.
// For Babel pages: DSF=1 always, ffmpeg upscales.
const WIDTH  = 1920;
const HEIGHT = 1080;
const DSF    = (USES_BABEL || RES === 1080) ? 1 : 2;
// Output pixel dimensions (what we want in the final file)
const OUT_W  = RES === 2160 ? 3840 : 1920;
const OUT_H  = RES === 2160 ? 2160 : 1080;
// Whether ffmpeg needs to upscale (screenshot smaller than target)
const NEEDS_UPSCALE = (WIDTH * DSF) < OUT_W;

// ── main ────────────────────────────────────────────────────────────────
(async () => {
  console.error(`[a2v] input:  ${INPUT}`);
  console.error(`[a2v] out:    ${OUT}`);
  console.error(`[a2v] capture: ${WIDTH * DSF}×${HEIGHT * DSF} (DSF=${DSF})${USES_BABEL ? ' [Babel path]' : ''}`);
  console.error(`[a2v] target: ${OUT_W}×${OUT_H}${NEEDS_UPSCALE ? ' (ffmpeg upscale)' : ''}`);
  console.error(`[a2v] fps:    ${FPS}`);
  console.error(`[a2v] format: ${FORMAT}${ALPHA ? ' (alpha)' : ''}`);

  const launchArgs = [
    `--window-size=${WIDTH},${HEIGHT}`,
    '--hide-scrollbars',
    '--disable-web-security',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
  ];
  // Only pass --force-device-scale-factor when DSF > 1 (avoids crash on Babel pages).
  if (DSF > 1) launchArgs.push(`--force-device-scale-factor=${DSF}`);
  // --default-background-color=00000000 used to be passed for alpha mode,
  // but it triggers "Requesting main frame too early!" on Babel pages.
  // omitBackground:true on the screenshot is sufficient on its own.

  const browser = await puppeteer.launch({
    // Old headless mode: more stable than 'new' for pages with in-browser
    // Babel + alpha rendering. The 'new' mode hits "Requesting main frame
    // too early!" on Babel-heavy pages mid-navigation.
    headless: true,
    args: launchArgs,
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: DSF },
  });

  const page = await browser.newPage();
  // Note: viewport is already set via `defaultViewport` in launch options above.
  // An explicit page.setViewport() here races with Babel-using pages (CDP
  // emulation calls fail with "Session closed") and is redundant in any case.

  // Build the URL query string.
  // - autoplay=0: pause at t=0, we drive time
  // - bg=transparent: Claude Design HTML convention; ignored if the page doesn't honor it
  // - render=1: React Stage convention; activates the patched RENDER_MODE
  const params = new URLSearchParams();
  params.set('autoplay', '0');
  if (ALPHA) params.set('bg', 'transparent');
  const inputDir = path.dirname(path.resolve(INPUT));
  if (fs.existsSync(path.join(inputDir, 'animations.jsx'))) {
    params.set('render', '1');
  }

  // pathToFileURL properly encodes spaces and other URL-unsafe chars in the path.
  const fileUrl = pathToFileURL(path.resolve(INPUT));
  fileUrl.search = params.toString();
  const url = fileUrl.href;
  console.error(`[a2v] loading ${url}`);
  // 'load' fires when DOMContentLoaded + onload have fired, regardless of pending
  // network. networkidle0 hangs/detaches with in-browser Babel + Google Fonts pages.
  // The page's seek API is detected via waitForFunction below, so we don't need to
  // wait for "network idle" here.
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  // Belt-and-suspenders transparency: some HTMLs set the gradient on both
  // `html, body` but the `?bg=transparent` override only targets `body`.
  if (ALPHA) {
    await page.addStyleTag({ content: 'html, body { background: transparent !important; }' });
  }

  // Hide preview-only UI so it doesn't end up in the render.
  await page.addStyleTag({ content: `
    .replay, .playback-bar, .controls, [data-render-hide] { display: none !important; }
  `});

  // Detect which seek API the page exposes.
  const detected = await page.waitForFunction(() => {
    if (window.__storyReady === true && typeof window.setStoryTime === 'function' && typeof window.STORY_DURATION === 'number') {
      return { api: 'setStoryTime', duration: window.STORY_DURATION, unit: 's' };
    }
    if (window.__ready === true && typeof window.__seek === 'function' && typeof window.__duration === 'number') {
      return { api: '__seek', duration: window.__duration, unit: 's', awaitsVideoSeeks: true };
    }
    if (typeof window.__seek === 'function' && typeof window.__duration === 'number') {
      // No __ready flag → assume the legacy title card pattern (ms).
      // Heuristic safety: if duration looks like seconds (< 600), treat as seconds.
      const looksLikeMs = window.__duration > 600;
      return { api: '__seek', duration: window.__duration, unit: looksLikeMs ? 'ms' : 's' };
    }
    return false;
  }, { timeout: 30000, polling: 200 });

  const meta = await detected.jsonValue();
  const durationSec = meta.unit === 'ms' ? meta.duration / 1000 : meta.duration;
  console.error(`[a2v] api: ${meta.api}, duration: ${durationSec.toFixed(2)}s (raw=${meta.duration} ${meta.unit})`);

  // Let fonts settle and give the page a beat to commit initial state.
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
  await new Promise(r => setTimeout(r, 600));

  const frameCount = Math.ceil(durationSec * FPS);
  console.error(`[a2v] rendering ${frameCount} frames`);

  // Spawn ffmpeg. If the screenshot is smaller than the requested output
  // resolution, ffmpeg upscales with lanczos (clean for vector-style content).
  const ffArgs = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-framerate', String(FPS),
    '-i', '-',
    ...(NEEDS_UPSCALE ? ['-vf', `scale=${OUT_W}:${OUT_H}:flags=lanczos`] : []),
    ...FFMPEG_FORMATS[FORMAT],
    '-r', String(FPS),
    OUT,
  ];
  const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  ff.on('error', err => { console.error('[a2v] ffmpeg spawn error:', err); process.exit(1); });

  // ── render loop ───────────────────────────────────────────────────────
  const apiName  = meta.api;
  const unit     = meta.unit;
  const awaitsV  = !!meta.awaitsVideoSeeks;

  for (let f = 0; f < frameCount; f++) {
    const tSec = f / FPS;
    const tArg = unit === 'ms' ? tSec * 1000 : tSec;

    await page.evaluate((arg, api, awaitsVideos) => {
      if (awaitsVideos) window.__pendingVideoSeeks = [];
      if (api === 'setStoryTime') return window.setStoryTime(arg);
      return window.__seek(arg);
    }, tArg, apiName, awaitsV);

    // Double-rAF: let React commit + layout effects run, then a clean paint
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

    // Await any video element seeks queued by the page (React Stage pattern)
    if (awaitsV) {
      await page.evaluate(() => Promise.all(window.__pendingVideoSeeks || []).catch(() => {}));
    }

    const buf = await page.screenshot({
      type: 'png',
      omitBackground: ALPHA,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });

    if (!ff.stdin.write(buf)) {
      await new Promise(r => ff.stdin.once('drain', r));
    }

    if (f % 30 === 0 || f === frameCount - 1) {
      const pct = ((f + 1) / frameCount * 100).toFixed(1);
      console.error(`[a2v]   frame ${f + 1}/${frameCount} (${pct}%, t=${tSec.toFixed(2)}s)`);
    }
  }

  ff.stdin.end();
  await new Promise((resolve, reject) => {
    ff.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
  });

  await browser.close();

  // Report
  const stat = fs.statSync(OUT);
  const mb = (stat.size / (1024 * 1024)).toFixed(1);
  console.log(`[a2v] done: ${OUT} (${mb} MB, ${durationSec.toFixed(2)}s, ${frameCount} frames)`);
})().catch(err => {
  console.error('[a2v] error:', err);
  process.exit(1);
});
