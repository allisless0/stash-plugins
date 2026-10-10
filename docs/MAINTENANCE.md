# Stash Plugin Suite — Maintenance Report

Written to be handed to an LLM alongside the source when requesting changes.
It records what exists, why it is built the way it is, and which decisions are
load-bearing. Read this before editing anything.

Last updated: 2026-09-23 (1.22: pattern presets, tease strength build, knob UI, see §6b)

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
| QuickTools | 1.11.0 | UI only | `R` `M` `Shift+M` `U` `D` `T` `F` dbl-click, middle-click, wheel | `/scenes/<id>`; `T` also `/performers/<id>`; `T` `D` on hovered cards anywhere; `F` on scene and performer lists | ~2590 |
| IntifaceSync (vibe fork) | 1.34-vibe | UI + Python backend | `E` `\` `[` `]` `0` | scene player | ~3300 JS + ~2800 PY |
| Collections | 1.2.0 | UI only | none (top-bar tab, O button) | nav, `/scenes`, `/scenes/<id>` | ~720 |
| ScriptBadges | 1.2.0 | UI only | none | any page with scene cards | ~150 |
| Todo | 1.3.0 | UI only | none (top-bar button, page chip) | every page | ~800 |
| Insights | 2.2.0 | UI only | none (Stats page) | `/stats`; watch tracker on scene pages | ~2700 |
| Lockdown | 1.4.0 | UI only | none (top-bar button) | every page while locked | ~750 |
| ~~QuickCriteria~~ | 2.3.0 | archived, not published | `R` | `/performers/<id>` | ~710 |

**Both shipped plugins listen for keys on the scene page**, and the rating
panel takes digits while IntifaceSync binds `0`. QuickTools listens on
`window` (capture) so it always runs first, and its `stopPropagation()` keeps
a handled key away from everything on `document`. IntifaceSync also skips any
key that arrives `defaultPrevented`. Two capture listeners on `document` run
in registration order, which is plugin load order, so do not move QuickTools
back. **Any new hotkey must check its path guard and the other plugin's keys.**

---

## 3. Conventions

These are deliberate. Preserve them. "Panels" are QuickTools' rating and marker
panels; IntifaceSync has its own UI conventions in §4.5.

### 3.1 GraphQL

Raw `fetch` to `/graphql`, `credentials: "same-origin"`. No Apollo, no
PluginApi dependency for data. Errors surface as `json.errors[0].message`.
QuickTools' `gql()` (1.3.0) also turns a non-JSON reply into a sentence
(`httpErrorText()`: "Stash returned 401: logged out?"); before, a lapsed
login showed as "Unexpected token <".

### 3.2 Apollo cache sync (critical, non-obvious)

Stash renders from a normalised Apollo cache. A raw `fetch` mutation writes the
database but leaves the UI stale until reload. Every mutation must poke the
cache (`apolloClient()` in QuickTools):

- Rating uses `cache.modify` to write the field directly (instant, no flash).
- Markers, marker undo and mark-for-delete use `refetchQueries`.

Always guard for `client` being null; the UI must still work without it, just
requiring a reload. **Do not assume PluginApi exists.**

### 3.3 Schema probing rather than assuming

`rating100` vs legacy `rating`, and `end_seconds` on `SceneMarkerCreateInput`
(range markers, 1.3.0), probed at runtime via
`__type(name: "...") { inputFields { name } }`. Keeps the plugins working across
Stash versions. Extend this pattern for any field that has changed historically.

### 3.4 Key handling

QuickTools has **one** keydown router on `window`, capture phase, so it runs
before anything on `document` (IntifaceSync, Stash's Mousetrap) and its
`stopPropagation()` keeps a handled key to itself. Always:

- bail on `ctrlKey || metaKey || altKey`
- bail when `document.activeElement` is input/textarea/select/contenteditable
- bail when the path guard does not match

`scripts/test_quicktools.js` loads the file against a stub DOM and fails if
the number of global keydown, pointerdown or dblclick listeners changes. Do
not add a listener for a new key; add a branch to the router.

### 3.5 Commit semantics (deliberately inconsistent, do not "fix")

| Panel | Click outside |
|---|---|
| Rating | **commits**: a rating is a cheap, correctable single value |
| Marker | **cancels**: a marker is only written on Enter |

Marker undo (`U`, 1.3.0) softens the marker side without changing this.

### 3.5b Video-surface click swallow

When a panel is open and the user clicks the **video itself**, the intent is
"dismiss the panel", not "pause". The capture-phase `pointerdown` detects this
(`isVideoSurface()`: inside `video, .vjs-tech, .video-js, .VideoPlayer` but
**not** inside `.vjs-control-bar, .vjs-menu, .vjs-modal-dialog, button, a`),
closes the panel, then sets `swallowUntil = now + 600ms`. Capture listeners on
`mousedown mouseup pointerup click dblclick touchstart touchend` kill
everything until that deadline so video.js never sees the click. This is why
the dblclick count in the test is two. Control-bar clicks are not swallowed:
the rating panel still commits on play/next. With no panel open nothing is
intercepted. If Stash changes its player DOM, `isVideoSurface()` is the one
place to update.

**Exception for the dblclick (1.4.0, user request).** Rating and moving on
took three clicks: the first click of the double-click closed the panel and
opened the swallow window, which then ate the dblclick too. Now, inside a
window opened by a dismiss (`swallowedDismiss`), the guard hands the dblclick
to `Nav.onDblClick()` before swallowing it. The panel has already closed and
committed by then (`close(true)` is synchronous and clears `active`), so the
rating lands on the scene being left. video.js still sees none of it. A
single click still only dismisses. Verified in a harness with real mouse
input: R, 8, 5, double-click saved 8.5 to the old scene and moved on, and no
click reached the player.

### 3.6 Placement and fullscreen

Panels anchor to the cursor (`mousemove` tracked globally), clamp to the
viewport, and dodge the bottom 80 px of the `<video>` rect so player controls
stay clickable.

**Everything floating goes through `mount()`**, which puts it in
`document.fullscreenElement` when there is one (unless that is a bare
`<video>`, which cannot host children) and in the body otherwise. A fixed
body child is not painted over a fullscreen element. Before 1.3.0 only the
delete overlay did this, so R or M in fullscreen opened an invisible panel
that still took the keyboard and auto-saved a rating typed blind. One
`fullscreenchange` handler in the core re-mounts the open panel and the toast
and calls `Del.onFullscreen()`.

### 3.7 Debug flags

QuickTools: `localStorage.quickToolsDebug = "1"`. The old per-plugin keys
(`quickRateDebug`, `quickNavDebug`, `quickMarkDebug`, `quickCriteriaDebug`)
are dead. IntifaceSync: `localStorage.intifaceSyncDebug = "1"` in the browser,
and the backend logs to `/root/.stash/plugins/IntifaceSync/intiface_sync.log`.

---

## 4. Per-plugin notes

### 4.1 QuickTools rating (R), formerly QuickRate

Writes `rating100` (0–100). Digit buffer logic, now the pure `typeDigit()`
(tested): `8` then `5` yields 8.5, not 85 (if appending would exceed 10,
insert a decimal point). `0` then `5` yields 0.5.
Auto-saves 650ms after the last edit (`SAVE_DELAY`); commits on play, click-away
or scene change. `Esc` is a **real undo**: `original` is captured at open and
written back if anything was committed meanwhile (v1.3.0; before that Esc only
cancelled the pending timer, so anything auto-saved stayed). A `touched` flag
stops the async initial fetch from clobbering `saved` if the user typed before
it returned.

**Esc only undoes to a value it actually read (1.3.0).** `originalKnown` is
set when the initial read succeeds. If that read failed, `original` is null,
and undo used to write null: a network hiccup plus Esc cleared a real rating
(rule 5). Now it leaves the saved value and says so in a toast.

**Known conflict:** Advanced Rating's *Scenes* half also writes scene
`rating100` from its `Scene.Update.Post` hook. If that is ever enabled it will
overwrite QuickRate. Currently the user runs Advanced Rating on performers only.

### 4.2 QuickTools queue navigation (double-click), formerly QuickNav

Triggers Stash's own `p n` / `p p` Mousetrap bindings rather than reimplementing
queue traversal. Three-tier fallback: `Mousetrap.trigger()` →
click a queue control → synthesised keypress (Mousetrap reads `which`/`charCode`,
**not** `key`, so those are set via `Object.defineProperty`).

Requires a populated scene queue; direct-URL scenes have none. Every path
can "succeed" without anything happening (Stash ignores `p n` with no queue),
so since 1.3.0 `go()` checks whether `location.href` changed 1.5 s later and
otherwise shows "No next scene" with a hint. The URL is the only reliable
signal.

**Middle click (1.4.0, user request)** navigates the same way in one click.
It is handled at the top of the single `pointerdown` handler (`ev.button ===
1`), not by a new listener, and only when `Nav.directionFor()` says the click
is navigation: nav on, scene page, on the video, not on the control bar or
inside an open panel. An open panel closes and commits first. A 400 ms swallow
window follows (`auxclick` joined the guarded types): preventing the
mousedown is what stops Chrome's middle-click autoscroll. Middle clicks
anywhere else are untouched. The side logic is the pure `sideOf()`, tested.

Suppresses dblclick-to-fullscreen. Shift+dblclick restores it. The two single
clicks that precede a dblclick still toggle play/pause twice — an even number,
so state is unchanged. Do not "fix" this by delaying single clicks.

### 4.3 QuickTools markers (M), formerly QuickMark

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

**1.3.0:**
- **Undo.** After a marker is written, `lastMarker` holds its id for
  `UNDO_MS` (8 s) on the same scene, and `U` (routed through the one keydown
  router, only when that window is open) calls `sceneMarkerDestroy`. Outside
  the window `U` is not intercepted.
- **Range markers.** `Shift+M` once notes the start (toast), again opens the
  panel with both ends; order does not matter (`orderRange()`), under 0.5 s
  falls back to a point marker, `Esc` with no panel cancels a pending start.
  `<` `>` nudge the end, `,` `.` the start. Sends `end_seconds` only if the
  schema probe finds it; otherwise says so and adds a point marker.
- **Focus handed back on close.** It used to call `focus()` on the
  `<video>`, which cannot take focus, so the caret stayed in the hidden
  search box and the next R/M/D was typed into it. Now it blurs anything
  inside the panel and focuses the `.video-js` container.

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

  **`auto`** = `beat` when `detect_beat_script()` says so, else `speed`. It
  returns `"edge"`, `"graded"` or `""` (it used to return a bool; callers that
  test truthiness still work).
  - `edge`: ≥95% of keyframes within 5 of 0 or 100, alternating on ≥90% of
    them, ≥40 keyframes. Classic Cock Hero. Burst level comes from pace.
  - `graded` (added in the "Fixes to Auto mode" commit, documented and tested
    in 1.21): scripts like "Cock Hero Colors" alternate on every keyframe but
    never reach 0/100 (11↔90, 34↔81), because the swing height carries the
    intensity. Detected on shape, not position: not dense, ≥90% of moves
    reverse, median swing ≥25, and `tempo_grid_score()` ≥0.60. The grid score
    is the part that matters. A hand-made stroker script has the same shape,
    but its intervals are not simple multiples of the modal interval. Burst
    level is `swing / _beat_amp_ref`, where the reference is the script's own
    90th-percentile swing clamped to 40-100, so a script that tops out at 70
    still reaches full. Pace is deliberately not used here: in these scripts
    pace and swing move together, so dividing one by the other cancels out.
  - **Thinning.** `_annotate_beats()` stores each beat's pace and swing on the
    beat (`_ref`, `_amp`), then `_thin_beats()` keeps one beat per
    `BEAT_THIN_MIN_MS` window and carries the loudest swing of the merged run
    onto it. `_beat_target()` prefers the stored values, which is how they
    survive thinning. Runs for graded scripts and for anything with beats
    closer than the window; otherwise `_beats` stays the same object as
    `actions`.
  - **BLE budget (1.21 fix).** Every beat costs two commands, on and off, and
    the off edge is never rate-limited, so beat spacing *is* the command rate:
    150 ms measured 13.3 cmd/s, 180 ms 11.1. `BEAT_THIN_MIN_MS` and
    `BEAT_PEAK_MIN_SEP_MS` are both 190 (10.5/s max). Test 38 sweeps
    100-233 ms for edge and graded scripts; worst case is 10.6/s. Do not lower
    either constant without rerunning that sweep.
  - `_beats_peak_picked` is the real "was this peak-picked" flag and drives
    `beatPicked` in status. `_beats is not actions` no longer means that,
    because thinning also builds a new list. The UI default is still `speed`; the user opts into `auto`.
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

**Popover leaked onto every page (v1.20 fix).** The pattern popover appeared
unstyled at the bottom of the scenes list, performers, everywhere. Three causes
stacked:

1. The document-level dismiss handler called `toggleManualPopover(false)` on
   *every* click anywhere in Stash, and that function built the panel if it did
   not exist. So the first click on any page created it. It now returns early
   when `force === false` and there is nothing to hide, and the handler
   short-circuits unless a popover exists and is open.
2. The panel lives on `document.body`, outside the toolbar, but its CSS came
   from `injectStyles()`, which only runs inside `buildToolbar()`. On a page
   with no player there is no toolbar, so the panel rendered as ordinary block
   content in the document flow. `buildManualPopover()` now calls
   `injectStyles()` itself.
3. Nothing hid it without CSS. It now carries inline
   `position:fixed;opacity:0;pointer-events:none`, cleared when genuinely
   shown, so a stylesheet failure cannot dump it into the page.

**General rule this is an instance of:** anything appended to `document.body`
rather than to the toolbar must not depend on the toolbar for its styling or
its lifecycle. The signal preview is safe because it is a child of the toolbar;
the popover was not.

**Works without a device (v1.19).** Until now nothing happened until Intiface
had a toy attached: no funscript discovery, no script name in the toolbar, no
signal preview. Three separate gates, each defensible alone, together making
the plugin look broken to anyone still setting it up.

1. `onSceneLoad()` only sent `findFunscripts` when `intifaceReady`. Discovery
   is a filesystem read on the backend and needs no device, so it is now gated
   on `wsReady`, and the `ws.open` handler flushes any pending lookup.
2. `BackendServer.__init__` left `self.bp` and `self.player` as `None` until a
   connect. Both are now built up front. `ButtplugClient._send()` returns early
   on a closed socket, so an idle client physically cannot emit a command; test
   34 pins that for `stop_all`, `scalar` and `panic`.
3. `_loop()` skipped `_vibe_tick` when `scalar_devices()` was empty, so the
   scope had nothing to draw. It now ticks when devices exist **or** the
   preview is on, passing the empty device list straight through to
   `_send_level()`, which loops it and emits nothing.

**Connecting a device must not unload the script.** The connect handler
replaces `self.player`, which used to be safe because a script could not exist
beforehand. It now carries `player.actions` across the swap (test 35). If you
touch that handler, keep the carry.

Turning the preview on mid-playback also calls `_ensure_loop()`, since without
a device nothing else would have started it.

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

**Stop Backend killed Stash (fixed 1.31, load-bearing).** The lock file
(`/tmp/intiface_sync.lock`) holds the daemon's PID. `/tmp` survives a
container restart but PID numbering starts over, so after a restart the
stale lock could name a PID that now belonged to Stash. Stop Backend sent
it SIGTERM then SIGKILL and **took Stash down** (user report), and Start
Backend saw that PID alive, logged "already running" and never started, which
is the "Backend unreachable" the user saw at the same time.

Now nothing is trusted or signalled unless `is_backend_pid()` says so: never
PID 1, never the task's own PID or its parent (Stash spawns the task), and
only a process whose `/proc/<pid>/cmdline` contains `IntifaceSync.py`;
unreadable means no. `stop_backend()` finds running backends by command line
(`find_backend_pids()`), uses the lock file only as a verified hint, clears a
stale lock, and re-verifies right before SIGKILL. Start refuses only when a
verified backend is running. The SIGTERM path is unchanged, so the backend's
own handler still runs `_panic()` before exit (rule 1). **Never go back to
killing a PID read from a file without verifying it.** Tests 58-59.

**Backend version check (1.30).** `PLUGIN_VERSION` exists in the manifest,
the Python and the JS, and `validate.sh` fails if they differ. The backend
sends it in every status; once a real status has arrived
(`backendStatusSeen`), a mismatch replaces the status line with "Old backend
(x): run Stop Backend, then Start Backend". Reason: reloading plugins in Stash
does not restart the Python process, and two separate user reports of "the
fix does not work" were a new page talking to an old backend. Bump all three
together. Test 57.

**Toolbar layout (1.30).** Row 1 is split: what is playing on the left (script
button, Manual group, ⚙), the connection on the right in one
`margin-left:auto` group (status, Device live, Connect and Disconnect as plug
icons) so it wraps as a unit and stays right-aligned. The script button shows
the **scene title** (`currentSceneTitle`, else a tidied file name), and is lit
(`is-on`, the same style as "Manual on") only while the script is what drives
the toy: loaded, this tab drives, manual off, mode not off. Dock open/closed
is now a ▾/▴ caret rather than the highlight. With no script it reads "No
funscript · manual when playing". Manual on script-less scenes starts on
**play**, not on opening the page, by design.

**Scripts belong to one video (1.29).** `_best_match()` used to fall back to
the first `.funscript` in the folder when nothing matched, so in a folder of
many videos a scene without a script played another scene's script (user
report: "funscript mode on a video with no script"). Now it returns the
video's own script only: exact or normalised name, else a named variant
(`Video [FunGen].funscript`) unless that longer name is another video in the
folder (`Scene One 2.mp4` owns `Scene One 2.funscript`), never an extra
motion axis, and a lone vibe track as a last resort. `find_funscripts()`
returns that one file or nothing, so the picker never appears. Test 53.

**`unloadScript` (1.29).** Sent by the driver on every scene change and when a
scene has no script; the backend calls `player.unload()`. Without it the
previous scene's script kept playing against the new video. Not a stop path:
manual keeps running (same reasoning as `pause()` / takeover). Driver-only
through `_route`. Test 54.

**Manual on scenes without a script (1.29, frontend).** User request. When the
driver plays a scene whose script lookup came back empty, `autoManualCheck()`
turns manual on with the current pattern; pause, end and scene change turn it
off again (through `autoManualSettle()` since 1.32, see below), but only a session the plugin started
(`autoManualActive`). A manual session the user started is never touched.
Turning manual off during the scene sets `autoManualVeto` until the next
scene. Switch in the ⚙ row ("No script: manual on / silent"), default on.
**Race found in testing:** the backend's status for `play` arrives saying
manual is off (sent before the manual message was processed); clearing
`autoManualActive` on that made pause leave manual running. The status
handler must not clear it. Turning manual off from pause is an ordinary
manual-off, which is always safe; the deadman covers a tab that dies mid-scene.

**Python dependencies go to `_deps/` in the plugin folder (1.33).**
`ensure_package()` imports `websockets` and `aiohttp`, and if either is
missing runs one `pip install --target <plugin>/_deps` with output captured.
Two reasons. First, the Stash container is rebuilt on every image update and
every template edit (user hit this adding CPU limits), which wiped a
system-wide install, while the plugin folder lives in the mapped config
directory and survives. Second, the official image is Alpine, whose Python
is PEP 668 "externally managed". The old code tried a plain `pip install`
first, Alpine refused it, and the refusal went to the Stash log as about 25
red error lines per package before the `--break-system-packages` retry
worked. `--target` skips the PEP 668 check (pip does not apply it to
--target, --prefix or --root), so the system Python is never touched.
`--upgrade` replaces a copy built for an older Python after an image update.
On failure, one error line with pip's last lines, then ImportError. An
existing system-wide install still wins the import, so nothing reinstalls
for users who have one. `_deps/` is in `.gitignore`. Test 60.

**No buzz on seek or next video (1.32, frontend, load-bearing).** User
report: seeking made the toy buzz, and so did the next video. Cause, found in
the harness: on a scene without a script, auto manual stopped on every
`pause` and started again on `play`. video.js turns a timeline click into
pause, seek, play about 100 ms apart, and a queued scene ends just before
the next starts, so each one restarted the pattern from the top, opening
buzz included. Now `pause` and `ended` call `autoManualSettle()`: the stop
only happens if, `AUTO_MANUAL_GRACE_MS` (700 ms) later, the video is still
not playing a scene without a script. A video.js drag (`vjs-scrubbing` on
the player) and a scene whose script lookup has not answered yet
(`sceneScriptPending`) hold the pattern, up to `AUTO_MANUAL_HOLD_MAX_MS`
(8 s). A scene change no longer stops it outright: the funscripts reply
decides. No script means it keeps running without a restart; a script
stops it before the script loads. Leaving the scene pages still stops it at
once. The cost: a real pause stops the pattern 0.7 s late. **Do not go back
to `autoManualStop()` on pause.**

Found alongside it:
- **Duplicate listeners.** Stash keeps one `<video>` across scenes, and
  `onUrlChange` clears `videoEl`, so the same element was hooked again on
  every scene change. After a few scenes every pause went out 6-8 times as
  stop commands over BLE. `hookedVideos` (a WeakSet) now hooks each element
  once.
- **`seeking` handler.** A seek while playing sends `pause` so the script
  does not run on from the old position for the length of the seek. The
  backend's pause leaves manual alone. It is skipped while paused, because
  a drag seeks on every mouse move.
- **Script load starts playback itself.** When the element keeps playing
  across a scene change, no play event arrives. The script used to load and
  sit idle until the next seek or pause; the load reply now sends `play`
  from the live position whenever the video is playing, and a queued play
  also uses the live position instead of the one from when play was pressed.

No backend behaviour changed; the version bump is for the page-backend
check. Verified in the harness against the real backend and fake Intiface.
One `ScalarCmd` for the whole of a click-seek, a 2.5 s drag and a keyboard
seek; one stop 0.7 s after a real pause. Scriptless to scriptless: no
restart. Scriptless to scripted: stop, then the script from the right
position. Not tested in a real Stash with video.js.

**Tease starting buzz length (1.29).** `manual_on_from_ms` / `onFromMs`: the
length build grows from this to Buzz length (now labelled "Final buzz length"
when a build is on). Was fixed at `MANUAL_MIN_ON_MS` (60 ms), too short to feel
on a Gush 2, so a build seemed to do nothing for the first several buzzes.
Backend default stays 60 so old sessions behave the same; the UI default is
200 ms. Changing any build setting restarts the build (`_manual_started =
None`), so a tweak can be felt from the first buzz; other settings do not
restart it. Presets carry `onFromMs` (old presets load as 60). Test 55.

**Safety stops say why (1.29).** `_panic()` broadcasts an `event` with
`safety: true` ("Stopped for safety: the tab that was driving the toy
closed" / "the driving tab went quiet for N s (closed, asleep, or frozen by
the browser)") when something was actually running. The status line shows it
for 15 s. The user saw manual "randomly" turn off; the two causes that survive
testing are exactly these, both by design. Test 56.

**Script dock (1.27): not a popover.** 1.26 put script settings in a floating
popover, which closed on any outside click, and the user tunes while scrubbing
the timeline. Now `#IntifaceSync-dock` sits directly after the toolbar in the
player container, full width, laid out as a header (script name, memory note,
**Live signal** switch, close), the whole-scene strip, then a
`repeat(auto-fit, minmax(250px, 1fr))` grid of three columns (script file,
vibe track and mode cards / Feel / Timing and range), then the scope at 130 px.
Capped at 55vh and scrolls inside.

- It keeps the `.IntifaceSync-pop` class for content styling; the
  `#IntifaceSync-dock.IntifaceSync-pop` rule undoes the floating-window parts
  (fixed position, opacity 0, pointer-events none). It is **outside** the
  toolbar element on purpose: inside it, the toolbar's `#IntifaceSync-toolbar
  button` and `input[type=range]` rules outrank the panel's and flatten the
  cards and slider tracks.
- Built once, moved with `placeDock()` after each new toolbar, so it survives
  scene changes. Only the ♪ button and its own close button hide it; it is not
  in the dismiss handler. `dockOpen` and `previewWanted` are UI preferences in
  the settings blob.
- The scope streams only while the switch is on **and** the dock is showing:
  closing the dock stops the stream and keeps the switch, opening resumes it,
  and `becomeOwner()` resumes it for a tab that takes over.
- Pointer-down in the dock counts as toolbar interaction (soft takeover), like
  the toolbar itself.
- Opening the pattern popover no longer closes script settings.

**Script panel and per-script memory (1.26, frontend only).** (Panel layout
superseded by the dock above; memory unchanged.) The ⚙ row had
grown into script tuning, app settings and a debug scope in one wrapping
line. Now:

- **Script panel** (`#IntifaceSync-script-pop`, opened from the `♪` script
  button in row 1): memory bar, script picker (only with >1 candidate),
  whole-scene intensity strip from the Flow overview (click seeks the video,
  playhead redrawn every 500 ms while open), vibrator-track switch, mode
  cards, mode-specific Feel knobs, Timing (offset) and Weakest/Strongest
  (the old script range), and the live signal scope. Closing the panel
  turns the scope off. Beat Sensitivity is hidden for graded beat scripts,
  whose level comes from swing height.
- **⚙ row**: Handy mode switch (when enabled), Micro pulsing, Shortcuts, a
  pointer to the two panels. Micro pulsing also sits in the pattern panel
  next to the setting that needs it; `toggleMicro()` / `updateMicroButtons()`
  keep both in step via the `IntifaceSync-micro-btn` class.
- Both popovers share the `.IntifaceSync-pop` class (the CSS that was keyed
  on `#IntifaceSync-pattern-pop`), `positionPopover()`, and **one**
  document `pointerdown` dismiss handler. Opening one closes the other.
- `knobRow()` takes `o.prefix`, `o.registry`, `o.onCommit` and `o.words`
  so the script panel reuses it. `buildVibeControls`, `buildOffsetInput`,
  `buildStrokeRange` and `refreshVibeControls` are gone.
- "Stop" is now "Disconnect", which is what it does.
- **Shortcuts button blank (older bug, fixed here).** `updateHotkeyBtn()`
  ran before row 2 was attached to the bar, so `byId()` could not reach it;
  the later refresh from plugin config only runs when `disableHotkeys` has
  been saved at least once. It now runs after `bar.appendChild(row2)` and
  again in `injectToolbar()`. This is the 1.19 lesson again: mount first.

**Per-script memory.** Offset and feel depend on the file, not the user.
While a script is loaded, every script-panel change goes through
`scriptSettingChanged()` and is stored for that script
(`SCRIPT_KEYS`: mode, flow smooth/rhythm/gain, max speed, beat ms/edge/
prominence, offset, range, vibe-track switch). Scripts without memory use
`scriptDefaults`. **The settings blob in localStorage holds the defaults,
not the current values** (`saveSettingsToStorage` spreads
`scriptDefaults` over them), otherwise tuning one script would silently
change the default for every other. With no script loaded, changes set the
defaults. "Use defaults" forgets a script; "Make these my defaults" copies
the current tuning into the defaults.

Storage mirrors presets: Stash plugin config key `scriptSettings`
(`{v, rev, scripts: {fnv1a(path): {path, ...values, ts}}}`) plus
localStorage `IntifaceSync.scriptSettings`, newer `rev` wins, capped at
`SCRIPT_MAX` (200) by oldest `ts`, writes debounced 800 ms. The full path
is stored to reject hash collisions. Memory is applied when the funscript
list arrives (before `loadFile`, so the backend renders Flow with the
right settings) and when the picker changes. `writeStashKey()` now chains
all Stash config writes, because a preset save and a script save in flight
together would each write back the map they had read.

Browser-tested end to end against the real backend: tune timing on one
script, switch to another (defaults), switch back (tuning restored, stored
in the fake Stash config, defaults untouched); Flow knobs and live signal
with a playing video (8.4 cmd/s at rhythm 30%).

**The backend decides which tab drives (1.25). This replaces the two
sections below, kept for history.** The localStorage lock was per browser:
Stash open on a PC and a phone gave two "owners" sending conflicting play,
pause and loadFile to one player. It also needed a 90 s TTL, a
BroadcastChannel and heuristics, and a spectator could not say which scene
was driving.

Now every tab opens the socket and `BackendServer._route()` arbitrates:

- `hello` / `presence` {tab, scene, title, playing, visible}: any tab.
- `claim` {force, ifFree}: granted if nobody drives, the claimant already
  drives, `force` (play, Take over, Connect), or the driver is not playing.
  `ifFree` (a tab opened in the background) is granted only when nobody
  drives, so a middle-click does not steal from a paused tab.
- `play` from a non-driver is itself a forced claim.
- Everything else from a non-driver is ignored, **except the kill
  switches**, which work from any tab: `stop` and `output:false` panic;
  `manual` with `enabled:false` turns manual off and nothing else (a
  spectator's stale pattern values are not applied).
- `findFunscripts` is answered to the asking tab only (it used to be
  broadcast, which was fine only while one tab was connected).

**Safety changes, load-bearing:**

- **The deadman follows the driver.** `_ws_handler` refreshes `_last_seen`
  only for the driver's messages (or anyone's while nobody drives, when the
  device cannot be active). Otherwise a live spectator would keep a frozen
  driver's toy running. Test 50; `validate.sh` greps for it.
- **The driver disconnecting panics even with other tabs open**
  (`_client_gone`: `if was_driver or not self.clients`). Previously panic
  needed the last client to leave; with every tab connected that could
  never happen while a second tab was open. Test 49; grepped.
- A takeover calls `player.unload()`: script, beats, flow and vibe track
  dropped, script output silenced, **manual left running** (same reasoning as
  `pause()`: switching tabs must not end a deliberate session). It is not a
  stop path; the session continues under a driver the deadman watches.
  Without it the old tab's script played against the new tab's video, and
  kept playing if the new scene had no script. Test 51.
- `connect` is idempotent unless `force`: every new driver sends it, and
  rebuilding a live link dropped the device and ended manual mode. Only the
  Connect button forces it. Test 51.
- JS `pagehide` no longer sends `stop` (that also disconnected Intiface for
  the next tab); closing the socket makes the backend panic.
- The driver's heartbeat runs from a blob-URL Worker (`startTicker`), since
  Chrome throttles hidden-tab timers to 1/min after 5 min and a muted video
  counts as silent: a background driver would have hit the 15 s deadman.
  Falls back to `setInterval` if workers are blocked.

JS side: `applyDriver()` on every status; `becomeOwner()` sends mode,
settings, output, connect and the script. A spectator knows its script (the
label shows it) but only loads it when it drives. The status line in a
spectator names the driving scene and is a Take over button. A status
without a `driver` key means a pre-1.25 backend: the tab acts as a single
owner and logs that the backend needs a restart.

End-to-end tested against the real backend in a local runner with two
browser tabs (no Intiface): open, second tab waits with the banner, Take
over loads the new scene's script, closing tabs hands back. Two separate
browsers not tested, but nothing in the path is per-browser any more.
Tests 48-52.

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

**`stop` goes through `_panic()` (1.21).** Tab close (`pagehide`) and
Disconnect both send `stop`. It used to call `player.stop()` only, which
cleared the player's manual flag but left `BackendServer._manual["enabled"]`
set, so a later `manual` message (a slider nudge) could re-arm tease on that
player. Rule 1 says every stop-type path calls `_panic()`; this one now does
so first, then disconnects as before. Test 39.

**Flow mode (1.24): render, don't compute per tick.** The complaint was
that funscripts are written for strokers and none of speed / position / beat
feel right on a vibrator. Speed mode follows each segment, so it is a
staircase that jumps at every turn and needs a global `vibe_max_speed` guess
that is wrong for most scripts. Beat mode is the opposite extreme.

`render_flow(actions, turns, smooth, rhythm, gain)` turns the whole script
into a 25 ms intensity list when it loads:

1. stroke speed on the grid, zero across `VIBE_GAP_MS` gaps;
2. an attack/release envelope (attack 60-360 ms, release 250-2000 ms, both
   from `smooth`), shifted earlier by 70% of the attack so rises land on the
   action instead of after it;
3. normalised so the 90th percentile of the active envelope is 1.0, times
   `gain`, through `x ** FLOW_CURVE` (0.75, lifts slow passages off the motor
   floor; linear left a slow scene at 26%), with release tails under
   `FLOW_CUTOFF` cut to silence;
4. rhythm: between consecutive turning points (`extract_peaks` with the beat
   prominence, `BEAT_PEAK_MIN_SEP_MS` apart) the level is **held constant**,
   on for the first ~45% of the stroke then dipped by `rhythm`. Holding it
   constant is the BLE guarantee: one beat is at most two commands.

Playback is a list lookup in `_vibe_tick` (no EMA; the render already
smoothed). Auto now means Beat for beat scripts and **Flow** otherwise (test
23's expectation changed from speed to flow on purpose). JS default for new
installs is `auto`; saved settings keep their mode. The preview window
carries `flow` points (drawn dashed purple, "flow plan"), and
`overview_cb` sends a 400-point whole-scene strip (`type: "overview"`) on
load and on every re-render; the server caches the last one for new
clients. Render cost: ~120 ms for a one-hour 30 fps tracker script on the
dev machine, on load and on releasing a Flow slider, on the event loop.
If the Unraid box is much slower, move `_render_flow` to an executor.
Tests 45-47 (per-script levelling, fade-out, lookahead, rhythm, budget
sweep over rhythm 0/0.5/1 and 100-600 ms strokes, worst 10.6 cmd/s).

**Dedicated vibrator tracks (1.23).** Some scripts ship a track written
for vibrators next to the main one (`Scene.vib.funscript`, the multi-axis
suffix convention; also `vibe`, `vibrate`, `vibration`, `vibrator`, `v0`).
Its position *is* the intensity, which beats anything derived from stroke
motion. `find_vibe_track()` matches on the loaded **script's** name, so it
follows a script the user picked by hand; `_best_match()` is unchanged and
still gives the stroker the main script. `_load_script()` loads the track
into `player.vibe_track`; the connect handler carries it with the script.

`_vibe_tick()` checks `using_vibe_track()` first (track present, enabled,
mode not `off`). Playback differs from stroke scripts on purpose: linear
interpolation that **holds across long gaps** (50 for ten seconds is a steady
buzz, not idle), no EMA, and `_shape(allow_invert=False)` because invert
flips stroke direction and means nothing for an intensity track. A picked
script that is itself a vibe track (folder with nothing else) is used as its
own track. Status carries `vibeTrack` (file name) and `vibeEffective:
"track"`; the setting is `vibeTrack` / `vibeTrackOn`, default on. Tests 42-44.

**Pattern presets (1.22, frontend only).** Named snapshots of the manual
pattern: shape, period, buzz length, dip, both builds, power limit, micro
pulse. Deliberately **not** the on-switch (loading a preset can reshape a
running session but can never start one) and not the intensity slider (the
live knob).

- **Storage.** Stash plugin config key `patternPresets`, a JSON string
  `{v, rev, active, presets[]}`, not declared in the `.yml` so Stash's settings
  page does not render it. Mirrored in localStorage `IntifaceSync.presets`.
  Stash was chosen over localStorage alone because it survives plugin updates
  and cleared browser data and is shared by every browser. localStorage is
  allowed here: presets are UI preferences, nothing safety-related.
- **Rule 5 on write.** `configurePlugin` replaces the plugin's whole map, so
  `writeStashStore()` re-reads the config and spreads it. If that read fails
  it throws and **does not write**; the generic `loadPluginConfig()` returns
  `{}` on failure and must never feed a write. The status line in the
  popover says "Saved in this browser only" when Stash refused.
- **Why the mirror.** Stash's settings page spreads the config it loaded
  into every save (checked in `SettingsPluginsPanel.tsx` / `context.tsx`,
  develop, 2026-09). A settings tab left open while presets change elsewhere
  therefore writes back an old list. On load the copy with the higher `rev`
  wins and the loser is overwritten, which repairs that.
- **Active preset.** `active` lives in the shared store; `presetBase` (in the
  per-browser settings) records which preset this browser's values came from.
  On load or a `storage` event, if `active !== presetBase` the preset's values
  are applied; otherwise local values are kept because they may be edits.
  "Edited" is computed, never stored: `samePattern()` over only the fields
  the shape reads (`patternFieldsFor()`), so a hidden field cannot mark it.
  Shape is compared separately; putting it in the numeric list made every
  preset permanently "edited" during development.
- Old presets without `buildAmp`/`ampFrom` load with strength build off.

**Tease strength build (1.22).** `manual_build_amp` (cycles, 0 = off) and
`manual_amp_from` (0-1) scale each buzz from `amp_from` to full over that many
cycles, on the same `_manual_cycle` counter as the length build but
independent of it. Plumbed through `set_manual`, the `manual` message
(`buildAmp`, `ampFrom`), `BackendServer._manual` (so reconnects keep it) and
status. **Floor interaction:** a partial-strength buzz can ask for less than
one step while the peak is above the floor, which used to route to the
sub-step pulser and chop the buzz into ticks. `_manual_tick` now holds any
non-zero gate target at one step, like beat mode. Tests 40-41 (41 fails if
the clamp is removed; checked).

**Knob UI (1.22).** The pattern popover draws the pattern with
`patternSamples()`, a JS copy of `_manual_shape_value()`. **Keep the two in
step**: if a shape changes in Python and not here, the picture lies.
`patternSummary()` restates the settings in words. `knobRow()` replaced
`numRow()`: slider plus number box, log scale for period/buzz/micro, square
scale for the builds. Buzz length is shown in seconds but stored in ms. The
advanced row's bare number boxes became named sliders with word readouts
(sensitivity reads gentle/balanced/lively/very buzzy and runs right = more
sensitive, the inverse of `vibeMaxSpeed`). `refreshVibeControls()` now runs
on every status, which also fixes the beat-detail control never appearing
when `beatPicked` arrived after the row was built. The popover repositions on
every update because switching pattern changes its height.

Browser-tested against a harness (fake GraphQL with Stash's replace-on-write
semantics, fake backend socket): save, edit, update, revert, reload, fresh
browser, two tabs, and a stale-settings-page overwrite. Not tested in a real
Stash.

**Tests (1.29: 56 numbered, see validate output for check count):** `test_vibe.py`, 52 checks, run from the plugin's parent directory:

```bash
python3 test_vibe.py
```

It stubs `ButtplugClient` — it verifies wire format, mapping maths, rate limits
and state machines, **not** real hardware behaviour. Motor response to pulsing
is unmodelled and untestable here.

Rate assertions must divide by **measured** elapsed time. Test 18 used to
assume 100 × `sleep(0.02)` = 2.0 s; on Windows each sleep rounds up to ~31 ms,
so it reported 12.5 cmd/s for an emitter really doing 8.3 and failed
`validate.sh` on the maintainer's machine while passing in Linux CI. Tests
that fake `time.monotonic` are immune.

### 4.8 ScriptBadges (1.0.0)

Scene-card badge, bottom-left: "Script · <speed>" or "No script". Data is
Stash's own `interactive` / `interactive_speed`, one `findScenes(ids:)` per
batch of cards, cached 60 s. That is deliberately the same source as the
Scenes page Interactive filter, so the badge and the filter agree. It is also
its limit: Stash only matches `<video name>.funscript` exactly and only at
scan time, while IntifaceSync matches loosely (normalised names, prefixes), so
a scene IntifaceSync can play may still say "No script". Asking the
IntifaceSync backend would be more accurate but would couple the badge to a
running backend; not done.

**Card corners are shared.** Stash: rating ribbon and selection box top-left,
studio overlay top-right, specs bottom-right, `interactive_speed` bottom-left.
ScriptBadges takes bottom-left and hides Stash's bare speed number on cards it
has badged (`.scene-card.sb-done`), since the badge carries the number.
Collections' score badge sits top-centre (moved there in 1.0.1; top-left
covered the rating ribbon). New card decorations must pick a free spot.

1.1.0: scenes without a script get no badge by default (user request: the
absence is the signal). Setting `showMissing` brings back "No script". The
1.0.0 `onlyMissing` setting was never published and is gone. Tests:
`scripts/test_scriptbadges.js`. Browser-checked against Stash-like card
markup with both plugins loaded.

### 4.7 Collections (1.0.0)

A collection is a studio plus its sub-studios with its own top-bar tab, hidden
from the main Scenes list, optionally with round scores. All config is one
STRING setting parsed by `parseCollections()`
(`Tab = Studio, score, show, mode:x, sort:y; ...`, blank = Cock Hero with
score and mode:beat). Studios resolve by exact name or alias through
`findStudios`; a missing studio leaves a greyed tab that says so.

**Tab.** Injected into `.top-nav .navbar-collapse .navbar-nav` with Stash's own
nav-item classes, re-added by the one MutationObserver when React re-renders
the bar. Navigates with `pushState` plus a `popstate` event so React Router
handles it (a plain link would reload the SPA). The URL carries a studios
criterion in Stash's list encoding: JSON with `{ }` swapped for `( )` outside
strings, `encodeURI`, then `?#&;=+` escaped (`encodeCriterion()`, copied
from `ListFilterModel.getEncodedParams` / `translateJSON`; if Stash changes
that, the tab opens unfiltered). Depth -1 includes sub-studios. A URL with
query params does not get the page's default filter, which is why the tab is
unaffected by the hiding.

**Hiding** is Stash's own Scenes default filter, stored in UI config at
`defaultFilters.scenes` (checked in `views.ts` / `useDefaultFilter`; the
older `setDefaultFilter` mutation is deprecated). Written with
`configureUISetting(key: "defaultFilters.scenes")`, which sets one dotted key
and leaves the rest of the UI config alone. `mergeHide()` is the rule-5
part: it adds "studios EXCLUDES x (depth -1)" to whatever is there, merges
into an existing EXCLUDES list or an INCLUDES rule's `excluded` list, keeps
every other criterion, sort and UI option, and refuses (logs a conflict) if
the user has an IS_NULL/NOT_NULL/EQUALS studio rule. The ids it added are
kept in plugin config `managedHidden`, so removing `hide` takes back exactly
those and never a user's own exclusion. It re-applies on every page load:
the setting is the source of truth. After a write it refetches the
`Configuration` query; if the UI does not pick it up, a reload does.

**Rounds** (pure functions, tested): a round starts Hardcore when playback
starts within `START_GRACE_S` (10 s) of 0:00 and drops one way to Easy on a
seek, speed change or reload. `roundTime()` compares the position change
with wall-clock time since the last timeupdate: forward further than
playback could have gone (+`JUMP_S` 1.5 s) or any jump back is a seek; a
buffering stall (position frozen, clock running) is not. Paused scrubbing
over 0.5 s is a seek. The score in both modes is `roundScore()`: the end of
the first coverage interval, if it starts at 0. Coverage intervals merge
across gaps under 0.5 s (pause/play boundaries), so a skip ahead leaves a
gap the score cannot cross until played through. Cleared = score within
`CLEAR_SLACK_S` of the end. Easy coverage is saved in localStorage
(`Collections.round.<id>`, 30 days; UI state, fine under the storage rule)
and restored as Easy after a reload.

**O detection.** One capture-phase click listener: a click on the first
button of `[data-action="o-counter"]` (Stash's `OCounterButton`; the
dropdown toggle and menu are ignored) notes the position, and 900 ms later
`checkO()` re-reads `o_counter` and only counts a loss if it went up. While a
round runs it also polls every 4 s for O pressed some other way. The O count
is re-read on every scene open (`loadScene(id, true)`); a cached count made a
revisit record a loss that never happened, found in review.

**Records.** `roundRecord()` computes only changed keys, written by
`writeRecord()`. Scene custom fields only exist from **Stash v0.31** (checked
against the v0.28-v0.31.1 schemas); 1.0.0 silently disabled scoring without
them, which is why the user could not find it. 1.1.0 probes
`SceneUpdateInput` and uses custom fields (`partial`, never `full`) when
present, else the plugin's own config key `scores`
(`{sceneId: {round_best_hardcore: ...}}`, same shape), written by
read-merge-write of the whole plugin map so the settings and other scenes'
records survive. Writes are chained. Hardcore results also count toward Easy.

**Which tab is lit (1.1.0).** 1.0.0 lit the tab whenever the collection's
studio id appeared anywhere in the URL, and Stash writes the Scenes default
filter into the plain Scenes URL, which contains the same id as an EXCLUDES.
So the tab stayed gold on the main Scenes page. `isTabUrl()` decodes each `c`
criterion and only a studios INCLUDES/INCLUDES_ALL with the id counts. The
link also blurs on click and non-active tabs cannot keep a focus background.

**The player appears late (1.1.1).** Stash's `ScenePlayer` creates the
`<video-js>` element in an effect after the page renders, so it usually
arrives after the plugin has loaded the scene. 1.0/1.1.0 tried to draw the
chip once, found no player, and only retried on a video event, so "Round
ready" never showed (user report; reproduced in the harness by delaying the
player 1.5 s, and confirmed 1.1.0 shows nothing there). Now `attachVideo()`
draws the chip and lines when it finds a new player, the observer draws a
missing chip for any scoring scene, and the 1 s timer does the same as a
backstop. Harness pages must create the player late, like Stash, or they
hide this class of bug.

**Diagnostics.** One `console.info` line at startup (version, studios found,
where scores are stored), and `window.__Collections.status()` returns the
version, collections with resolved studio ids, the current scene's
collection, whether it is scoring, and whether the player and chip were found.

**UI.** The round chip lives inside `.video-js` (video.js owns that DOM, not
React), so it also shows in fullscreen. Best lines go in
`.vjs-progress-holder`. Card badges: cards found by `.scene-card`, ids from
their `/scenes/<id>` link, one `findScenes(ids:)` per batch, cached 60 s.
The observer batches with `setTimeout`, not rAF: rAF never fires in a hidden
tab, which stalled the whole plugin in testing.

**IntifaceSync contract.** `window.__Collections.vibeModeFor(sceneId)` resolves
to the collection's `mode:` or null. IntifaceSync (1.28) calls it per scene
and applies it only to scripts without per-script memory, and never saves it
into its defaults.

Tests: `scripts/test_collections.js` (36 checks: parsing, URL encoding,
default-filter merge incl. rule 5, round rules, records). Browser-tested in a
fake Stash SPA (tab, hiding, badges, a Hardcore round and its record, skip to
Easy, reload continuation, restart). Not tested in a real Stash.

### 4.9 Todo (1.0.0)

User request: "a simple todo list addon". A top-bar button (same markup as
the Collections tabs) with an open-task count opens a fixed dropdown. Tasks
are `{id, text, done, doneAt, created, link?}`; `link` is `{kind, id, label}`
for a scene, performer, studio, tag, gallery or group page (`/movies/` maps
to group). On a linked page its tasks list first and the button is outlined.

**Storage is plugin config, key `items`, a JSON string.** Not localStorage, so
it is the same on every device. Writes are operations (`applyOp`: add, done,
edit, delete by ids, move), replayed onto the list as read from Stash right
before the write, then `configurePlugin` with `{...mine, items}` (the map is
replaced whole, so every other key rides through). Two devices editing at
once both keep their changes; "done" sets a state rather than flipping, and
"clear done" deletes by id, so a replay or a tick elsewhere is not undone.
Writes run one at a time on a promise chain.

**Rule 5 in two places.** `parseItems` returns null for a value that does not
parse or is not a list, and null stops every write with a visible error:
overwriting a list we failed to read would lose all of it. Entries this
version does not understand are kept in storage and only hidden (`isTask`).

Refreshes on open, on window focus, and every 30 s while visible (not while
editing a task). No hotkey on purpose: QuickTools owns the keyboard, and the
add box stops propagation so typing a task does not fire Stash or QuickTools
keys (QuickTools' window-capture router also skips focused inputs).
Tested: `scripts/test_todo.js` (pure helpers), plus a harness run of add,
link, tick, edit, clear, a concurrent "phone" write and a corrupted list.

**1.1.0 (designed in chat with three mockups, signed off).**
- Layout is one grid for every row: a 40 px picture column, text, actions
  (`.todo-r`). Checkboxes sit in the picture column, so all text starts at
  one edge; the page card is inset 6 px with 10 px padding so its picture
  lands on the same column (harness-measured: every picture centred on the
  same x, every text at the same left). Text never wraps (ellipsis, full
  text in the tooltip and the editor).
- Tabs: This page (only on an entity page), All, Done. **All** is
  `groupTasks()`: by link, groups with a pin first, then the newest task,
  General last. **This page** is `tasksForPage()`: the page's tasks, and on a
  scene page also each of its performers' tasks (the user: "if the task is
  related to that performer show it"). Search appears past 10 open tasks.
- New ops: `pin` (explicit state) and `restore` (undo of a delete or of
  Clear done: put back at the old index, skip ids already present).
  Clear done is two clicks, then Undo; no confirm() dialogs any more.
- Link pictures and a scene's performers come from one aliased request per
  40 links (`fetchMeta`, per page load, not stored); tasks keep the label they
  were written with as the fallback. Gallery has no picture (field not
  queried, to avoid version differences).
- Page chip "N todos": appended to `.scene-subheader` or `.detail-header
  .name-icons` (class names from the 0.31 bundle), opens the panel on this
  page's tab. The nav badge reads "N here" on such a page.
- **renderNav and renderChip only touch the DOM on a change**: the
  MutationObserver calls them, and an unconditional textContent write is a
  mutation, which made 1.0 re-render every 80 ms forever.

**1.3.0 (two mockups in chat, signed off: "looks great").** User screenshots
of 1.2.0: every one-task performer got a full header block, so five
"Download" tasks were five big headers; Done showed bare "Download" lines
with no performer; a blank gap sat under the add box. First proposal (single
rows with the link inline, groups only at 2+) was turned down as
inconsistent; the user wanted hierarchy and the same shape for one task or
many.
- Every group, one task or many, General included, is a slim header
  (`.todo-ghead`: 28 px picture, name, "performer · 2 tasks", arrow) and its
  tasks in `.todo-kids`: indented, behind a 2 px guide line. Each group sits
  in a slightly sunk panel (`.todo-g`), which replaces the divider lines.
  Task rows (`.todo-r.todo-task`) are now 18 px checkbox, text, actions.
  This supersedes 1.1.0's single 40 px column for task rows; headers and the
  page card keep their own columns.
- **Done** is grouped the same way (`groupDone`, tested): each group
  newest-finished first, groups by their newest finish, General last. Done
  tasks always kept their link; 1.2.0 just never showed it.
- The "All" tab is labelled **Open** (it only ever counted open tasks); the
  internal value is still `all`.
- `.todo-linkline:empty` is hidden: off an entity page it reserved 28 px for
  nothing.
- This page: the page card, then its own tasks in `.todo-kids`, then each
  performer as a group.

### 4.10 QuickTools `T`: quick tags (1.5.0)

User request: quick tags with T for scenes and for performers on their page.
A panel in the registry like R and M (`Tag`, entry id `tag`), opened from the
one keydown router. `T` is checked before the scene-only guard, using
`targetFromPath()` (`/scenes/<id>` or `/performers/<id>[/tab]`); R, M, D stay
scene-only. Panels tied to a page close when the path changes
(`entry.page`, added to the 300 ms check, since performer pages have no scene
id).

**Writes use `bulkSceneUpdate` / `bulkPerformerUpdate` with `tag_ids: {ids:
[one], mode: ADD|REMOVE}`.** That touches one tag and cannot drop the others,
which a full `tag_ids` write from a stale read would (rule 5, the D module's
"one real trap"). Only if the bulk mutation does not exist in the schema does
it fall back to re-read then `sceneUpdate`/`performerUpdate` with
`nextTagIds()` (tested). The panel stays open after each change; Enter on a
tag already on removes it; Backspace in an empty box takes back the last tag
added in this panel; 1-9 pick recents (`quickToolsRecentTags`, own list, not
the marker recents). **Enter never creates a tag while an existing one
matches** (harness caught "out" creating a tag instead of picking "Outdoor");
the create row is last and only highlighted when nothing exists.

**Hovered cards (1.6.0, user request).** "The one my mouse is hovering":
`T` (scenes and performers) and `D` (scenes only) act on the card under the
pointer in any grid or list, before falling back to the page. No new
listener: at key time `hoveredCard()` calls `elementFromPoint` at the
position the existing mousemove tracker already records, so a scroll under a
still mouse is also right. `closest(".performer-card, .scene-card,
.wall-item, tr")`, then the pure `cardTarget()` (tested) decides: a
performer card is the performer, a scene card or wall item is the scene even
when the pointer is on a performer link inside it, and a table row takes the
kind of the list page so the scene list's performer column does not win. The
card being tagged gets `.qt-card-target` (orange outline) while the panel is
open and the header names it; `D` gives the card `.qt-card-del` and toasts at
the card. A card target has no `sceneId` on its registry entry, or the
close-on-leaving-the-scene check would shut the panel at once on a list
page; it closes on navigation through `entry.page`. `playerRect()` and the
panel's control-bar dodge only look for a player on scene pages: a list's
hover previews are `<video>`s and the toast had latched onto one.
**Harness gotcha:** with the browser pane hidden the viewport is 0x0 and
`elementFromPoint` finds nothing; set a viewport size before testing.

**Rating tags hidden (1.7.0, user request).** Advanced Rating's performer
tags ("Body ★: 5", one per criterion) filled the T panel. `isRatingTag()`
(any ★ or ☆ in the name, tested) hides them from the chips, recents and
search by default; a dashed "+N rating tags" chip toggles them, remembered in
localStorage `quickToolsShowRatingTags` (a UI preference). A rating tag typed
out in full still appears in search. Search asks for 4x the limit so the
filtered list is not short. **Rule 5:** hidden means not rendered, nothing
more. Every write changes one tag by id, so a hidden tag is never part of a
write; harness-checked by removing a visible tag next to three hidden ones.
This is the exact failure the archived QuickCriteria shipped (saving dropped
hidden level tags), so do not add any "save the visible list" path here.

### 4.11 QuickTools `F`: saved filters (1.8.0)

User request: F on the Scenes page or a performer page's scenes opens the
saved filters, to switch quickly, rename, delete, with the Marked for Delete
filter standing out. **Generic by design** (user: "it should work out of the
box"): nothing assumes a particular library; everything comes from
`findSavedFilters(mode: SCENES)`.

**Where:** `filterListPath()` (tested): `/scenes`, and `/performers|studios|
tags|groups/<id>` with no tab or the `scenes` tab. Applying always goes to
the explicit `.../scenes` tab, because a performer with no scenes opens on
another tab by default (Stash's `defaultTabKey`).

**Applying is a navigation, checked against Stash itself.** Stash's list
pages keep their filter in the URL (`useFilterURL`, active on the Scenes page
and on entity Scenes tabs through `alterQuery`), and picking a saved filter
in Stash runs `configureFromSavedFilter` then writes `makeQueryParameters()`.
`savedFilterQuery()` builds that string from the saved filter: criteria as
`{type, modifier, value}` (no value for IS_NULL/NOT_NULL, multi-select values
ordered items, excluded, depth), then sortby, sortdir (lower case), perPage,
disp, z, with Stash's own `{}`->`()` encoding (same as Collections). Before
writing it, 14 real saved filters (tags, performers, rating, IS_NULL, random
sort) were applied both ways on a Stash 0.31.1 and the resulting URLs
compared: identical apart from key order inside `value` (now matched) and the
random seed, which Stash also re-rolls. Unit tests use those strings as
fixtures. **Special saved forms:** handled since 1.9.0, see below; the one left is
EXCLUDES on a criterion without that modifier. The alternative, clicking
Stash's sidebar item, needs the "Saved filters" sidebar section expanded
(collapsed sections do not render their items), so it was rejected.

**Rename re-reads then sends every field back** (`findSavedFilter`, then
`saveFilter` with id, mode, find_filter, object_filter, ui_options unchanged
and the new name): `saveFilter` replaces the whole filter (rule 5). The field
list is Stash's own `SavedFilterData` fragment. **Delete** is
`destroySavedFilter`, two-step (Del or the x twice within 3 s, no dialog).
Both refetch `FindSavedFilters` so Stash's own menu updates.

**Delete pile:** `isDeleteFilter()` (tested) is a tags INCLUDES/INCLUDES_ALL
rule containing the D tag, by id (`Del.tagInfo()`, cached id) or by name, so
it does not depend on what the filter is called. Pinned first, red.

**Performer filters (1.9.0, user request).** `filterListFor()` returns
`{path, mode}`: SCENES as above, PERFORMERS on `/performers` and on the
Performers tab of a studio or tag (both `alterQuery`, checked in the 0.31
bundle). `findSavedFilters(mode: $mode)`. The delete-pile pin stays a scenes
thing (D tags scenes). `savedCriteria()` now mirrors every
`setFromSavedCriterion` override found in the bundle: gender (old string ->
list), custom_fields (whole saved object as value, no modifier), duplicated
(old "true"/"false" -> `{phash}`, missing value -> the object), and number
criteria (old bare number -> `{value, value2}`). All tested. Still not
mirrored: EXCLUDES on a hierarchical criterion whose options lack EXCLUDES
(Stash folds it into INCLUDES + excluded); none seen in practice.

**F is Stash's key too:** `f` = edit filter on list pages, favourite on a
performer page (both Mousetrap). The window-capture router takes it on the
pages above; F again within 600 ms of opening, with the box empty, closes the
panel and calls `Mousetrap.trigger("f")`. Shift+F and every other page are
left alone. "showing" marks the saved filter whose criteria equal the URL's
(`criteriaKey`, order-free).

### 4.12 Lockdown (1.0.0)

User request, designed by interview: lock Stash to one performer until an O.
Answers: performer by spin of favourites, spin of a saved performer filter,
or the performer page you are on (all three); **this browser only**; quit by
holding Give up 5 s (a forfeit); scene roulette as an option; history light.
Allowed while locked: their page (default, scenes, galleries, images tabs)
and any scene, image or gallery they appear in; any scene they appear in
counts for the O.

**State** is localStorage `lockdownState` `{pid, name, image, startedAt,
baseO, roulette, how}`, deliberately per browser. A `storage` listener keeps
this browser's other tabs in step. **History** is plugin config `history`,
read-merge-write with every other key kept, refused if it does not parse
(rule 5), last 200 entries, with entries it does not understand kept.
**Totals are separate (1.2.0):** plugin config `stats`, updated by
`addToStats()` in the same write. Counting totals from the capped list (1.0
and 1.1) would have quietly shrunk them after 200 lockdowns. A history from
before 1.2 has no `stats`; it is built once with `statsFromHistory()`.
Stored totals that do not parse stop the write, like the list. Fields:
done, gaveUp, totalMs, fastestMs, fastestName, streak, bestStreak (a given
up resets streak, never bestStreak; a given-up run is never fastest);
unknown keys ride through. Entries now carry `image` for the avatar.

**1.3.0 (designed with the user in chat first, then signed off).**
- Start dialog: performer search first (`searchPerformers`, `scene_count >
  0`, 8 results, arrows and Enter), the page's performer offered first, then
  "or let a spin decide": Favourites and a Saved filter menu whose items show
  `countFor()` (the converted filter plus `scene_count > 0`, `count` only) or
  "can't use". Clicking outside closes a dialog, except the spin (`sticky`).
- Newcomers: a four-line guide until "Got it" (pref `guideSeen`, back via
  "How it works"); a one-time tip under the bar on the first lock
  (`barTipSeen`); `ldToast()` says why a page bounced (roulette, not theirs,
  performer rule removed).
- Stats v2: `fastestMs` dropped from the display (the user: speed is not the
  point) in favour of **most locked**, from `perf` (`{pid: {name, n}}`,
  lifetime, built from the list the first time it is missing). Old keys ride
  through. Entries get an `id`; older ones are found by `entryKey()`'s
  fingerprint.
- **Removing an entry** (`removeEntry`, two clicks, no dialog) subtracts it
  from done/given up/time/most locked and recounts streaks from the list when
  the list still holds every lockdown counted; past the 200 cap the best
  streak can only be kept (it may include entries no longer listed).
  **Clear history** resets list and totals, other keys kept. Both go through
  `updateHistory(fn)`, the same read-merge-write as recording.
- Full history view: month groups newest first with per-month counts
  (`groupByMonth`), All / Done / Given up chips and a name search
  (`filterEntries`), 30 at a time. All the new pure helpers are tested.

**Enforcement:** `routeCheck()` (tested) says ok / bounce / check a scene,
image or gallery's performers. Runs on pushState/replaceState (wrapped, so
before React renders), popstate and a 250 ms timer. While a check is in
flight `body.ld-checking` shows a veil so a forbidden page is never seen;
results are cached per lock. Bounce goes to their scenes, or with roulette
to a random scene (`findScenes` sorted `random_<seed>`, per_page 2, not the
current one). A failed check counts as not allowed. The top nav is hidden
(`body.ld-on`) and `#ld-bar` sits over it at the nav's height.

**O detection** is the sum of `o_counter` over their scenes, polled every
2.5 s on a scene page and 10 s elsewhere, **only while the tab is visible**
(the harness pane is hidden, so tests override `visibilityState`). Above the
baseline ends the lock; below it (an O taken back) lowers the baseline. This
catches an O from any page, plugin or device.

**Saved-filter spin** needs the saved `object_filter` as a GraphQL
`PerformerFilterType`, a different shape from the URL form QuickTools F uses.
`toGraphQLFilter()` (tested) mirrors Stash's `toCriterionInput` per input
type, with the type of each field read from the schema by introspection
(`__type(name: "PerformerFilterType")`), so it follows the Stash version:
Int/Float/Date/Timestamp, String, Multi and HierarchicalMulti (depth 0 for
EQUALS), Gender (`value_list`, labels to enums), Circumcision (`value`),
StashID, Boolean (`"true"`), plain String (is_missing), custom fields.
**Anything else throws** and the dialog says the filter cannot be used, so a
spin never runs on a silently trimmed filter (e.g. nested `scenes_filter`).
Performers without scenes are never picked.

Give up is a pointer hold with a timer (not rAF, which stalls in hidden
tabs); releasing early resets it.

**1.1.0, user report: "you could still cheat" (clicking tags or
co-performers showed their scenes).** Three fixes, all load-bearing:

1. **Bounce after the router.** Stash's router writes the URL with
   pushState and only then sets the location it renders. 1.0.0 redirected
   from inside the pushState wrapper, so the router's second step rendered
   the forbidden page under the allowed URL (the harness had no router, so
   it never showed). Now the veil goes up synchronously and the redirect is
   `setTimeout(0)` (`later`). The harness page imitates the router
   (`router.push` = pushState, then set `rendered`) and checks `rendered`,
   not just the URL. **Never redirect synchronously from the wrapper.**
2. **Cards are checked, not just routes.** CSS hides every `.scene-card`,
   `.image-card`, `.gallery-card`, `.wall-item` and queue row
   (`li:has(.queue-scene-details)`) under `body.ld-on` until it has
   `ld-ok`; `scanCards()` (observer + 250 ms timer) resolves each with
   `cardItem()` (tested; class picks the kind, since a scene card also links
   galleries) and one aliased query of findScene/findImage/findGallery (the
   list queries' by-id arguments differ: `scene_ids`, `image_ids`, none for
   galleries). Not featuring them, unknown, or a failed check: stays hidden
   (`ld-no` is display none). Fail closed.
3. **No widening their own tabs.** Stash merges any `performers` URL rule
   with the page's performer, so an INCLUDES (any of) rule listed other
   performers' scenes. `stripPerformerRules()` (tested) removes those `c=`
   parts, keeping the rest byte for byte. Enforcement now keys on path and
   query, since such a change touches only the query.

### 4.13 QuickTools mouse wheel (1.10.0)

User request: fold VideoScrollWheel 0.4 (CommunityScripts) into QuickTools.
Its source was read from the user's Stash (`/plugin/VideoScrollWheel/javascript`).
- **One `wheel` listener** on document, capture, `passive: false` (the
  one-handler-per-type rule; the test now expects `wheel: 1`). Capture plus
  stopPropagation also means a still-installed VideoScrollWheel never sees
  the event, so both never seek at once.
- Behaviour kept: its velocity model and constants (`wheelVelocity`, tested;
  friction 0.00015, acceleration 0.55, min, max, decay, timeout), seek
  0.01 s per pixel times speed, volume -0.00065 per pixel, left half volume
  when enabled, negative speed reverses.
- Fixed: `preventDefault` so the page stops scrolling along; left/right is
  measured on `.video-js`, not `ev.target` (the control bar or an overlay
  gave the wrong half); a run of notches accumulates into one target applied
  after 40 ms (`target`, 600 ms run window) instead of one seek per notch;
  its re-seek loop for tiny deltas is replaced by a 1 s minimum step;
  deltaMode lines/pages are converted to pixels (Firefox); sideways scroll
  seeks; a readout toast. Uses the video.js player
  (`#VideoJsPlayer.player`) when present, the `<video>` otherwise.
- Skipped over an open QuickTools panel (its list scrolls), menus, modal
  dialogs, and with ctrl held (pinch zoom).
- **Settings migration:** a QuickTools wheel setting never saved takes
  VideoScrollWheel's value (`FROM_VSW`, both of its historical ids
  `videoScrollWheel` and `VideoScrollWheel`); min speed, decay and timeout,
  which have no QuickTools setting, come from it too (`wheelExtra`).
  `loadSettings` now handles NUMBER settings.
- Harness: a seekable 90 s silent WAV in a `.video-js`; three quick notches
  made one seek, volume and sideways and line-mode deltas checked, page
  scroll prevented only over the player.

### 4.14 Insights (1.0.0, 2.0.0)

User request: a stats plugin combining O Stats 1.0 and Stats Enhancer 1.1.1
(both read from the user's Stash and inventoried first; neither is published
anywhere), with better design. Two mockups signed off (Overview; Activity,
People, Library, Backlog), then the user asked for in-depth performer
analysis ("height, nationality, etc."), colours, good UX. Decisions: on the
Stats page, own watch tracker with O Stats import, name Insights.

**Placement.** Stash's Stats page draws three `.stats` rows (sizes and
counts; images, galleries, studios, tags; O's and plays). Up to 2.0.0
Insights went after the *first* one, which put it between them (user
screenshot); since 2.1.0 it goes after the last. A MutationObserver runs only
while on `/stats`, to put it back after React redraws.
**Stash's own numbers are hidden** (2.1.0, user request: Insights shows all of
them). `syncNative()` adds one `<style id="insights-hide-native">` with
`.stats { display: none }` while on `/stats` and removes it elsewhere; React's
elements are never removed or moved (Stats Enhancer hid a tile by
`nth-child` and resized the rest). Hidden from the first tick so they do not
flash; plugin setting `showStashNumbers` (BOOLEAN, off) brings them back,
read once at load (`readConfig`). `updateConfig` merges, so the watch-time
writes keep the setting.

**Data.** One paged pass: scenes 500 per page, performers 1000 per page,
fields chosen by introspecting `Scene` and `Performer` (`fieldsOf`, `pick`),
so a Stash without e.g. `career_start` still loads (`career_length` is the
fallback). Compacted (`compactScene`, `compactPerformer`) and cached in
IndexedDB for 30 minutes (localStorage is too small; O Stats hit its quota).
Everything else is pure functions over that (all tested in
`scripts/test_insights.js`): no second fetch (O Stats fetched the library
twice), no per-performer queries (Stats Enhancer's age chart was N+1).

**Dates are local.** `dayKey`, `parseDay` (YYYY-MM-DD as local midnight),
`daysBetween` by calendar day. O Stats' year view used `new Date('YYYY-MM-DD')`
(UTC) and filed O's in the wrong month west of UTC. Weeks start Monday.
O's without a timestamp (`o_counter` above the `o_history` length) are
counted in totals and per scene and reported as "N more without a date".

**What works for you** (`traitRows`): for one dimension, each scene counts
once per value however many of its performers share it; shares of scenes,
O's (scene `o_counter`), plays and play duration; lift = O share / scene
share. `small` (under 5 scenes, or under 2 O's and 3 plays) is hidden by
default. Tones: >= 1.25 up (green), <= 0.8 down (coral). Performer traits:
country (upper-cased), ethnicity, hair, eyes, height/weight groups, cup from
measurements, natural/enhanced, tattoos/piercings, age on the scene date,
career years at the scene date, favourites, performer tags. Scene traits:
tags, studios, cast size, length, resolution, release era, interactive.
"Strongest pulls" = non-small rows with lift >= 1.25 and >= 8 scenes,
ranked by (lift - 1) x sqrt(scenes). Rows link to filtered performer or scene
lists (`traitLink`; criteria in Stash's URL encoding, same as QuickTools F);
cup, natural, career, weight, resolution, length have no link.

**Flags:** Windows has no flag emoji (two letters render). Stash ships the
flag-icons stylesheet (performer cards use `fi fi-xx`), so 2.0 uses
`<span class="fi fi-xx ins-flag">`; `flagsAvailable()` checks once that the
class has a background image and falls back to the code badge (`.ins-cc`).
`.ins-flag` forces `position: static`, `margin: 0`, `filter: none`: Stash
positions `.fi` absolutely inside its own cards and those rules would
otherwise drag our flags into a corner. Countries go through `countryCode`
first: old data stores names ("United States", "czech republic"), which map
back to codes via `Intl.DisplayNames` plus a few aliases.

**Watch tracker** (replaces O Stats' Python task and its `watch_data.json`):
a 1 s tick counts a second while `#VideoJsPlayer video` on a `/scenes/<id>`
page is playing (not hover previews: O Stats counted every `<video>` and
multiplied by how many played). Seconds go to localStorage per tab
(`insightsWatch:<tab>`), flushed every 60 s into plugin config `watch`
(`{day: seconds}`) with `addWatch` (read-merge-write, adds; never a whole-map
overwrite). Keys of tabs that stopped refreshing `insightsAlive:<tab>` for 3
minutes are claimed by the next flush, so a closed tab loses nothing. A watch
map that does not parse stops the write (rule 5).
**O Stats import:** `/plugin/ostats/assets/watch_data.json` if present;
`mergeOStats` takes both its formats and keeps the larger value per day
(both trackers may have run the same day); sets `ostatsImported`.

**2.0.0 redesign.** User feedback on 1.0: "boring, feels like a corporate
dashboard", too centred on O's; wanted the library itself, codecs,
"comprehensive". Signed off in chat over four mockups: style "mix" (bold for
the big picture, console for files), You tab first, then the user chose
**Flexoki** (Steph Ango's ink-and-paper palette) over three other warm
palettes and asked for depth; then asked for exact values on every graph,
flags, more icons (not overdone), and tabs that change colour when active.

- **Tabs** (`TABS`): You (magenta; the old Overview, Activity, People and
  Backlog), Library (orange), Files and quality (cyan), Metadata health
  (yellow), Collection (green). `#insights[data-tab]` sets `--acc`; each tab
  button carries `--tc` and tints with `color-mix` when on. Old `tab` prefs
  fall back to You.
- **Depth:** cards are raised (lit top border, gradient, drop shadow);
  data wells (`.ins-well`, chart backgrounds, tracks, the tab strip) are sunk
  (inner shadow, dark top edge). The dashboard has its own `#100F0F` panel so
  the warm palette does not sit on Stash's blue-grey.
- **Charts** (`barChart`): every bar has its value above and its label
  below; past 16 bars with labels or values over 2 characters, both turn
  sideways (`.dense`). Year timelines fill empty years with a zero bar so
  gaps show. Future days in a month are blanked. Calendar month labels carry
  the month total; the weekday/hour map has row and column totals. Clicks go
  through a `CLICKS` array (`data-bar`), reset each render.
- **Data added:** files (`FILE_WANT` via `__type VideoFile`: width, codecs,
  frame rate, bit rate, format, `fingerprints { type }` for phash), studios
  with `parent_studio`, `stats`, and **counts** (`loadCounts`): one aliased
  query of `findX(filter: {is_missing: ...}, per_page 1) { count }` for every
  completeness row, plus organized, has_markers, scene_count 0/1. Stash
  counting with the same filter the row links to means the number always
  matches the list, and no `details` text is downloaded to count it. If the
  batched query fails (an `is_missing` value an older Stash lacks), each runs
  alone and failures drop just their row. Cache key bumped to `v2`.
  `size` is now every file of a scene; `fsize` and the rest describe the first.
- **Files** (`fileStats` etc., tested): `codecName` normalises ffprobe names
  (wmv1-3 are WMV, msmpeg4v* MPEG-4); `LEGACY` codecs plus below-720p are
  upgrade candidates, most O's and plays first. `resBucket` uses the larger of
  the short side and the long side x 9/16, so portrait and cinema crops land
  where people expect (Stash's own resolution filter, which the rows link to,
  uses its own steps, so counts can differ a little; the tooltip says so).
  VR is told by shape (`shapeOf`). Space hogs: over 2.5x the median bitrate of
  their resolution, over 1 GB, at least 10 files at that resolution; saving =
  size minus duration x the median HEVC/AV1 bitrate there (half the median if
  under 5 such files). Duplicates: `findDuplicateScenes(distance: 0,
  duration_diff: 1)` (retried without `duration_diff` for older Stash), only
  on a click; `dupPlan` keeps the sharpest, then the better codec, then the one
  with more history. Read-only; links to `/sceneDuplicateChecker`.
- **Health:** weights per field (`HEALTH`; a missing studio, performers or
  tags hurts finding things more than missing details), groups 70/22/8 for
  scenes, performers, studios. Percentages and the grade use the score
  rounded down so 79.7% never shows as 80% with a B. Quickest wins = the gaps
  whose filling raises the score most. Checks: no file (`file_count` 0), scene
  dated before a performer's 18th birthday (`rawAge`, unfiltered; counted per
  scene, pills per pair), same name and disambiguation, future release dates,
  no phash, tags used once, performers and studios with no scenes.
- **Collection:** `growth` fills every month from the first added; `coTags`
  lift = share of A's scenes with B over B's share of all scenes (pairs seen
  under 3 times dropped); `networks` walks parents to the top (guarded against
  loops) and lists independents apart; `pairs` skips casts over six.

### 4.14b Insights 2.2.0: Actions tab, readable What works

User (with screenshots): wanted the actionable parts in one place with real
functions, "a proper duplicate checker" whose target is HEVC so other copies
can go in one click; What works did not show the highest, sorting made no
sense for things like height, bars too long to read, pills laid out badly;
the space treemap hard to read. Mockup signed off; "AV1 is as good as HEVC".

**Actions tab** (red, second). Upgrade, space hogs and duplicates left Files;
the checks left Health (both now point to Actions). `problemChecks(m)` is
shared; `checkRow` renders a check.

**Duplicate cleaner.** `loadDuplicates` (now with file ids) on a click;
`dupChoose(group, mode, {sharp})` (tested) decides per group:
- `hevc` (default): `isEfficient` = HEVC or AV1. Keep the sharpest of those
  (then codec rank, bitrate, history, lower id). No HEVC/AV1 copy: a "look"
  group, nothing ticked. With `sharp` on, a copy sharper than the kept one is
  not ticked and the group is a "look".
- `best`: sharpest, then codec, then bitrate. `smallest`: smallest file
  among the sharpest copies.
User ticks override per scene (`acts.ticks`, reset when the mode or the
safeguard changes). Two writes:
- **Tag for delete**: `bulkSceneUpdate` ADD of QuickTools' `deleteTagName`
  (read from QuickTools' config, default "Marked for Delete"), created if
  missing. Reversible.
- **Remove** (two clicks, 6 s arm): `removeCopies` per group, sequentially.
  It re-reads the group (`loadForMerge`, aliased `findScene`) and refuses if
  the kept scene or a copy is gone or the kept scene's first file id changed
  since the scan. With merge on (default): `sceneMerge(source, destination,
  values, play_history, o_history)` moves the copies' files and markers to
  the kept scene and deletes the copy scenes (Stash keeps the destination's
  primary file); `values` = `mergeValues` (tested): kept fields win, empty
  ones filled from copies, union of tags, performers, galleries, groups, URLs,
  StashDB ids, limited to the `SceneUpdateInput` fields this Stash has
  (`inputFieldsOf`). Rule 5: nothing set on a copy is lost. Then
  `deleteFiles` on exactly the file ids that belonged to the copies. With
  merge off: `scenesDestroy(delete_file, delete_generated)`. Errors stop that
  group only. Afterwards the cache is marked stale (`cachePut({at: 0})`).
  Merge behaviour checked against Stash's `pkg/scene/merge.go` (files and
  markers move, sources destroyed without their files, tags/performers only
  through `values`).
- **Not HEVC or AV1 yet** (`notEfficient`, tested): gain = size minus duration
  x the library's median HEVC/AV1 bitrate at that resolution. Tag top 100 or
  all "Re-encode" (`tagScenes`, ADD, 500 per call); "Open all" uses
  `video_codec NOT_MATCHES_REGEX hevc|av1`.
- **Generate phashes**: `metadataGenerate({phashes, sceneIDs})` for exactly
  the scenes without one.

**What works.** Sidebar of dimensions (`.ins-side`), rows `.ins-lr`: rank,
name, a bar on a log scale centred on 1x (`liftPos`: 1/4x to 4x), shares,
lift. `rankTraits` (tested): small = under max(5, 0.1% of scenes) or too
little activity; strength = ln(lift) x sqrt(scenes) (the 2.0 sort by raw
lift put six New Zealand scenes at 12x on top; `(lift-1) x sqrt` still did);
ranks by strength; top three with lift >= 1.25 highlighted. Ordinal
dimensions (`ORDER`, plus era by year) keep their order under "In order"
(sort `auto`); others are strongest first. Changing dimension resets sort.

**Where the space goes** (`spaceCard`): a ranked list by studio, network
(networks plus independents), codec or resolution; 15 rows, 40 with "show
more". The treemap is gone.

### 4.15 Shared Flexoki theme (all plugins)

User asked, after Insights 2.0.0, to "apply the same theme to all my other
plugins". The spec is `docs/THEME.md`: Flexoki dark palette, raised surfaces
(lit top border, gradient, drop shadow), sunk wells (inner shadow), the button,
selected-chip and icon-badge recipes, and the rule that anything sitting inside
Stash's own UI (navbar buttons, card badges, studio-page tabs) takes Flexoki
accents but no dark slabs. Colours only: no layout, DOM, listener or logic
changes. A grep for hex colours outside the palette came back empty for every
plugin.

Versions: QuickTools 1.11.0, Collections 1.2.0, ScriptBadges 1.2.0, Todo 1.2.0,
Lockdown 1.4.0, IntifaceSync 1.34-vibe (its `.py` changed only in
`PLUGIN_VERSION`; restarting the backend is still needed to clear the stale
warning).

Accents and the decisions worth keeping:
- **QuickTools:** rating yellow, markers blue, tags green, filters purple,
  delete red, wheel cyan. Toasts take the accent of what made them, through an
  extra class (`qt-tags`, `qt-filters`, `qt-wheel`) beside `qt-info`; toast
  timing only looks at `qt-err`, so behaviour is unchanged. "Marker added" was
  passing `""` and so got the default red border, which read like a delete
  warning; it is `qt-info` now. Errors are orange, not red, so they stay
  distinct from the red "Marked for delete" toast. "create" rows are yellow so
  they do not blend with the green "already on" in the tag panel.
- **Collections:** orange. The lit top-bar tab uses
  `.coll-nav a.btn.btn-primary.active` to outrank Bootstrap's active rule;
  idle tabs keep Stash's look. Hardcore yellow, Easy blue, round over red.
  `VERSION` in the JS is bumped with the manifest.
- **ScriptBadges:** "Script" solid green with dark text; "No script" a dark
  pill with an orange edge. The outline is a box-shadow so badge size is
  unchanged.
- **Todo:** green, pins yellow, delete red, scenes cyan, performers magenta.
  New edges on the page card, icon tiles, avatars and thumbnails are
  box-shadow rings, not borders: a border would push the aligned 40px media
  column by a pixel. Group-header hover colour comes from `:has()` on the
  header's media; older browsers keep the plain underline.
- **Lockdown:** lock red; O drops magenta (were blue); gave-up coral. Every
  `display`/`visibility`/`opacity`/`pointer-events` line used for enforcement
  was diffed: only colour values changed. The navbar button stays Stash's,
  with a red icon.
- **IntifaceSync:** brand magenta (active mode, every `is-on`, selected
  patterns and presets, preview curve); green live/connect; red
  disconnect/errors, with Disconnect the strongest red on the bar and "Device
  muted" quieter; yellow warnings, stale backend and the motor-floor line.
  Scope: script grey, flow purple, target blue, level green, command ticks
  orange. The toolbar stays a translucent dark strip so it sits in the player.
  Logic diffed with colours masked: no change.

### 4.6 QuickTools `D`: mark for delete (1.1.0-1.2.0)

Toggles a tag (default `Marked for Delete`, `deleteTagName` setting) on the
current scene. **The plugin never deletes anything**; the user filters by the
tag later.

- **Not a panel.** It never joins the `setActive()` registry, so it does not
  take the keyboard or close on the next click. The keyboard router lets `D`
  through the rating panel on purpose: `R` then `D` saves the rating and marks.
- **Rule 5.** `sceneUpdate` replaces `tag_ids`, so `applyToggle()` reads the
  scene's full tag list and writes it back with the one id added or removed.
  Never send a partial list.
- **Tag id cache.** `quickToolsDeleteTag` in localStorage holds `{name, id}`;
  renaming the tag in settings invalidates it. The page-load path
  (`ensureTag(false)`) never creates the tag. A failed toggle forgets the
  cache, re-resolves and retries exactly once (covers a tag deleted in Stash).
- **The overlay is mounted through the core's `mount()`** (§3.6), placed from
  the video's rect on a 500 ms poll plus resize/scroll. The toast moved to the
  core in 1.3.0 and is shared by every feature.
- **Recheck on return (1.3.0).** The tag can be removed elsewhere (Stash's tag
  editor, another tab); `recheck()` re-reads it on window focus and when the
  tab becomes visible, without clearing the overlay first. The tint stops above `.vjs-control-bar` so the timeline
  stays readable. Appending into the player DOM would be simpler and would be
  wiped by React's next render.

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
| IntifaceSync | The pattern popover lives on `document.body`; in browser fullscreen it is not painted over the fullscreen player (QuickTools now mounts into `document.fullscreenElement`, §3.6; same fix applies). The toolbar and dock are outside the fullscreen element and not visible in fullscreen at all. |
| IntifaceSync | Dock height in a real Stash layout unverified: tested in a harness page. If Stash's player column clips it, the 55vh cap and internal scroll are the knobs. |
| IntifaceSync | Per-script memory is keyed by file path: moving or renaming a script loses its tuning. |
| IntifaceSync | Signal preview untested against a real device stream; sample timestamps are backend-monotonic, so if the canvas looks frozen check that frames are arriving rather than that the toy is idle. |
| IntifaceSync | Clock sync untested on hardware. Check `driftMs` in the status payload during a long scene; it should stay under ~150 and never trend. |
| IntifaceSync | `SYNC_GAIN` 0.25 at a 2 s heartbeat means a 100 ms drift takes ~8 s to ease out. Fine for vibrators, possibly too slow for a stroker. |
| IntifaceSync | Beat mode untested on hardware. Cock Hero: `Auto`, raise burst ms if slow sections are inaudible. FunGen: `Beat` manually, drop `vibeMaxSpeed` to ~250, tune prominence. |
| IntifaceSync | Beat level scaling is not normalised per script (Flow is, since 1.24). Flow on a beat script with Rhythm near 100% may make Beat mode redundant; check on a Cock Hero file before removing anything. |
| IntifaceSync | Flow constants (attack/release ranges, `FLOW_CURVE` 0.75, 90th-percentile reference) were tuned on synthetic scripts only. Tune on the user's real files with the signal preview. |
| IntifaceSync | `BEAT_DENSE_MEDIAN_MS` 150 is a guess. A tracker running at 10fps (100ms) is caught; one at 6fps (167ms) is not and would fire per raw keyframe. |
| IntifaceSync | Micro pulsing untested on real hardware; may read as a tick rather than a hum at low duty. |
| IntifaceSync | Graded beat detection tested only on synthetic scripts. Thresholds (`BEAT_ALT_FRAC` 0.90, `BEAT_MIN_MEDIAN_SWING` 25, `BEAT_GRID_FRAC` 0.60, grid tolerance 8%) are guesses. Check that a real "Colors" script classifies as `graded` and a hand-scripted stroker file stays `""`. Swing-based levels apply to graded scripts only; the edge and peak-picked paths are still pace-based and unnormalised. |
| IntifaceSync | Beat spacing raised to 190 ms in 1.21 for the BLE budget. Scripts faster than ~5 beats/s now merge beats (loudest swing kept). Check that fast Cock Hero sections still feel like a beat, not a blur. |
| IntifaceSync | Presets and knob UI tested only in a harness, not a real Stash. Check: save a preset, reload, open Stash Settings > Plugins and change an IntifaceSync setting, reload the scene: the preset list must survive. Check the popover position when the player is fullscreen. |
| IntifaceSync | 1.33 `_deps` install untested inside the real Alpine Stash image (tested with a stubbed pip). Check after a container rebuild: one "Installing websockets into the plugin folder" line, no PEP 668 errors, backend starts; then rebuild again and confirm nothing reinstalls. |
| IntifaceSync | 1.32 seek and next-video handling tested in a harness, not real video.js. Check in Stash: a scene with no script, manual pattern running; click the timeline and drag it; the pattern must not restart. Play a queue of scenes without scripts; the pattern must not restart between them. Pause; it stops within a second. |
| IntifaceSync | Tease strength build untested on hardware. A starting strength under the motor floor is held at the floor, so on a Gush 2 the first few buzzes of a very gentle start may all feel the same. |
| QuickTools | 1.3.0 tested in a harness page (fake GraphQL, synthetic keys, fullscreen simulated by overriding `document.fullscreenElement`), not in a real Stash. Check: R in real fullscreen shows the panel; Shift+M twice makes a marker with an end time on your Stash version; U within 8 s removes it. |
| QuickTools | No touch access: R, M, D and T are keyboard-only. |
| QuickTools | 1.10.0 wheel tested on a plain `<video>` in a harness, not through video.js. Check in Stash with VideoScrollWheel disabled: seek and volume feel the same as before, the readout shows, the page does not scroll over the player, and fullscreen works. |
| QuickTools | 1.8.0 `F` applying verified against a real Stash 0.31.1 (URL comparison over 14 saved filters); rename and delete tested on a fake GraphQL only. Check in Stash: rename a filter and see the new name in Stash's own saved-filter menu without a reload; F F opens Stash's edit-filter dialog on /scenes and toggles favourite on a performer page. Performer filters (1.9.0) tested on the fake GraphQL only: check one on the real Performers page. |
| QuickTools | 1.6.0 hovered cards tested on harness markup (`.scene-card`, `.performer-card`, a table row), not Stash's real grid. Check in Stash: T over a scene card, a performer card, the list view and the wall. If a view does not respond, its card class is missing from `CARD_SEL`. |
| QuickTools | 1.5.0 `T` tested in a harness against a fake GraphQL (bulk ADD/REMOVE), not a real Stash. Check: T on a scene and on a performer page; the tags appear in Stash's own tag list without a reload (Apollo refetch of FindScene / FindPerformer). |
| Insights | 2.2.0 duplicate removal was tested only against a fake Stash that imitates `sceneMerge`/`deleteFiles`. Before the first real cleanup, try one group: check the kept scene shows the merged O's, plays and tags, the copy scene is gone, and the copy's file is gone from disk (and the kept file is not). Also check `NOT_MATCHES_REGEX` on `video_codec` opens the right list. |
| All | The Flexoki restyle (QuickTools 1.11.0, Collections 1.2.0, ScriptBadges 1.2.0, Todo 1.2.0, Lockdown 1.4.0, IntifaceSync 1.34-vibe) passed every unit test but was not looked at in a browser. Check each panel in the real Stash, especially elements inside Stash's own UI (navbar buttons, card badges, studio tabs) and the IntifaceSync toolbar over the player. |
| Insights | 2.0.0 tested on a synthetic 1500-scene library in a harness (with Stash's flag stylesheet), not a real Stash. Check on the real library: the counts query is accepted in one go (else it falls back to one query per row), `is_missing` links open the same counts, the `video_codec`/`audio_codec`/`resolution`/`framerate`/`file_count`/`has_markers` criterion shapes open the right lists, `findDuplicateScenes` time on a big library, and flags render next to the text. |
| Insights | 1.0.0 tested on a synthetic 400-scene library in a harness, not a real Stash. Check on the real library: load time and progress text, the dashboard placement on /stats, trait links open the right filtered lists (some criterion shapes, e.g. `filter_favorites`, `performer_count`, `created_at`, were not verified against the bundle), and the O Stats import count matches its file. |
| Insights | Performance on very large libraries (tens of thousands of scenes) unmeasured; the compute is linear but every trait dimension is computed on first view. |
| Lockdown | 1.3.0 dialog and history view checked in the harness at desktop and narrow widths, not in a real Stash. Check the dialog's fit on a phone, and that the search finds performers on a large library quickly (it asks for 8 by name). |
| Lockdown | 1.1.0 card hiding relies on Stash's card classes (`scene-card`, `image-card`, `gallery-card`, `wall-item`, `queue-scene-details`, seen in the 0.31 bundle). A card type with another class (a new view, a plugin's own cards) is not hidden. Check the wall and list views on a real Stash while locked. |
| Lockdown | 1.0.0 tested in a harness against a fake GraphQL, not a real Stash. Check: the bar covers the real nav at its height on desktop and mobile; a saved-filter spin on a real filter (tags, gender) picks only matching performers; O on the real scene page ends it within ~3 s; Stash's own hotkeys that navigate (g s etc.) bounce back. |
| Lockdown | Gender labels to enums assume Stash's labels are the enum names in words ("Transgender Female" -> TRANSGENDER_FEMALE, "Non-Binary" -> NON_BINARY). True for 0.31; check if a gender filter spin finds nobody. |
| Todo | 1.1.0 chip placement depends on Stash's `.scene-subheader` / `.detail-header .name-icons`; tested on harness markup copied from those names. Check in Stash that the chip lands by the title on scene, performer and studio pages. |
| Todo | 1.0.0 tested in a harness, not a real Stash. Check: the button lands in the top bar on desktop and mobile widths; the list survives a reload and shows on a second device. A very long list is one config value; fine for hundreds of tasks, not designed for thousands. |
| QuickTools | 1.4.0 middle click tested with script-dispatched events only (the harness browser cannot press a real middle button). Check in Stash: middle-click the right half of the player, it goes to the next scene and does not start autoscroll or pause the video. |
| ScriptBadges | Stash's exact-name matching means scripts IntifaceSync finds (fuzzy names) can show as "No script". An optional check through the IntifaceSync backend would fix that. |
| Collections | Untested in a real Stash. Check: the tab lands in the nav bar and filters; the Scenes page hides the studio (maybe after one reload); a Hardcore round records on O; the chip shows in fullscreen; cards show badges. |
| Collections | Hiding covers the Scenes page only. `performer_scenes`, `tag_scenes` etc. are separate default-filter views and could get the same merge. |
| Collections | Pressing O by Stash's keyboard shortcut (if any) is caught only by the 4 s poll, so the recorded position can be up to 4 s late. |
| QuickTools / IntifaceSync | Key-clash fix (QuickTools on `window`) follows from DOM event order but is untested in a live Stash. Check: IntifaceSync manual on, press `R`, type `10`, manual stays on. |
| IntifaceSync | Funscript discovery uses `files[0].path`; multi-file scenes may resolve the wrong directory. |
| IntifaceSync | Spectator tabs (1.25) show who drives and a Take over button, but their toolbar controls still look live and silently do nothing except the kill switches. Could disable them visually. |
| IntifaceSync | 1.25 arbitration untested across two real browsers/devices and in a real Stash (only two tabs of one browser against a local backend). Check: PC plays, phone opens a scene, phone shows the banner; phone presses play, PC shows it. Also check the Worker heartbeat is not blocked by Stash's CSP (console would show the fallback silently; a background muted driver stopping after ~5 min would mean it failed). |
| QuickRate / QuickMark | `isVideoSurface()` selector list is a guess at Stash's video.js DOM. If a video click still pauses, inspect `ev.target` and extend the selector. |
| QuickNav | `isBound()` inspects Mousetrap internals (`_callbacks`/`_directMap`); on builds where they are closure-private it returns `null` and behaves as before (trust `trigger`). |
| QuickNav | Silent no-op when there is no scene queue. |
| ~~QuickCriteria~~ | Archived; depended on upstream's `★` tag naming, which a format change upstream would break. Relevant only if it is revived. |
| All | `runPluginTask` / mutation argument shapes vary by Stash build. |

---

## 6b. Session log

### 2026-10-11: Insights 2.2.0, Actions tab and a real duplicate cleaner

User asked for actionable insights in one place, a duplicate cleaner targeting
HEVC (AV1 counts too) that removes the other copies in a click, and fixes to
What works (no highlight of the best, odd sorting for height, long bars,
messy pills) and the space treemap. Mockup signed off. Stash's merge and
delete mutations were confirmed by introspecting the user's Stash (read only)
and its merge source. 19 new checks (116), harness run of scan, tick, tag,
remove (merge then deleteFiles per group), re-encode tagging and phash
generation; one bug found and fixed there (a finished cleanup kept the
controls disabled). See §4.14b.

### 2026-10-10 (late night): Todo 1.3.0, consistent hierarchy

User screenshots of the restyled Todo: heavy headers for single tasks, done
tasks without their performer, a gap under the add box. Two mockups; the
second (same header for every group, tasks indented behind a guide line,
Done grouped too) signed off. 4 new checks (45), harness run of Open, Done
and a scene page. See §4.9, 1.3.0.

### 2026-10-10 (late night): Insights 2.1.0, Stash's numbers hidden

User screenshot: Insights sat between Stash's stat rows, and they asked to
hide them. Stash has three `.stats` rows; Insights now mounts after the last
and hides all three with a stylesheet, unless the new "Show Stash's own
numbers" setting is on. Checked in the harness both ways. See §4.14.

### 2026-10-10 (late night): Flexoki theme on every plugin

User asked for the Insights 2.0 theme on all the other plugins. The theme was
written down as `docs/THEME.md` and five agents restyled QuickTools, Lockdown,
Todo, IntifaceSync, and Collections with ScriptBadges in parallel, colours
only. Checked afterwards: no hex colour outside the palette in any plugin, the
IntifaceSync `.py` diff is the version line only, validate.sh passes. See
§4.15.

### 2026-10-10 (late night): Insights 2.0.0, redesign

User found 1.0 "boring, corporate" and too O-centred; asked for the library,
codecs, depth. Four rounds of mockups in chat: a mixed bold/console style, You
first, then warm palettes; user picked Flexoki and asked for depth, then for
exact values on graphs, flags, more icons and coloured active tabs. Built in
parts (helpers, data, styles, five tabs), 40 new unit checks (97 in all), and
a harness with 1500 scenes, studios with parents, counts and duplicates. Flags
come from Stash's own flag-icons stylesheet. See §4.14, 2.0.0.

### 2026-10-10 (night): Insights 1.0.0 (new plugin)

User asked for a stats plugin to replace O Stats and Stats Enhancer, after
learning their features. Both were read from the user's Stash and
inventoried by a subagent; design signed off in two mockups plus "in-depth
performer analysis, colours, good UX". Built in parts (calculations, data and
tracker, UI, tabs), tested with 57 unit checks and a harness with a seeded
library whose built-in biases (blonde, POV) the analysis found. See §4.14.

### 2026-10-10 (evening): QuickTools 1.10.0, wheel seek from VideoScrollWheel

User asked to fold VideoScrollWheel into QuickTools. Same velocity model and
settings (carried over from its config), with page scroll stopped, the right
half measured on the player, notches coalesced, and a readout. See §4.13.
Insights (stats plugin) design signed off in the same session; being built.

### 2026-10-10 (later): Todo 1.1.0, the same treatment as Lockdown

User asked to enhance Todo the way Lockdown was. Three mockups in chat:
the panel, clearer performers (header card, grouping), and a strict grid
for alignment; signed off with "if the task is related to that performer
show it" (a scene's page shows its performers' tasks). See §4.9.

### 2026-10-10: Lockdown 1.3.0, picking first, history editing, newcomer help

User asked for a specific-performer pick as the first option, a way to clear
or remove history, better guidance for newcomers, and to design it in chat
first. Two mockups were signed off (most locked replacing fastest, a
month-grouped full history). Built as designed; see §4.12.

### 2026-10-09 (evening): Lockdown 1.2.0, lifetime stats and history design

User asked how the stats scale and for a nicer history: a drop for an O, an
X for given up. Totals moved out of the capped list (they would have shrunk
past 200); history view redone with tiles, a 30-result strip and rows with
avatar, time and when. Tests run 250 lockdowns through the totals.

### 2026-10-09 (later): Lockdown 1.1.0, closing the cheats

User: tags and co-performers still led to other scenes. Root cause was the
redirect racing the router; also added card-level checks and stripping of
performer rules on their tabs. See §4.12.

### 2026-10-09: Lockdown 1.0.0 (new plugin)

User asked for a plugin that locks Stash to one performer until an O, with a
way out, and to be interviewed on the design. Built from the answers; see
§4.12. Harness-tested: spin of a saved filter and of favourites, manual lock,
every route rule, O ending it, roulette (bounce, random button, video end),
give up hold, history written with other config kept.

### 2026-10-08 (later): QuickTools 1.9.0, F for performer filters

User: F should also list performer saved filters on the Performers page.
Added PERFORMERS mode (Performers page, studio and tag Performers tabs) and
the remaining saved-criterion conversions; see §4.11.

### 2026-10-08: QuickTools 1.8.0, `F` saved filters

User asked for F to bring up saved scene filters on scene lists, with rename,
delete, and the Marked for Delete filter standing out, and said it must work
out of the box rather than for their library. Applying is the URL Stash
builds, verified against a real 0.31.1 instance; everything else is generic.
See §4.11.

### 2026-10-07: QuickTools 1.7.0, hide rating tags in the T panel

User: T on performers works; wanted a toggle to hide the Advanced Rating
★ tags. Hidden by default, chip to show; see §4.10.

### 2026-10-06 (night): QuickTools 1.6.0, T and D on hovered cards

User: tag performers from the performer library by hovering and pressing T,
same for D and scene tags on scene cards. Done through the existing keydown
router and mousemove tracker; see §4.10.

### 2026-10-06 (evening): Todo 1.0.0, QuickTools 1.5.0 (`T`)

User asked for a simple todo list plugin and quick tags with T for scenes and
performers. Todo stores in plugin config with operation replay (§4.9);
`T` writes with bulk ADD/REMOVE so other tags are never rewritten (§4.10).
Both run through a harness with a fake GraphQL; one bug found and fixed there
(Enter on a partial match created a tag).

### 2026-10-06 (later): QuickTools 1.4.0, rate then move on

User: after rating, going to the next video took three clicks, and they
wanted middle click as well as double-click. Both done through the existing
handlers (one pointerdown, one dblclick, plus the swallow guard), see §3.5b
and §4.2.

### 2026-10-06: IntifaceSync 1.33, dependency install

User's Stash log filled with red pip "externally-managed-environment"
errors after they edited the container template (Unraid help: Generate was
freezing the server; added `--cpus=6 --memory=6g`, found the official image
has no NVENC ffmpeg). The rebuild wiped the pip-installed packages, and the
reinstall printed Alpine's PEP 668 refusal before the retry worked. Now one
quiet `--target` install into the plugin folder that survives rebuilds.

### 2026-09-29 (later): IntifaceSync 1.32, buzz on seek and next video

User: "when I seek in the player it buzzes a bit", and the same when the next
video plays. Not a feature. Reproduced in the harness: auto manual was
restarting on video.js's pause-seek-play. Also fixed duplicate video listeners
and a script that stayed idle when the video was already playing. See §4.5.

### 2026-09-29: IntifaceSync 1.31, Stop Backend could kill Stash

User: after updating Intiface Central, "Backend unreachable", and Stop
Backend stopped the whole of Stash. Both were one bug: a stale lock file
naming Stash's PID after a container restart (see §4.5). Also checked the
backend still parses on Python 3.9-3.11 in case the container's Python was
older than the dev machine's; it does.

### 2026-09-24 (night): IntifaceSync 1.30

User: manual still did not come on for a scene without a script; wanted the
scene title instead of the file name, connection controls on the right as
icons, and the script button lit when a script is active. The manual report
matched an old backend still serving the pre-1.29 matcher, so 1.30 adds the
backend version check. Also: manual on script-less scenes waits for play.

### 2026-09-24 (evening): IntifaceSync 1.29

User reports: manual turned off when playing a new video in another tab and
the toy followed "a funscript" on a scene without one; picking other videos'
scripts made no sense; the tease build did not seem to work. Reproduced with
a new fake Intiface server (`fake_intiface.py`, one Gush 2) against the real
backend: the scriptless scene loaded another video's script. Manual never
turned off through takeover or scene changes in testing; the remaining causes
are the two safety stops, which now explain themselves. See §4.5 for strict
matching, `unloadScript`, manual on script-less scenes, and the tease start.

### 2026-09-24 (later): Collections 1.1.1

"Round ready" never appeared: the chip was drawn before Stash's player
existed and never redrawn (see §4.7 "The player appears late"). Added a
startup console line and `window.__Collections.status()` for support.

### 2026-09-24: Collections 1.1.0, ScriptBadges 1.1.0

User reports: the tab stayed gold on other pages (URL check matched the
default filter's exclusion, see §4.7), and scores could not be found (their
Stash predates scene custom fields; scores now fall back to the plugin
config). ScriptBadges no longer marks scenes without a script unless asked.

### 2026-09-23 (late night): ScriptBadges 1.0.0, Collections 1.0.1

New plugin, see §4.8. Collections' card badge moved to top-centre because
top-left sat on Stash's rating ribbon.

### 2026-09-23 (night): Collections 1.0.0, IntifaceSync 1.28

New plugin, see §4.7. Designed with the user in chat: tab per studio sorted
by O count, hidden from Scenes, round scores with Hardcore that silently
drops to Easy rather than a mode picker, Easy scored by continuous coverage
so skipping cannot inflate it. IntifaceSync 1.28 reads a collection's vibe
mode through `window.__Collections`.

### 2026-09-23 (evening): QuickTools 1.3.0 and IntifaceSync 1.27

QuickTools: fullscreen panels, Esc-after-failed-read guard, focus handed back
after the marker panel, marker undo, range markers, queue feedback, delete
overlay recheck, readable HTTP errors, and `scripts/test_quicktools.js` in
`validate.sh` (pure helpers plus the one-handler rule). §3 rewritten: it
still described five separate plugins. IntifaceSync 1.27: the script panel
became a dock under the player (see §4.5).

### 2026-09-23 (later still): IntifaceSync overhaul, four releases

User asked for all of: vibrator-track preference, better funscript-to-vibe
conversion, reliable multi-tab/multi-browser behaviour, and a clearer
settings section. Done as 1.23 (vibe tracks), 1.24 (rendered Flow mode),
1.25 (backend decides which tab drives), 1.26 (script panel, per-script
memory). Each has its own entry in §4.5.

### 2026-09-23 (later): presets and UX, IntifaceSync 1.21 → 1.22-vibe

User asked for saved manual presets that stay active across tabs and visits,
friendlier knobs, and mid-session a strength build for Tease. See §4.5
"Pattern presets", "Tease strength build", "Knob UI". Tests 40-41.

### 2026-09-23: catch-up on Auto mode and mark-for-delete

The last three commits (`b13a981` D mark-for-delete, `fefc5d0` overlay,
`a222a31` Fixes to Auto mode) went in without docs or tests, and Auto mode
without a version bump. This session caught up and fixed what turned up.

**Validation was red locally for two non-bugs.** PyYAML was not installed for
Python 3.14 (fixed with `pip install pyyaml`), and test 18 divided by an
assumed 2.0 s (see §4.5 Tests). Neither affected CI.

**IntifaceSync 1.20 → 1.21-vibe.**
- Graded beat detection, amplitude levels and thinning from `a222a31`
  documented (§4.5 Beat mode) and covered by tests 36-38.
- **Beat mode exceeded the BLE budget** at beat spacings under ~182 ms: two
  commands per beat, off edge unlimited. Measured 13.3 cmd/s at 150 ms. This
  predates `a222a31`, which made it easier to reach by thinning to 150.
  `BEAT_THIN_MIN_MS` and `BEAT_PEAK_MIN_SEP_MS` are both 190 now. Test 38
  sweeps it.
- `stop` routes through `_panic()` (rule 1). Test 39.
- `_beats_peak_picked` was not reset on an empty load, and the load log called
  a thinned non-beat script "dense".
- JS hotkeys ignore keys that arrive `defaultPrevented`.

**QuickTools 1.2.0 → 1.2.1.** Keyboard router moved from `document` to
`window` capture, so the rating panel's `0` no longer also turns off
IntifaceSync manual mode. Still exactly one keydown listener. §4.6 written for
`D`, which had no maintenance notes at all.

**Not done / next session:** everything in §6 marked untested. The "stop
everything" hotkey idea below is still open.

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

**IntifaceSync 1.19 → 1.20.** User reported the pattern popover showing at the
bottom of every page. See §4.5.

**IntifaceSync 1.18 → 1.19.** Two user-reported bugs. The Shortcuts button
rendered blank until first clicked: `updateHotkeyBtn()` ran before the button
was appended, and `byId()` searches the document and the toolbar only, so it
found nothing and set no text. Lifting a function out of a builder's scope
means losing its closure over the element; mount first, then update. Second,
nothing worked at all without a device attached; see §4.5.

**IntifaceSync 1.17 → 1.18.** Funscript wave, beat markers and a playhead on
the signal preview. See §4.5.

**IntifaceSync 1.16 → 1.17.** Toolbar redesign for public use, plus a
`disableHotkeys` plugin setting. See §4.5. Also added `plugins/IntifaceSync/README.md`,
which did not exist: the plugin was shipping to strangers with no user-facing
documentation at all.

**IntifaceSync 1.15 → 1.16.** Funscript dropdown replaced by a plain label;
picker demoted to the advanced row and only shown when there is a real choice.

**Not done / next session:** hardware and real-Stash verification of
1.22-1.26 (see §6), popovers in fullscreen;
live hardware verification of 1.10; verify the
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
