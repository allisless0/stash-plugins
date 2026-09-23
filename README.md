# Stash plugins

Two plugins for [Stash](https://stashapp.cc). One is a set of player
shortcuts, the other drives sex toys.

## Install

Stash > **Settings > Plugins > Add Source**, then paste:

```
https://allisless0.github.io/stash-plugins/main/index.yml
```

The plugins then appear under **Available Plugins**. Install the ones you want.

## What's here

| Plugin | Keys | What it does |
|---|---|---|
| **QuickTools** | `R` `M` `D` double-click | Four scene-player shortcuts in one plugin: a 0.0–10.0 rating panel, a marker panel that captures the current timestamp, a mark-for-delete tag, and double-click queue navigation. Each can be turned off. |
| **IntifaceSync** | `E` `\` `[` `]` `0` | Syncs funscripts to toys via Intiface Central / Buttplug.io, or to a Handy over WiFi. Supports vibrators, not just strokers. |

Each folder under `plugins/` has its own README with the details.

QuickTools replaces the earlier QuickRate, QuickMark and QuickNav plugins. If
you have those installed, uninstall them first — running both means two sets of
handlers fighting over the same keys. Recent marker tags carry over.

## QuickTools in brief

Four shortcuts, all of them limited to `/scenes/<id>` pages and none of them
firing while you are typing in a field.

- **`R`** — a rating panel at your cursor. Type a number, drag the bar, or use
the arrow keys. Auto-saves, and `Esc` is a real undo.
- **`M`** — freezes the current timestamp, then asks for a tag. Number keys
pick from your last nine tags.
- **`D`** — toggles a **Marked for Delete** tag. The player goes under a red
tint while the tag is on, so the state of a scene is obvious the moment you
open it.
- **double-click** — next or previous scene in the queue. Off by default,
because it replaces double-click-to-fullscreen.

**`D` never deletes anything.** It only puts a tag on. Clearing scenes out is
still a deliberate trip to the scene list: filter by the tag, select all, and
use Stash's own delete, which is where the "also delete the file" checkbox
lives. The tag is created the first time you press `D`, not on install.

## IntifaceSync in brief

A fork of [vib3coda/Stash-Intiface-Handy](https://github.com/vib3coda/Stash-Intiface-Handy)
that adds support for **vibrating (scalar) toys** such as Lovense, which the
original did not drive.

- **Vibe modes** — `Speed` maps stroke speed to intensity, `Position` maps
position, `Beat` fires one burst per stroke turnaround, `Auto` picks between
them based on the script's shape.
- **Beat mode** handles both Cock Hero style square-wave scripts and densely
sampled tracker output (FunGen and similar), which it peak-picks down to
stroke turnarounds first.
- **Micro pulsing** gets below the motor's own floor by pulsing between silence
and one step.
- **Manual mode** with tease, wave, pulse and other waveforms, independent of
any script.
- **Signal preview** — a live scope of exactly what is being sent to the toy.

### Safety

The device is stopped when the browser closes, when the tab crashes, when the
laptop sleeps, when the connection drops, and when the backend shuts down. A
watchdog stops output if the frontend has not been heard from for 15 seconds,
which covers the cases where no close event ever arrives.

**None of that helps if the Python process itself hangs.** Know where your
toy's power button is. This software is provided as-is, with no warranty.

Requires [Intiface Central](https://intiface.com/central/) running and your
device connected to it.

## Notes

- Unofficial and community-made. Not affiliated with or endorsed by Stash,
Intiface, Buttplug.io, TheHandy or any toy manufacturer.
- Substantially written with AI assistance, as was the upstream plugin. The
IntifaceSync backend has a stubbed test suite (41 checks, no hardware needed):
`python3 plugins/IntifaceSync/test_vibe.py`.
- Issues and pull requests welcome. If a change touches IntifaceSync's stop
logic, please read `docs/MAINTENANCE.md` §4.5 first.

## License

MIT. See `LICENSE`. IntifaceSync inherits MIT from upstream; vib3coda's
copyright is preserved.
