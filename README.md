# Stash plugins

Four plugins for [Stash](https://stashapp.cc). Three are keyboard shortcuts
for things that normally cost several clicks. One drives sex toys.

## Install

Stash > **Settings > Plugins > Add Source**, then paste:

```
https://allisless0.github.io/stash-plugins/main/index.yml
```

The plugins then appear under **Available Plugins**. Install the ones you want.

## What's here

| Plugin | Key | Where | What it does |
|---|---|---|---|
| **QuickRate** | `R` | scene page | Type a 0.0–10.0 rating without leaving the player. Auto-saves; `Esc` undoes. |
| **QuickMark** | `M` | scene page | Create a scene marker at the current position. Search tags, or pick a recent one with a number key. |
| **QuickNav** | double-click | scene page | Right half of the video plays the next scene in the queue, left half the previous. |
| **IntifaceSync** | `E` `\` `[` `]` `0` | scene player | Syncs funscripts to toys via Intiface Central / Buttplug.io, or to a Handy over WiFi. Supports vibrators, not just strokers. |

Each folder under `plugins/` has its own README with the details.

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
  IntifaceSync backend has a stubbed test suite (35 checks, no hardware needed):
  `python3 plugins/IntifaceSync/test_vibe.py`.
- Issues and pull requests welcome. If a change touches IntifaceSync's stop
  logic, please read `docs/MAINTENANCE.md` §4.5 first.

## License

MIT. See `LICENSE`. IntifaceSync inherits MIT from upstream; vib3coda's
copyright is preserved.
