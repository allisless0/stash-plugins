# Stash Plugin Suite — Maintenance Report

Written to be handed to an LLM alongside the source when requesting changes.
It records what exists, why it is built the way it is, and which decisions are
load-bearing. Read this before editing anything.

Last updated: 2026-09-15 (safety sweep, see §6b)

---

## 1. Environment

| | |
|---|---|
| Host | Unraid, Stash in Docker, container name `Stash` (capital S) |
| Plugin dir (in container) | `/root/.stash/plugins/` |
| Appdata (host) | `/mnt/user/appdata/Stash/` — **capital S**, case-sensitive |
| Stash config | `/root/.stash/config.yml` |
| Device | Lovense Gush 2, vibration only, 20 steps (5% minimum) |
| Intiface | Intiface Central, WebSocket, default `ws://localhost:12345` |

Deploy:

```bash
docker cp <PluginFolder> Stash:/root/.stash/plugins/
```

Then Settings → Plugins → **Reload Plugins**, then hard-reload the browser tab
(Ctrl+Shift+R). UI-only plugins need nothing else. IntifaceSync also needs
Stop Backend → Start Backend when its Python changes.

---

## 1b. Repo tooling

`CLAUDE.md` (rules, loaded every session), `SETUP.md` (repo and Claude Code
setup), `scripts/validate.sh` (the gate: syntax, manifests, safety-chain greps,
test suite), `scripts/syntax-check.sh` (fast PostToolUse hook), and
`scripts/deploy.sh` (validate then copy into a live Stash, honours
`STASH_PLUGINS`). `.claude/settings.json` wires the hook.

`validate.sh` is not decorative: it greps for `_panic`, `_watchdog` and
`DEADMAN_S`, and fails if the disconnect handler regresses to sending `pause`.
Keep those greps in step with any refactor of the safety chain.

## 2. Inventory

| Plugin | Version | Type | Hotkey | Scope | LOC |
|---|---|---|---|---|---|
| QuickTools | 1.0.0 | UI only | `R` `M` dbl-click | `/scenes/<id>` | ~1010 |


| ~~QuickCriteria~~ | 2.3.0 | archived, not published | `R` | `/performers/<id>` | ~710 |
| IntifaceSync (vibe fork) | 1.18-vibe | UI + Python backend | `E` `\` `[` `]` `0` | scene player | ~1850 JS + ~2230 PY |

`R` is bound by two plugins. They never collide because QuickRate only binds on
`/scenes/<id>` and QuickCriteria only on `/performers/<id>`. **Any new plugin
binding `R` must check its path guard first.**

---

## 3. Conventions shared by all five

These are deliberate and consistent. Preserve them.

### 3.1 GraphQL

Raw `fetch` to `/graphql`, `credentials: "same-origin"`. No Apollo, no
PluginApi dependency for data. Errors surface as `json.errors[0].message`.

### 3.2 Apollo cache sync (critical, non-obvious)

Stash renders from a normalised Apollo cache. A raw `fetch` mutation writes the
database but leaves the UI stale until reload. Every plugin that mutates must
poke the cache:

```js
const svc    = window.PluginApi?.utils?.StashService;
const client = typeof svc?.getClient === "function" ? svc.getClient() : null;
```

- QuickRate uses `cache.modify` to write the field directly (instant, no flash).
- QuickCriteria/QuickMark evict + `refetchQueries`.

Always guard for `client` being null; the UI must still work without it, just
requiring a reload. **Do not assume PluginApi exists.**

### 3.3 Schema probing rather than assuming

`rating100` vs legacy `rating`, `end_seconds` presence — probed at runtime via
`__type(name: "...") { inputFields { name } }`. Keeps the plugins working across
Stash versions. Extend this pattern for any field that has changed historically.

### 3.4 Key handling

`document.addEventListener("keydown", handler, true)` — capture phase, so
`stopPropagation()` beats Stash's own Mousetrap bindings. Always:

- bail on `ctrlKey || metaKey || altKey`
- bail when `document.activeElement` is input/textarea/select/contenteditable
- bail when the path guard does not match

### 3.5 Commit semantics (deliberately inconsistent, do not "fix")

| Plugin | Click outside |
|---|---|
| QuickRate | **commits** — a rating is a cheap, correctable single value |
| QuickMark | **cancels** — an accidental marker must be hunted down and deleted |
| QuickCriteria | **cancels** — multi-field write, accidental commits are costly |

### 3.5b Video-surface click swallow (QuickRate, QuickMark)

When a panel is open and the user clicks the **video itself**, the intent is
"dismiss the panel", not "pause". Both plugins detect this in the capture-phase
`pointerdown` (`isVideoSurface()`: inside `video, .vjs-tech, .video-js,
.VideoPlayer` but **not** inside `.vjs-control-bar, .vjs-menu,
.vjs-modal-dialog, button, a`), close the panel, then set `swallowUntil =
now + 600ms`. Capture listeners on `mousedown mouseup pointerup click dblclick
touchstart touchend` kill everything until that deadline so video.js never sees
the click. Control-bar clicks are not swallowed: QuickRate still commits on
play/next as before. With no panel open nothing is intercepted.

If Stash ever changes its player DOM, `isVideoSurface()` is the one place to
update. Both copies must stay identical.

### 3.6 Panel placement

QuickRate and QuickMark anchor to the cursor (`mousemove` tracked globally),
clamp to viewport, and dodge the bottom 80px of the `<video>` rect so player
controls stay clickable. QuickCriteria is a centred modal because it is longer.

### 3.7 Debug flags

```js
localStorage.setItem("quickRateDebug", "1");      // etc.
```
Per-plugin: `quickRateDebug`, `quickNavDebug`, `quickMarkDebug`,
`quickCriteriaDebug`. IntifaceSync logs to
`/root/.stash/plugins/IntifaceSync/intiface_sync.log`.

---

## 4. Per-plugin notes

### 4.1 QuickRate — scene rating, 0.0–10.0

Writes `rating100` (0–100). Digit buffer logic: `8` then `5` yields 8.5, not 85
(if appending would exceed 10, insert a decimal point). `0` then `5` yields 0.5.
Auto-saves 650ms after the last edit (`SAVE_DELAY`); commits on play, click-away
or scene change. `Esc` is a **real undo**: `original` is captured at open and
written back if anything was committed meanwhile (v1.3.0; before that Esc only
cancelled the pending timer, so anything auto-saved stayed). A `touched` flag
stops the async initial fetch from clobbering `saved` if the user typed before
it returned.

**Known conflict:** Advanced Rating's *Scenes* half also writes scene
`rating100` from its `Scene.Update.Post` hook. If that is ever enabled it will
overwrite QuickRate. Currently the user runs Advanced Rating on performers only.

### 4.2 QuickNav — double-click to change scene

Triggers Stash's own `p n` / `p p` Mousetrap bindings rather than reimplementing
queue traversal. Three-tier fallback: `Mousetrap.trigger()` →
click a queue control → synthesised keypress (Mousetrap reads `which`/`charCode`,
**not** `key`, so those are set via `Object.defineProperty`).

Requires a populated scene queue; direct-URL scenes have none and nothing
happens. That is upstream behaviour, not fixable here.

Suppresses dblclick-to-fullscreen. Shift+dblclick restores it. The two single
clicks that precede a dblclick still toggle play/pause twice — an even number,
so state is unchanged. Do not "fix" this by delaying single clicks.

### 4.3 QuickMark — scene markers

Timestamp frozen at keypress so hunting for a tag does not drag the marker.
`sceneMarkerCreate` requires `primary_tag_id`, hence the tag-search-first design.
Offers tag creation when no exact match. Recent tags in localStorage
(`quickMarkRecentTags`), mapped to keys `1`–`9`.

Number keys and `,`/`.` nudge only fire when the search box is empty, so tag
names containing digits or commas remain typeable.

v1.1.0: if focus escapes the inputs while the panel is open (click on the panel
body), `Esc` still closes and stray printable keys are routed back into the
search box with the keystroke preserved. Failed commits show the GraphQL error
in the status line; a failing recent tag (renamed/deleted) is pruned from
`quickMarkRecentTags`. Hover highlight toggles classes instead of rebuilding
the list.

Marker preview images are not generated; that needs a Stash generate task.

### 4.4 QuickCriteria — companion to the Advanced Rating plugin

Companion, **not a fork**. Upstream (`ordureconnoisseur/plugins`, AGPL v3) is
actively maintained; forking would mean a permanent diff for features already in
its queue.

**Criteria discovery is from the tag tree, not the config:**

```
Advanced Performer Rating
 └─ Face ★
     ├─ Face ★: 0 … Face ★: 5
```

`CRIT_RE = /^(.+?)\s*★$/`, `LEVEL_RE = /^(.+?)\s*★:\s*([0-5])$/`. The `[0-5]`
bound matters — an unbounded `\d` accepted stray tags like `Rating ★: 9`.

**Group/order/description discovery (v2.2, the fragile part):** key names in
Advanced Rating's config are not a stable contract, and guessing them failed on
the real install. The parser now deep-walks the entire plugin config tree,
collects every list of named records, and selects whichever list's names overlap
best with the tag-discovered criteria. Group ids resolve against any other list
carrying matching identifiers. Scene criteria are rejected automatically because
their names do not match.

Tested against: flat arrays with id refs, objects nested under a wrapper, JSON
string blobs, groups as plain names, scene-only config, absent config. The last
two return `null` and the UI degrades to a flat tag-ordered list that still
rates correctly. **Grouping is decoration; rating must never depend on it.**

**Config is loaded before discovery (v2.3.0).** `discoverCriteria()` searches
by `parentTagName`, which comes from the plugin config; v2.2 loaded both in one
`Promise.all` so a custom parent name only took effect on the second open.

**Hidden-criterion level tags survive a save (v2.3.0).** v2.2 sorted every
`LEVEL_RE` tag into `current` and every other tag into `otherTagIds`, then
filtered the criteria list. Level tags of hidden or upstream-disabled criteria
ended up in neither and were **stripped on save**. Now any level tag whose
criterion is not in the active list is pushed back into `otherTagIds`.
This was a real rule-5 violation; test it whenever the merge changes.

**Writes:** a single `performerUpdate` with the full `tag_ids` set, which fires
`Performer.Update.Post` once and lets Advanced Rating compute `rating100` with
its own weights. **This plugin never writes `rating100` itself.** Non-rating
tags are carried through verbatim — test any change to this merge.

The footer shows an *unweighted* mean plus scene-rating evidence (count, %,
mean, divergence warning above 1.5 points). The mean is labelled unweighted
deliberately; replicating upstream's weighting would reintroduce the config
coupling the discovery design avoids.

### 4.5 IntifaceSync vibe fork

Upstream is a linear/stroker plugin. This fork adds a scalar (vibration) path so
a Gush 2 can be driven from funscripts.

**Signal chain:**

```
script → raw 0-1 → intensity limits (floor/ceiling) → × master → quantise → device
```

- **Vibe mode** `speed`: `|Δpos| / Δt × 1000` in funscript units/sec.
  `vibe_max_speed` (default 500) is the speed mapping to 100%. Most scripts
  exceed 500 often, so the default clips constantly — 800–1000 gives dynamics.
- **Master intensity** (`self.master`, the toolbar slider) scales everything,
  script and manual alike. In manual Constant mode the waveform is 1.0, so
  master *is* the manual level.
- **Step resolution** read from the device's reported `StepCount`, not assumed.
  Gush 2 reports 20 → 5% floor.
- **Sub-step ("Micro") pulsing** gets below the hardware floor by alternating
  0 / one step. Period is stretched so both the on-pulse and the gap stay long
  enough: `period = max(MIN_PERIOD, PULSE_MS/duty, MIN_GAP/(1-duty))`.
  Command rate therefore *falls* as the requested level drops. Measured
  delivered average is linear 0.2%→4.2% at ≤6.7 cmd/s (BLE ceiling ~11/s).
  An earlier fixed-pulse formula saturated above 50% duty — do not revert to it.
- **Beat mode (v1.11).** Cock Hero scripts are pure 0/100 square waves locked
  to the music; `speed` mode turns them into a flat plateau (speed is constant
  inside a linear stroke and every stroke is identical) and `position` into a
  smeared triangle. `beat` fires one burst per keyframe instead:
  `_beat_target()` finds the most recent keyframe, stays on for `beat_on_ms`
  (default 120, shortened to `interval - BEAT_MIN_GAP_MS` when beats are
  faster), then silent. Burst level = local pace (`|Δpos| / interval`) through
  the normal `_vibe_target()` speed mapping, so `vibe_max_speed`, floor/ceiling
  and master all still apply. No EMA in beat mode (edges must be sharp) and the
  level is clamped to ≥ one step so the sub-step pulser never chops a burst.
  `beat_edge` (`all|low|high`) lets the user halve the tempo when a script
  marks both beat and off-beat. `BEAT_GAP_MS` (3000) is the beat-mode idle
  threshold, deliberately looser than `VIBE_GAP_MS` (1500) because a 32 BPM
  beat is still a beat.
  **Peak picking (v1.13).** FunGen and other CV trackers emit at the video
  frame rate, not at stroke turnarounds: the sample file is 30,952 actions at
  a flat 33 ms gap, only 28% of which are local extrema. Firing a burst per
  keyframe there is a continuous hum, the original bug. `is_dense_script()`
  (median gap < `BEAT_DENSE_MEDIAN_MS`, 150) flags these, and
  `extract_peaks()` reduces them to turnarounds before beat mode runs;
  `_rebuild_beats()` stores the result in `self._beats` and falls back to the
  raw list if picking leaves fewer than `BEAT_DETECT_MIN` points. Two passes:
  collect every direction change (skipping flat runs), then keep one when the
  swing since the last **kept** turn is ≥ `beat_prominence` and it is ≥
  `BEAT_PEAK_MIN_SEP_MS` (180) later.
  **Seeding matters:** v1.13-dev seeded the anchor from `actions[0]`, which is
  usually mid-stroke, so every swing measured half-size and prominence ≥ 45
  returned zero peaks. The anchor is now the first turning point. If you touch
  this function, test prominence across its whole 5-60 range, not just the
  default.
  A square-wave beat script already *is* turnarounds and is never picked.
  On the sample file: 30,952 → 2,493 peaks, 1-2.4 bursts/s in active chapters,
  1.7-5.0 cmd/s. Status carries `beatPicked`/`beatPeaks`; the prominence box
  only appears when `beatPicked` is true. Tests 24-25.

  **Level scaling caveat.** `_beat_target()` derives intensity from
  `|Δpos| / interval` through `_vibe_target()`, and peak-to-peak pace on a
  picked script is much lower than raw stroke speed. At the default
  `vibe_max_speed` 500 the sample file averages 0.13-0.31; at 250 it averages
  0.26-0.61 and peaks at 1.00. Tracker scripts want roughly half the
  sensitivity value that Cock Hero scripts do. A future version could scale
  this automatically from the picked-script statistics.

  **`auto`** = `beat` when `detect_beat_script()` says so (≥95% of keyframes
  within 5 of 0 or 100, alternating on ≥90% of them, ≥40 keyframes), else
  `speed`. The UI default is still `speed`; the user opts into `auto`.
  Status carries `beatScript` and `vibeEffective` so the toolbar can show
  `♩beat`. Measured on the real file: 1.3 → 8.6 cmd/s across tempo tiers,
  levels 0.10 → 0.85. Tests 22-23.
- **Manual waveforms:** constant, wave (sine, floors at 0.15), pulse (50% duty),
  ramp, tease (climbs 75% then rests), random.
- **Output kill switch** (`E`): the loop keeps running but sends nothing, so
  re-enabling is instant. Sends `StopAllDevices` and resets vibe level on
  disable. State lives at app level (`self._output`) so it survives player
  rebuilds.

**Backend auto-start (v1.7–1.9, has bitten once):** the browser runs Stash's own
`Start Backend` task via `runPluginTask`. v1.7 had an unbounded retry loop —
measured **180 queued tasks/hour** with the backend down. Now guarded three ways:
max 3 auto attempts per page session, a 60s cooldown in `localStorage`
(`intifaceSyncLastBackendStart`) shared across tabs, and a give-up state that
drops to a 15s socket-only retry. Pressing Connect resets all three.
**Any change here must be re-simulated for total submissions/hour.**

**`byId()` resolver:** `buildToolbar()` runs its updaters before the bar is
appended to the document, so `document.getElementById` returned null and buttons
rendered blank. All 19 plugin element lookups go through `byId()`, which falls
back to searching the detached `toolbarEl`. Buttons also set text at creation.
**Do not reintroduce raw `getElementById` for plugin ids.**

**Handy UI** is hidden unless the `enableHandy` plugin setting is true.

**Script wave on the scope (v1.18).** The preview showed what the toy did but
not what it was reacting to, which made it useless for judging whether a vibe
mode was interpreting a script sensibly.

`_preview_script_window(media_ms)` returns the slice of `self.actions` covering
`PREVIEW_SCRIPT_BACK` (9 s) behind to `PREVIEW_SCRIPT_AHEAD` (3 s) ahead,
thinned by **stride, not interpolation**, to `PREVIEW_SCRIPT_MAX` (260) points.
Stride matters: keeping real keyframes means beat markers still land on points
the player actually fires on. The first kept point sits at or before the
window start on purpose, so the drawn line does not begin mid-scope; `t0`/`t1`
therefore report the bounds of the returned points, not the requested range.
In beat mode the window also carries `beats`, taken from `self._beats`, which
for a peak-picked script is a small subset of the keyframes.

Windows ride along with the sample batches but are throttled separately to
`PREVIEW_SCRIPT_MS` (500), so roughly two per second against five sample
batches.

**`preview_cb` now takes `(samples, script=None)`.** The signature change is
why test 30 broke: a one-argument callback raises inside `_preview_sample`,
which swallows it, and the frames list stays empty. That is the intended
failure mode, but keep it in mind when adding preview consumers.

Frontend: samples carry both the backend clock (`t`) and media time (`m`), so
the script is mapped to screen from the newest sample that has an `m`, scaled
by `statusData.rate`. Drawn first, under the output traces, in grey, with beat
markers as faint verticals and a dashed playhead. Tests 31-32.

**Toolbar redesign (v1.17).** The bar had grown into one flat flex row of
unlabelled number boxes: `Tease | 7 | s | buzz 400 ms | build 0 cyc | max 100 % |
micro 120 ms`. Every value was legitimate and none of it was readable.

Split by how often a control is touched. Row 1 keeps only mid-scene controls:
the master switch, the loaded script, Manual with its intensity slider, and a
pattern button that doubles as a readout. Everything that *shapes* a pattern
moved into `#IntifaceSync-pattern-pop`, a popover anchored to that button.

The popover is six pattern cards, each with a one-line description of what it
does, over two sections (Timing, Output limits). Fields carry a real label and
a sentence of help instead of a three-letter abbreviation and a tooltip:
`buzz` → Buzz length, `floor` → Dip to, `max` → Power limit, `cyc` → Build-up.
`updateManualUI()` hides every field the current pattern does not read and
relabels the period field between "Cycle length" and "Repeat every", because
the same number means different things for burst patterns.

`buttonStyle()` was already a stub returning `""`; state is now carried by
classes (`is-on`, `is-live`, `is-muted`, `is-locked`) rather than inline
styles, so the CSS block is the single place button appearance is decided.

**"Output ON/OFF" is now "Device live / Device muted"** with a power glyph. The
old label read as a verb to some people and a state to others, so clicking it
was a coin flip. It is a master kill switch; the label now says which state it
is in, not what clicking will do.

**The popover lives on `document.body`, not inside the toolbar.** The
owner-lock `pointerdown` and the dismiss handler both explicitly exempt it. If
you move it back inside the toolbar, the takeover logic will fire on every
click inside the panel.

**`disableHotkeys` plugin setting (v1.17).** `hotkeysAllowed` (from plugin
config) gates `hotkeysOn` (the per-browser toolbar toggle). Both must be true.
When the setting is on, the toolbar button reads "Shortcuts off", is
non-interactive, and its tooltip points at the setting. `updateHotkeyBtn()` had
to be lifted out of `buildToolbar()` scope so the async config load can call it.

**Funscript display (v1.16).** Row 1 shows only the script actually loaded
(`♪ name`, greyed with a trailing `…` while the load is pending, full path in
the tooltip). The `<select>` still exists and still drives `loadFunscript()`,
but it moved into the advanced row inside `#IntifaceSync-script-pick`, which
`updateFunscriptSelector()` shows only when `funscripts.length > 1`. With a
single candidate, which is the normal case, there is no picker at all. Nothing
about discovery or loading changed; this is presentation only.

**Signal preview (v1.15, debug scope).** "📈 Signal" in the advanced row
streams what is actually being sent to the toy. Off by default and never
persisted, because it costs ~25 samples/sec on the socket.

Backend: `FunscriptPlayer._preview_sample()` is a cheap no-op while
`preview_cb is None`, so the normal path pays nothing. When a client sends
`{type:"preview",enabled:true}` the server sets `preview_cb` to
`_preview_emit`, which batches samples every `PREVIEW_BATCH_MS` (200) and
broadcasts them. Sampling is throttled to `PREVIEW_HZ` (25) **except** for
real `_send_level()` calls, which are always captured with `s:1` so no BLE
command is ever missed from the trace. The buffer self-trims if a flush is
late, so a stalled client cannot grow it without bound. `preview_cb` is
re-attached when a new player is built on Intiface reconnect.

Sample shape is deliberately terse: `{t, tg, lv, m, s}` = monotonic ms,
pre-smoothing target, level sent, media ms, command flag.

Frontend: canvas scope, 8 s rolling window, anchored to the newest **sample**
timestamp rather than `Date.now()` because the timestamps come from the
backend's clock. Blue line = target before smoothing and quantisation, green
step-held fill = level actually sent (that is what the toy sees), orange ticks
= BLE commands, dashed yellow = the motor floor from `scalarStep`. Readout
shows cmd/s, current level and `driftMs`, which turns orange past 150.
Closing the advanced panel turns the stream off. Tests 29-30.

**What to look for when debugging:** beat mode should show clean square
bursts with silence between, not a plateau. Sub-step pulsing shows as a rapid
comb below the dashed floor line. Orange ticks bunching up past ~11/s means
the BLE budget is being exceeded and commands are being dropped. Drift that
trends in one direction means clock sync is failing.

**Clock sync (v1.14, read this before touching timing).** The backend does
not receive a continuous time feed. `_current_media_ms()` extrapolates from
`_play_start_wall` (monotonic) and `_play_start_media`, both set only on
`play`/`seek`. Up to v1.13 nothing corrected that, so the backend slid against
the browser's video clock over a long scene: buffering stalls, dropped frames
and any `playbackRate` other than 1 all accumulate. Symptom is exactly
"the offset setting does not work" — it works, then drifts back out.

v1.14: the 2 s heartbeat carries `{type:"sync", time, rate}` while the video
plays (plain `ping` when paused). `FunscriptPlayer.sync()` compares against its
own extrapolation; drift ≥ `SYNC_SNAP_MS` (150) re-anchors hard and re-seats
the keyframe index, anything smaller is eased out at `SYNC_GAIN` (0.25) per
report so there is no audible jump. `rate` is stored and multiplied into
`_current_media_ms()`; a rate change always re-anchors. The JS also treats
`waiting` as a pause and `playing` as a fresh play, because a buffering stall
freezes the video while the backend keeps counting.

**Offset itself was never broken.** Sign convention: **positive = device fires
earlier**, negative = later. It is added to media time in `play`, `seek` and
the loop. One real bug fixed alongside: changing the offset mid-playback did
not re-seat `_last_sent_idx`, so stroker output stalled or jumped until the
next seek. Tests 26-28.

**Safety architecture (v1.10, load-bearing, do not weaken):**

The incident: tease mode kept a Gush 2 running after the browser was closed.
Three independent causes, all fixed, all covered by `test_vibe.py` 19-21.

1. `FunscriptPlayer.pause()` deliberately *keeps* manual mode running (pausing
   a video must not kill a deliberate tease session). The last-client
   disconnect handler used to send `pause`. It now calls `BackendServer._panic()`
   → `FunscriptPlayer.panic()`: script, manual and device output all stop.
   `pause` is still manual-preserving on purpose. Test 21 pins that.
2. **Deadman watchdog.** `_last_seen` is touched on every frontend message.
   `_watchdog()` polls every `DEADMAN_TICK_S` (2s) and panics if the device is
   active and nothing arrived for `DEADMAN_S` (15s). This is what protects
   against browser crash, laptop sleep and network drop, where no close frame
   ever arrives. The JS heartbeat (`ping` every 3s, `status` while Intiface is
   not yet connected) feeds it. **If you change the heartbeat interval, keep
   `DEADMAN_S` at least 3× larger.**
3. `_manual["enabled"]` survives player rebuilds in `BackendServer`, and the
   `connect` handler used to re-apply it, so tease self-armed on every Intiface
   reconnect. Now shape/period/depth are restored but `enabled` is forced
   `False`.

Also: `ws_serve(ping_interval=5, ping_timeout=8)` so leaked browser sockets
die instead of holding the client count above zero (log showed 122 connects vs
73 disconnects). `Stop Backend` now panics and disconnects Intiface before
exiting; before it just killed the process with the toy still running.

**Single-owner tab lock (JS, v1.10).** The backend is one global player, so
only one tab may drive it. `IntifaceSync.owner` in localStorage holds
`{id, ts}`, refreshed every 1.5s by the owner; TTL 90s (long because Chrome
throttles background timers to ~1/min after 5 minutes). A `BroadcastChannel`
gives instant handoff: owner posts `released` on `pagehide`, spectators race
to claim. Spectator tabs never open a WebSocket and `sendMsg()` is a no-op for
them. Consequence: a long-throttled owner can lose the lock to a fresh tab.
That is intentional; a frozen owner is worse than a handoff.

**Ownership follows the active tab (v1.12).** v1.10 kept the lock on whichever
tab got it first, so a paused tab blocked the one the user switched to. Now
the owner record carries `playing` (refreshed on the heartbeat and on
play/pause), and a spectator calls `tryTakeover(reason)` on `visibilitychange`
→ visible, window `focus`, toolbar `pointerdown`, plugin hotkeys, and its
video's `play` event. Takeover is refused while the owner is actively playing,
**except** for `play`: the user just pressed play here, that wins. On gaining
the lock `becomeOwner()` resets `intifaceReady`/`funscriptLoaded`, queues
`findFunscripts` for the current scene and a `play` at the current time if the
video is running, then connects. The backend still holds the previous tab's
script until that round-trip completes, so there is up to ~1 s of the wrong
script on a mid-playback steal. Known gap: a manual-mode hotkey pressed in a
spectator tab triggers the takeover but the manual command itself is dropped
(socket not open yet); press it again.

Removed in v1.10: four duplicate `beforeunload`/`pagehide` handlers (one sent
`stop`, which killed the *other* tab's session) and the `visibilitychange` →
stop, which paused playback on a mere tab switch. One `pagehide` handler
remains as best-effort; the deadman is the real guarantee.

**Hardware caveat, say it plainly:** none of this helps if the Python process
itself hangs. Know where the Gush 2 power button is.

**Tests:** `test_vibe.py`, 32 checks, run from the plugin's parent directory:

```bash
python3 test_vibe.py
```

It stubs `ButtplugClient` — it verifies wire format, mapping maths, rate limits
and state machines, **not** real hardware behaviour. Motor response to pulsing
is unmodelled and untestable here.

---

## 5. Rating taxonomy (context for QuickCriteria work)

Configured in the Advanced Rating plugin, not in any code here:

| Group | Weight | Criteria |
|---|---|---|
| Appearance | 1 | Face, Body |
| Performance | 1 | Enthusiasm, Technique, Presence |
| Catalogue | 0.5 | Consistency, Range |

Design principle: a criterion earns its place only if it moves independently of
the others. Several defaults (Breasts/Ass/Genitals/Body Overall) were disabled
as redundant. Disabled criteria keep their tags on disk by design, which is why
tag-only discovery over-reports and the config match matters.

Outstanding data issue: performers rated before the criteria rename carry scores
under new labels that mean something different. Recalculate makes ratings
*consistent*, not *correct*.

---

## 6. Known open issues

| Plugin | Issue |
|---|---|
| IntifaceSync | **Untested on live hardware since v1.10.** Do the dry run: tease on, kill the browser, confirm stop within ~15s. Then: two tabs, confirm spectator text appears and takeover works. |
| IntifaceSync | Backend does not reliably stay up; auto-start is throttled but the root cause (task failing vs port 7880 unreachable from browser) is unconfirmed. Check `docker exec Stash ps aux \| grep -i intiface`. The 2026-09-14 log shows 40 minutes of `Failed to connect to Intiface` timeouts before a successful connect: that was Intiface Central not running yet, not a plugin fault. |
| IntifaceSync | v1.17 UI is untested in a browser. It parses and the IIFE executes against stubbed globals, nothing more. Check the popover positions correctly when the player is fullscreen, and that it is not clipped by the player container. |
| IntifaceSync | Signal preview untested against a real device stream; sample timestamps are backend-monotonic, so if the canvas looks frozen check that frames are arriving rather than that the toy is idle. |
| IntifaceSync | Clock sync untested on hardware. Check `driftMs` in the status payload during a long scene; it should stay under ~150 and never trend. |
| IntifaceSync | `SYNC_GAIN` 0.25 at a 2 s heartbeat means a 100 ms drift takes ~8 s to ease out. Fine for vibrators, possibly too slow for a stroker. |
| IntifaceSync | Beat mode untested on hardware. Cock Hero: `Auto`, raise burst ms if slow sections are inaudible. FunGen: `Beat` manually, drop `vibeMaxSpeed` to ~250, tune prominence. |
| IntifaceSync | Beat level scaling is not normalised per script; tracker scripts need roughly half the `vibeMaxSpeed` of beat scripts. Auto-scaling from picked-script statistics is the obvious follow-up. |
| IntifaceSync | `BEAT_DENSE_MEDIAN_MS` 150 is a guess. A tracker running at 10fps (100ms) is caught; one at 6fps (167ms) is not and would fire per raw keyframe. |
| IntifaceSync | Micro pulsing untested on real hardware; may read as a tick rather than a hum at low duty. |
| IntifaceSync | Funscript discovery uses `files[0].path`; multi-file scenes may resolve the wrong directory. |
| IntifaceSync | Spectator tabs show a greyed toolbar but their manual/hotkey controls silently do nothing. Could disable the controls visually. |
| QuickRate / QuickMark | `isVideoSurface()` selector list is a guess at Stash's video.js DOM. If a video click still pauses, inspect `ev.target` and extend the selector. |
| QuickNav | `isBound()` inspects Mousetrap internals (`_callbacks`/`_directMap`); on builds where they are closure-private it returns `null` and behaves as before (trust `trigger`). |
| QuickNav | Silent no-op when there is no scene queue. |
| ~~QuickCriteria~~ | Archived; depended on upstream's `★` tag naming, which a format change upstream would break. Relevant only if it is revived. |
| All | `runPluginTask` / mutation argument shapes vary by Stash build. |

---

## 6b. Session log

### 2026-09-15 — safety sweep

**IntifaceSync 1.9 → 1.10-vibe.** Gush 2 kept vibrating in tease mode after
browser close. Root causes and fixes in §4.5 "Safety architecture". Backend:
`panic()`, `_panic()`, `_watchdog()`, `ping` message, ws ping tuning, stop on
shutdown, no re-arm on connect. Frontend: owner lock, heartbeat, dead handlers
removed. Tests 19-21 added. The pack's copy was older than the user's live
copy; the live copy was patched and is now canonical.

**QuickRate 1.2 → 1.3.** Video-surface click swallow (user report: clicking
the scene to dismiss the panel paused it). Esc turned into a real undo. Fetch
race guard.

**QuickMark 1.0 → 1.1.** Same click swallow. Focus-escape handling. Error text
surfaced. Dead recents pruned. Hover no longer rebuilds the list.

**QuickCriteria 2.2 → 2.3.** Level tags of hidden/disabled criteria were
stripped on save (rule 5 violation). Config now loads before tag discovery.
Double Enter mid-save no longer closes the panel.

**QuickNav 1.0 → 1.1.** `Mousetrap.trigger()` on an unbound sequence was
treated as success and blocked the fallbacks; now checks for the binding first
when the internals are inspectable.

**IntifaceSync 1.10 → 1.11.** Beat mode + auto detection for Cock Hero
scripts, after the user's Gush 2 hummed continuously on
`Ccock_Hero_-_Anal_Delirium.funscript` (3,336 actions, all 0/99/100, 232 ms
minimum gap, three speed tiers 106/211/425). See §4.5 "Beat mode".
Untested on hardware; the open question is whether a 120 ms burst at 0.10
(the slowest tier) is felt at all on a Gush 2, or whether `beat_on_ms` needs
to be longer at low levels the way the manual burst modes already do.

**IntifaceSync 1.11 → 1.12.** Ownership follows the active tab; a paused tab
no longer blocks the visible one. See §4.5.

**IntifaceSync 1.12 → 1.13.** Peak picking so beat mode works on FunGen /
tracker scripts, not just Cock Hero square waves. See §4.5 "Peak picking".
Auto mode still will not select beat for these (correct: Speed already works
on them); beat is an alternative feel, chosen manually.

**IntifaceSync 1.13 → 1.14.** User reported the offset "felt like it didn't
work properly". The offset arithmetic was correct; the missing piece was any
clock resync, so timing drifted after a few minutes regardless of the offset.
Added sync heartbeat, playbackRate support, buffering handling, and index
re-seating on offset change. See §4.5 "Clock sync".

**IntifaceSync 1.14 → 1.15.** Signal preview scope for debugging. See §4.5.

**QuickRate, QuickMark and QuickNav merged into QuickTools 1.0.0.** All three
targeted the same page, were all input shortcuts, and all fought video.js for
clicks: one concern, not three. The merge was not cosmetic. QuickRate and
QuickMark each shipped their own copy of `isVideoSurface()` and the
swallow-window logic, and §3.5b told the maintainer to keep the two copies
identical by hand. There is now one of each global handler: one keydown router,
one pointerdown dismiss, one dblclick. A `setActive()` panel registry enforces
one open panel at a time, which also fixes a latent bug where pressing `R` with
the marker panel up produced two overlapping panels both claiming the keyboard.

Behaviour is otherwise unchanged and the `quickMarkRecentTags` localStorage key
is reused, so recents survive the switch. Nav is opt-in
(`enableNav`, default off) because it replaces double-click-to-fullscreen;
rating and markers are opt-out (`disableRating`, `disableMarkers`). Settings
are read once at load from `configuration { plugins }`, so a settings change
needs a page reload.

**Do not add a second global listener to QuickTools.** Route new features
through the existing router and registry, or the load-order bugs come back.

**QuickCriteria archived.** Moved to `archive/`, unused in practice. Not
built, validated or published. §4.4 kept for reference; the rule-5 lesson it
produced (filtered-out items must survive a merge) is still in `CLAUDE.md`.

**IntifaceSync 1.17 → 1.18.** Funscript wave, beat markers and a playhead on
the signal preview. See §4.5.

**IntifaceSync 1.16 → 1.17.** Toolbar redesign for public use, plus a
`disableHotkeys` plugin setting. See §4.5. Also added `plugins/IntifaceSync/README.md`,
which did not exist: the plugin was shipping to strangers with no user-facing
documentation at all.

**IntifaceSync 1.15 → 1.16.** Funscript dropdown replaced by a plain label;
picker demoted to the advanced row and only shown when there is a real choice.

**Not done / next session:** live hardware verification of 1.10; verify the
`isVideoSurface` selectors against the real Stash DOM; consider a "Stop
everything" hotkey in IntifaceSync that calls `_panic` directly (currently `E`
is the kill switch but it is a toggle, not a panic).

---

## 7. Rules for future changes

1. **Validate before delivering.** `node --check` every JS file,
   `python3 -c "import ast; ast.parse(...)"` the Python, `yaml.safe_load` the
   manifests, and run `test_vibe.py` for IntifaceSync.
0. **Never weaken the IntifaceSync safety chain** (§4.5): `pause` may keep
   manual running, but disconnect, deadman and shutdown must all go through
   `_panic`. Any new "stop-ish" path calls `_panic`, not `pause`.
2. **Never write `rating100` from QuickCriteria.** Advanced Rating owns it.
3. **Never enable Advanced Rating's Scenes half** while QuickRate is in use.
4. **Grouping/config parsing must degrade to a working flat list.** Rating
   correctness may not depend on reading another plugin's config.
5. **Preserve unrelated tags** on every tag-set mutation. Rebuild the full
   `tag_ids` array from `other + new levels`, never a partial patch.
6. **Respect the BLE command budget** (~11/s). Simulate before changing any
   emit timing.
7. **Any retry or task-submission loop needs a hard cap**, a cross-tab cooldown,
   and a give-up state. This has caused a real incident.
8. **Path-guard every hotkey.** `R` is bound twice already.
9. Keep panels cursor-anchored and clear of the player control bar.
10. Bump the `version` in the `.yml` on every change.
