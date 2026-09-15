# QuickRate

Rate the scene you are watching on a 0.0 to 10.0 scale without leaving the player.

## Install

1. Copy the `QuickRate` folder into your Stash plugins directory.
   On Unraid that is usually inside the container at `/root/.stash/plugins/`:
   ```bash
   docker cp QuickRate Stash:/root/.stash/plugins/
   ```
2. Settings → Plugins → **Reload Plugins**.
3. Hard-reload the browser tab (Ctrl+Shift+R).

No backend process. It is a UI-only plugin.

## Use

Open a scene and press **R**.

| Key | Action |
|---|---|
| `R` | Open the panel (press again to close) |
| digits | Type the rating. `8` `5` gives 8.5, `1` `0` gives 10.0 |
| `.` | Explicit decimal point, `8` `.` `5` also gives 8.5 |
| `Enter` | Save |
| `←` `→` | Adjust by 0.1 |
| `↑` `↓` | Adjust by 0.5 |
| `X` or `Delete` | Clear the rating |
| `Esc` | Undo: restores the rating the scene had when the panel opened, even if auto-save already wrote your edit |
| drag | Set the value on the track with the mouse |

The panel opens preloaded with the scene's existing rating, so you can nudge it
with the arrow keys instead of retyping.

## Notes

- Stash stores ratings internally as `rating100` (0-100), so 8.5 is written as 85.
  Nothing is lost. If you set Stash's rating display to decimal (Settings →
  Interface → Rating system), the scene page shows the same value.
- On Stash builds older than 0.24 the schema only has `rating` (1-5 stars). The
  plugin detects this and rounds, so 8.5 becomes 4 stars. Upgrade Stash for full
  precision.
- The scene page's own rating widget is updated through Stash's Apollo cache
  when `PluginApi` exposes the client. On builds where it does not, the value is
  still written to the database and shows after a reload.
- `R` is captured only on `/scenes/<id>` pages, and ignored while you are typing
  in any input field.
- Clicking the video while the panel is open closes the panel and nothing else.
  The click is swallowed so the video does not pause. Clicking the control bar
  (play, next, seek) still works and commits the rating on the way through.
  With no panel open the video behaves normally.

## Debug

```js
localStorage.setItem("quickRateDebug", "1");
```

Reload, then watch the browser console.
