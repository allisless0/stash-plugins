# IntifaceSync

Syncs funscripts to your toy while you watch in Stash. Works with vibrators and
strokers through [Intiface Central](https://intiface.com/central/), or with a
Handy over WiFi.

A fork of [vib3coda/Stash-Intiface-Handy](https://github.com/vib3coda/Stash-Intiface-Handy),
adding support for vibrating toys, which the original did not drive.

## Setup

1. Install and run **Intiface Central**, and connect your toy to it.
2. In Stash: **Settings > Plugins > IntifaceSync**, set the server URL if it is
   not `ws://localhost:12345`.
3. Run the **Start Backend** task once (Settings > Tasks).
4. Open any scene. The toolbar appears under the player.

If a funscript sits next to the video with the same base name, it loads
automatically and the toolbar shows `♪ filename`.

## The toolbar

**Device live / Device muted** is the master switch. Muted means nothing
reaches the toy, script or manual, no exceptions. Use it as a panic button.

**Manual** drives the toy directly, ignoring the funscript. The slider next to
it sets intensity, and also scales funscript output when a script is playing.

**The pattern button** shows what manual mode is currently doing and opens the
pattern panel.

**⚙** opens the advanced row: vibe mode, timing offset, intensity limits,
micro pulsing and the signal preview.

## Manual patterns

| Pattern | What it does |
|---|---|
| **Steady** | One level, held. No movement. |
| **Wave** | Rises and falls smoothly, over and over. |
| **Pulse** | A short buzz at a regular beat, silence between. |
| **Ramp** | Climbs to the top, drops, climbs again. |
| **Tease** | Buzzes that start short and grow longer. |
| **Random** | Unpredictable level, changing on its own. |

Each pattern shows only the settings it actually uses, so if a field is not on
screen, that pattern ignores it.

- **Cycle length / Repeat every** — one full rise and fall, or the gap between
  buzzes for Pulse and Tease.
- **Buzz length** — how long each buzz lasts. Short reads as a tap, long as a throb.
- **Dip to** — how far the level falls between peaks. 0 falls to silence.
- **Build-up** — cycles Tease spends growing each buzz to full length.
- **Power limit** — the strongest the motor may go. Lowering it stretches the
  intensity slider across a gentler range, which is the easiest way to get fine
  control at low levels.
- **Micro pulse** — length of each pulse used to reach levels below the motor's
  own floor.

The line at the bottom of the panel tells you the peak output and whether it is
above or below your motor's floor. That is the number that decides whether
micro pulsing does anything.

## Script playback

**Vibe mode** decides how a stroking script becomes vibration:

- **Auto** — picks for you. Use this.
- **Speed** — intensity follows stroke speed.
- **Position** — intensity follows stroke position.
- **Beat** — one burst per stroke turnaround. Suits Cock Hero scripts and, with
  peak picking, tracker-generated ones too.

**Offset** shifts device timing against the video. Positive fires earlier.

## Keyboard shortcuts

| Key | |
|---|---|
| `E` | mute / unmute output |
| `\` | manual mode on/off |
| `[` `]` | intensity down / up |
| `0` | stop manual |

Turn them off entirely in **Settings > Plugins > IntifaceSync > Disable
keyboard shortcuts** if they clash with other plugins. Everything stays
available in the toolbar.

## Multiple tabs

Only one tab drives the toy at a time. Switching to another Stash tab hands
control over automatically; pressing play always wins. A tab that is not in
control says so in the status line.

## Safety

The toy stops when you close the browser, when the tab crashes, when the laptop
sleeps, when the connection drops, and when the backend shuts down. A watchdog
stops output if the page has not been heard from for 15 seconds, which covers
the cases where no close event ever arrives.

**None of that helps if the Python backend itself hangs.** Know where your
toy's power button is. Provided as-is, with no warranty.

## Troubleshooting

**Nothing happens.** Check Intiface Central is running with the toy connected,
then that the toolbar says Device live. Run Stop Backend then Start Backend.

**Backend changes did nothing.** Reloading plugins does not restart the Python
process. Run Stop Backend, then Start Backend.

**It buzzes constantly instead of following the script.** Switch vibe mode to
Auto. Some scripts are square waves that Speed mode flattens into one level.

**Timing drifts.** Turn on the signal preview under ⚙ and watch `drift`. It
should hover near zero. If it climbs steadily, report it.

## Signal preview

Under ⚙, **Signal preview** draws a live scope of the last 8 seconds:

- **grey line** — the funscript itself, with a dashed playhead at the current
  position and faint verticals marking where beat mode will fire
- **blue line** — the intensity the plugin wants
- **green fill** — the level actually sent to the toy
- **orange ticks** — each command over Bluetooth
- **dashed yellow** — your motor's floor

Use it to check a vibe mode is reading a script sensibly: the green fill should
follow the shape of the grey line in a way that makes sense for the mode. It is
off by default because it streams continuously; leave it off for normal use.

Debug logging: `localStorage.intifaceSyncDebug = "1"` in the browser console.
