# QuickTools

Three shortcuts for the Stash scene player. Each can be turned off in
**Settings > Plugins > QuickTools**.

| Shortcut | Default | What it does |
|---|---|---|
| `R` | on | Rating panel, 0.0 – 10.0 |
| `M` | on | Add a marker at the current position |
| double-click | **off** | Jump through the scene queue |

All three only act on `/scenes/<id>` pages and never fire while you are typing
in a field.

## Rating — `R`

Opens a panel at your cursor. Type a number, drag the bar, or use the arrow
keys. It saves on its own 650 ms after you stop.

| Key | |
|---|---|
| `0`–`9` `.` | type a value; `8` then `5` means 8.5 |
| `←` `→` | ±0.1 |
| `↑` `↓` | ±0.5 |
| `X` | clear the rating |
| `R` `Enter` | save and close |
| `Esc` | undo |

`Esc` is a real undo: it restores whatever the scene was rated when the panel
opened, even if auto-save already wrote your edit.

Clicking the video closes the panel without pausing playback. Clicking the
control bar — play, next, seek — works normally and saves on the way through.

Works on both rating scales. Stash 0.24+ stores 0–100; older builds use 1–5
stars, and the value is converted.

## Markers — `M`

Freezes the current timestamp, then asks for a tag. Search by typing, or press
a number key to pick one of your last nine tags.

| Key | |
|---|---|
| `1`–`9` | pick a recent tag (empty search box only) |
| `↑` `↓` | move through results |
| `Tab` | switch between tag and title |
| `,` `.` | nudge the timestamp ∓1 s (empty search box only) |
| `Enter` | create the marker |
| `Esc` | cancel |

The timestamp is captured the instant you press `M`, so the video playing on
while you pick a tag does not move it.

If no tag matches what you typed, the last row offers to create it. Nothing is
saved until you press `Enter` — unlike the rating panel, clicking away cancels.

## Queue navigation — double-click

**Off by default**, because it replaces double-click-to-fullscreen. Turn it on
in the plugin settings if you want it.

Double-click the right half of the video for the next scene in the queue, the
left half for the previous one. Hold **Shift** while double-clicking for the
normal fullscreen toggle.

It triggers Stash's own queue navigation rather than changing the URL, so
continue-play and history behave exactly as they do with the queue buttons.

## Notes

- Replaces the separate QuickRate, QuickMark and QuickNav plugins. Uninstall
  those first; running both sets means two handlers fighting over the same
  keys. Your recent marker tags carry over.
- Only one panel is open at a time. Pressing `M` while the rating panel is up
  saves the rating and switches.
- Debug logging: `localStorage.quickToolsDebug = "1"` in the browser console.

## Troubleshooting

**A hotkey does nothing.** Check it is not disabled in the plugin settings, and
that you are on a scene page and not focused in a text field.

**Double-click still goes fullscreen.** Nav is off by default. Turn it on, then
reload the page.

**The rating saves but the stars do not change.** Stash renders from a cache
that the plugin updates through `PluginApi`. On builds that do not expose it,
the value is in the database and appears after a reload.
