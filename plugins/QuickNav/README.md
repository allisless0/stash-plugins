# QuickNav

Double-click the right half of the video to play the next scene in the queue,
the left half for the previous one. Double-click-to-fullscreen is suppressed.

## Install

1. Copy the `QuickNav` folder into your Stash plugins directory:
   ```bash
   docker cp QuickNav Stash:/root/.stash/plugins/
   ```
2. Settings → Plugins → **Reload Plugins**.
3. Hard-reload the browser tab (Ctrl+Shift+R).

UI-only plugin. No backend.

## Use

| Action | Result |
|---|---|
| Double-click right half of video | Next scene in queue |
| Double-click left half of video | Previous scene in queue |
| Shift + double-click | Normal fullscreen toggle |
| Double-click the control bar | Ignored, controls work as usual |

A brief ⏭ / ⏮ marker appears where you clicked so you know it registered.

## How it navigates

Stash already ships queue shortcuts: `p n` for next and `p p` for previous,
bound through Mousetrap. QuickNav triggers those rather than reimplementing
queue traversal, so continue-play, queue order and browser history behave
exactly as they do when you use the keyboard.

There are two fallbacks if Mousetrap isn't reachable: clicking Stash's own
queue controls, then synthesising the key sequence.

## Requires a queue

Next and previous mean *next in the scene queue*. If you opened a scene
directly by URL rather than from a list, there is no queue and nothing will
happen. Open scenes from a filtered list, a playlist or a performer page and
the queue is populated automatically.

## Tuning

Two constants at the top of `QuickNav.js`:

- `DEAD_ZONE` — fraction of the video width, centred, where a double-click is
  left alone and still fullscreens. Set to `0.2` if you want a neutral strip in
  the middle. Default `0`.
- `ESCAPE_KEY` — the modifier that restores normal fullscreen behaviour.
  Default `"shiftKey"`. Accepts `"ctrlKey"` or `"altKey"`.

## Debug

```js
localStorage.setItem("quickNavDebug", "1");
```

Reload, then watch the browser console. It logs which navigation method was
used and where the click landed.
