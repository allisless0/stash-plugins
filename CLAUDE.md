# Stash plugins

Two Stash plugins. QuickTools is pure frontend JS; IntifaceSync also has a
Python backend that drives sex toys over Buttplug.io / Intiface Central.

**`docs/MAINTENANCE.md` is the real documentation.** Read the section for whatever
you are touching before you change it. It records why things are the way they
are, including several fixes that look removable and are not.

## Hard rules

1. **Never weaken the IntifaceSync safety chain.** A device left running is the
   worst failure this repo can produce. `pause()` may keep manual mode alive on
   purpose; disconnect, deadman timeout and shutdown must all route through
   `_panic()`. Any new "stop-ish" path calls `_panic()`, never `pause()`.
   See docs/MAINTENANCE.md §4.5.
2. **Validate before claiming done:** `./scripts/validate.sh`. It runs
   `node --check`, `py_compile`, YAML parsing, safety-chain greps, and the
   44-check IntifaceSync suite. A change is not finished until it passes.
3. **Bump the version in the plugin's `.yml`** for every functional change.
   Stash caches aggressively and an unchanged version makes debugging a guess.
4. **Add a test for every backend behaviour change.** `plugins/IntifaceSync/test_vibe.py`
   is fully stubbed, no hardware. Append, do not renumber.
5. **Never drop tags or user data on write.** The archived QuickCriteria
   shipped a bug where saving stripped level tags of hidden criteria. When a
   merge filters a list, the filtered-out items still have to ride through
   untouched. The plugin is gone; the rule is not.
6. **Update docs/MAINTENANCE.md in the same change**, including the session log in
   §6b and the open-issues table in §6. Future sessions only know what is
   written down.

## Layout

`plugins/` ships to users. `archive/` does not: nothing there is built,
validated or published. `docs/`, `scripts/`, `CLAUDE.md` and `SETUP.md` are
maintainer-only and are excluded from the published zips by `build_site.py`,
along with `test_vibe.py`.

Plugins live in `plugins/<Name>/`. Each is a folder with `<Name>.yml` (manifest), `<Name>.js` (UI), and for
IntifaceSync `IntifaceSync.py` (backend) and `test_vibe.py`.

## Commands

- `./scripts/validate.sh` — all checks
- `./scripts/deploy.sh` — validate, then copy into a Stash instance
  (`STASH_PLUGINS=/path/to/stash/config/plugins`)
- `python3 plugins/IntifaceSync/test_vibe.py` — backend suite alone
- `python3 build_site.py` — build the published index into `_site/` (CI does this)

After deploying: Stash > Settings > Plugins > Reload, then hard-refresh the
browser. If any `.py` changed, also run IntifaceSync's Stop Backend and Start
Backend tasks; reloading plugins does not restart the Python process.

## Environment quirks that will bite you

- **No browser storage for device state.** localStorage is used deliberately
  for UI preferences and the single-owner tab lock, and must not hold anything
  the toy's safety depends on.
- **BLE command budget is roughly 11/sec.** Lovense hardware chokes above it.
  Any new output mode has to be measured against this, not assumed.
- **Gush 2 has 20 scalar steps**, so the minimum non-zero output is 5%. Micro
  pulsing exists to get below that floor.
- **Stash is a SPA.** Toolbars get torn down on navigation; `watchNavigation()`
  and `retryInjectToolbar()` handle re-injection.
- **Stash's video player is video.js.** Capture-phase listeners are needed to
  stop it swallowing or acting on clicks.
- **QuickTools has exactly one of each global handler** — one keydown router,
  one pointerdown dismiss, one dblclick. That is the point of the merge. Adding
  a second listener for a new feature reintroduces the load-order bugs the
  merge removed; route it through the existing ones instead.

## Style

Plain comments that explain *why*, not what. No emoji in code. Keep the
existing formatting of each file; they are not uniform and that is fine.

## Publishing

Pushing to `main` runs `.github/workflows/deploy.yml`: validate, build the
index, publish to GitHub Pages. A failing `validate.sh` blocks the release, so
never weaken it to make CI pass. Users install from
`https://allisless0.github.io/stash-plugins/main/index.yml`.

A plugin folder's name, its `<Name>.yml` filename, and the manifest's `name:`
must all match, or `build_site.py` skips it.
