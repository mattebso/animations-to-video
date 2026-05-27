# React Stage `animations.jsx` patch

Claude Design's React Stage framework ships HTML+JSX bundles where `animations.jsx` is the runtime that drives the composition: it autoplays, listens for keyboard shortcuts, persists time to localStorage, auto-scales to the viewport, and renders an interactive `PlaybackBar` over the composition.

To render the composition deterministically as a video, we need to:

1. Disable all of that interactive UI
2. Expose `window.__seek(s)`, `window.__duration`, and `window.__ready` so the renderer can drive time frame-by-frame

This is done by adding a `RENDER_MODE` flag that activates when the URL has `?render=1`, and gating the interactive behavior behind `if (RENDER_MODE) return;` checks.

## What to add

At the top of `animations.jsx`, just below the React import, add:

```js
const RENDER_MODE = (() => {
  try { return new URLSearchParams(location.search).has('render'); }
  catch { return false; }
})();
window.RENDER_MODE = RENDER_MODE;
```

## What to gate behind `RENDER_MODE`

Find the `Stage` component (or whatever the top-level composition component is). Inside it:

### Time state — start at 0 in RENDER_MODE

```js
const [time, setTime] = useState(RENDER_MODE ? 0 : /* whatever was here before */);
```

### Playing state — force false in RENDER_MODE

```js
const [playing, setPlaying] = useState(autoplay && !RENDER_MODE);
```

### Persist effect — skip in RENDER_MODE

```js
useEffect(() => {
  if (RENDER_MODE) return;
  // ...existing localStorage save logic...
}, [time, /* ... */]);
```

### Auto-scale effect — force scale=1 in RENDER_MODE

```js
useEffect(() => {
  if (RENDER_MODE) { setScale(1); return; }
  // ...existing resize listener...
}, []);
```

### Animation loop — skip in RENDER_MODE

```js
useEffect(() => {
  if (RENDER_MODE) return;
  // ...existing requestAnimationFrame loop driving setTime(t)...
}, [playing, duration]);
```

### Keyboard shortcuts — skip in RENDER_MODE

```js
useEffect(() => {
  if (RENDER_MODE) return;
  // ...existing window.addEventListener('keydown', ...) ...
}, []);
```

### Render output — strip the PlaybackBar in RENDER_MODE

```js
if (RENDER_MODE) {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {/* the actual composition content, without the PlaybackBar */}
    </div>
  );
}
// ...existing return with PlaybackBar...
```

### Expose the seek API

Inside the Stage component, add a useEffect that publishes the renderer's hooks once duration is known:

```js
useEffect(() => {
  if (!RENDER_MODE) return;
  window.__seek     = (t) => setTime(Math.max(0, Math.min(duration, t)));
  window.__duration = duration;
  window.__ready    = true;
}, [duration]);
```

## How to verify the patch worked

After patching, load `file:///path/to/animation.html?render=1` in a regular browser and open DevTools:

```js
window.__ready       // → true
window.__duration    // → some number (seconds)
window.__seek(1.5)   // → composition jumps to t=1.5s with no PlaybackBar visible
```

If all three work, the renderer can drive it.

## Video element sync (optional)

If the composition contains `<video>` elements that need to seek along with `__seek`, the patcher should also expose `window.__pendingVideoSeeks` — an array the renderer can wait on between frames. This is only needed for compositions with embedded video. Most don't have any.

```js
// At seek time, before calling video.currentTime = t:
window.__pendingVideoSeeks = window.__pendingVideoSeeks || [];
window.__pendingVideoSeeks.push(new Promise(resolve => {
  video.addEventListener('seeked', resolve, { once: true });
}));
video.currentTime = t;
```
