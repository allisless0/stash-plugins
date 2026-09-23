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

You do not need a toy connected for that. Scripts are found and loaded, and the
signal preview works, as soon as the backend is running — useful for checking a
script or a vibe mode before you connect anything.

## The toolbar

**Device live / Device muted** is the master switch. Muted means nothing
reaches the toy, script or manual, no exceptions. Use it as a panic button.

**Manual** drives the toy directly, ignoring the funscript. The slider next to
it sets intensity, and also scales funscript output when a script is playing.

**The script button** (`♪ Scene title`) shows or hides the script settings
under the player. It lights up, like **Manual on**, while the script is what
drives the toy. With no script for the scene it says so. See
[Script playback](#script-playback).

On the right: the status, **Device live / Device muted**, and two icons,
**Connect** (plug) and **Disconnect** (crossed-out plug). If the status says
**Old backend**, run Stop Backend and then Start Backend in Settings › Tasks:
reloading plugins does not restart the backend.

**The pattern button** shows the active preset (or the pattern, if no preset is
active) and opens the pattern panel. A `*` after the name means you have
changed something since loading it.

**⚙** holds device and app settings: micro pulsing and keyboard shortcuts.

The crossed-out plug stops the toy and drops the Intiface connection; the
plug brings it back.

## Manual patterns

| Pattern | What it does |
|---|---|
| **Steady** | One level, held. No movement. |
| **Wave** | Rises and falls smoothly, over and over. |
| **Pulse** | A short buzz at a regular beat, silence between. |
| **Ramp** | Climbs to the top, drops, climbs again. |
| **Tease** | Buzzes that start short and grow longer. |
| **Random** | Unpredictable level, changing on its own. |

The panel draws the pattern you have set up, with a sentence underneath
saying the same thing in words ("One 0.4 s buzz at 60% every 4 s…"), so you
can see what a setting does as you drag it.

Each pattern shows only the settings it actually uses, so if a field is not on
screen, that pattern ignores it.

- **Cycle length / Repeat every** — one full rise and fall, or the gap between
  buzzes for Pulse and Tease.
- **Buzz length** — how long each buzz lasts. Short reads as a tap, long as a throb.
- **Dip to** — how far the level falls between peaks. 0 falls to silence.
- **Length build-up** (Tease): how many buzzes it takes to grow from the
  **Starting buzz length** to the **Final buzz length**, e.g. 0.2 s growing
  to 1.5 s over 10 buzzes. Changing a build setting starts the build over, so
  you feel the change straight away.
- **Strength build-up** (Tease) — how many buzzes it takes to grow from the
  **Starting strength** to full. Use it on its own, or with the length
  build-up so buzzes get both longer and stronger.
- **Power limit** — the strongest the motor may go. Lowering it stretches the
  intensity slider across a gentler range, which is the easiest way to get fine
  control at low levels.
- **Micro pulse** — length of each pulse used to reach levels below the motor's
  own floor.

The line at the bottom of the panel tells you the peak output and whether it is
above or below your motor's floor. That is the number that decides whether
micro pulsing does anything.

### Presets

Set a pattern up the way you like it, then **+ Save current** at the top of the
pattern panel and give it a name. Click a preset to load it.

- The active preset stays active until you pick another one: new tabs, reloads
  and other browsers all come up with it loaded.
- Changing a setting keeps the preset active and marks it with `*`. **Update**
  saves the change into the preset, **Revert** throws it away.
- **Detach** keeps the current settings but stops following the preset.
- A preset holds the pattern, its timing and the power limit. It does not hold
  the intensity slider, and loading one never switches manual mode on.
- Presets are saved in Stash's plugin settings, so they survive plugin updates
  and are shared by every browser that uses this Stash.

## Script playback

Click the script name to show the script settings under the player. They
stay open while you scrub the timeline and when you change scene, until you
click the name again. At the top, a strip shows how busy each part of the
scene is; click it to jump there.

**Collections.** With the Collections plugin, a collection can say which mode
its scripts start in (Cock Hero starts in Beat). That applies to scripts you
have not tuned; your own tuning wins.

**Settings are remembered per script.** The right timing and feel depend on
the file, so whatever you change while a script is loaded is kept for that
script and comes back next time. Scripts you have not tuned use your defaults.
The panel says which applies, with **Use defaults** to forget a script's tuning
and **Make these my defaults** to copy it.

**Mode** decides how a stroking script becomes vibration:

- **Auto**: picks for you (Beat for Cock Hero style scripts, Flow for the
  rest). Start here.
- **Flow**: made for vibrators. It reads the whole script when it loads and
  follows how busy the scene is, levelled to that script, so a slow script and
  a frantic one both use the full range. Three sliders:
  - **Smoothness**: left follows each stroke, right follows the scene and
    fades gently when the action stops.
  - **Rhythm**: how much each stroke pulses on top. 0 is a smooth buzz, all the
    way right is a burst per stroke.
  - **Sensitivity**: right makes quieter parts stronger, left calms it down.
- **Beat**: one burst per stroke turnaround. Suits Cock Hero scripts and, with
  peak picking, tracker-generated ones too. Auto also recognises "graded" beat
  scripts (Cock Hero Colors style), where the height of each stroke sets how
  strong the burst is.
- **Speed (classic)**: intensity follows stroke speed against a fixed scale.
- **Position**: intensity follows stroke position.

**Scripts are matched strictly.** A video only gets its own script: the same
name (spaces, brackets and case may differ), or a named version like
`Scene [FunGen].funscript`. Another video's script in the same folder is never
used, and there is nothing to pick from.

**Scenes without a script** play your manual pattern once you press play,
and stop when it pauses or ends. A manual session you started yourself is left
alone, and if you turn it off during a scene it stays off. Switch it off under
⚙ ("No script: silent") if you prefer those scenes quiet.

**Vibrator tracks.** Some scripts come with a second file made for vibrators,
named like `Scene.vib.funscript` next to `Scene.funscript`. When one is there
the vibrator plays it as written, which is almost always better than anything
worked out from stroke motion; the toolbar shows `+ vibe track`. A stroker
still follows the main script. You can turn this off under ⚙.

**Timing** shifts the toy against the video; the panel says "120 ms earlier"
and so on. **Weakest / Strongest** set the range the script plays in; manual
mode has its own Power limit.

**Live signal** is a switch in the header of the script settings. When on,
a wide scope at the bottom draws the script, the Flow plan and what the toy
actually gets, while you tune. It remembers the switch; the stream only runs
while the settings are showing.

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

One tab drives the toy at a time, across every browser and device that has
Stash open.

- Pressing play in a tab makes it the one driving, and it loads that tab's
  script.
- A tab you switch to takes over by itself only when the one driving is not
  playing.
- Every other tab says which scene is driving and offers **Take over**.
- **Device muted**, **Manual off** (`0`) and **Stop** work from any tab.
- Closing the tab that is driving stops the toy.

## Safety

When the toy is stopped for safety (the tab that was driving it closed, or
went quiet for 15 seconds because the browser froze or the computer slept),
the other open tabs say so in the status line.


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

**It buzzes constantly instead of following the script.** Set the mode to
Auto or Flow in the script settings. With Flow, lower Sensitivity or raise
Smoothness; with Beat, check Fire on.

**Another tab has the toy.** The status line says which scene is driving;
click it to take over, or press play in this tab.

**Timing drifts.** Turn on Live signal in the script settings and watch
`drift`. It should hover near zero. If it climbs steadily, report it.

## Live signal

Switch on **Live signal** in the script settings for a scope of the last 8
seconds:

- **grey line** — the funscript itself, with a dashed playhead at the current
  position and faint verticals marking where beat mode will fire
- **dashed purple** — the Flow plan, including what is coming next
- **blue line** — the intensity the plugin wants
- **green fill** — the level actually sent to the toy
- **orange ticks** — each command over Bluetooth
- **dashed yellow** — your motor's floor

Use it to check a vibe mode is reading a script sensibly: the green fill should
follow the shape of the grey line in a way that makes sense for the mode. It
streams continuously, so it pauses whenever the script settings are hidden.

Debug logging: `localStorage.intifaceSyncDebug = "1"` in the browser console.
