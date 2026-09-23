# Collections

Give a studio its own tab in Stash's top bar, and keep its scenes out of the
main Scenes list. Built for Cock Hero videos, with optional round scores, but
any studio works.

Out of the box it sets up one collection: **Cock Hero**, with scores, hidden
from the main list, and IntifaceSync starting in Beat mode.

## The tab

Opens the Scenes list filtered to the studio and everything under it (so
"Cock Hero Colors" under "Cock Hero" is included), sorted by **O count**,
highest first. It is Stash's own list: grid, sort, "Play random" and the scene
queue all work as usual.

## Hidden from the main Scenes list

The plugin adds "studio is not *Cock Hero*" to your Scenes page **default
filter**. Anything already in your default filter is kept. Things to know:

- It is a default, not a lock. Clearing the filter on the Scenes page shows
  them again for that visit.
- Performer and tag pages, search, and front-page rows still show them.
- It changes a setting in your Stash, and the first time you may need to
  reload the page before the Scenes list picks it up.
- Remove `hide` from a collection (by adding `show`) and the plugin takes back
  exactly the exclusion it added, nothing else.

## Round scores (Cock Hero)

A round is one go at a video. Your score is **how far you got before pressing
O**. Watch to the end without pressing it and the round is **Cleared**.

A small indicator sits in the top-left corner of the player:

| Shows | Meaning |
|---|---|
| **● Hardcore · 04:12** | played from 0:00 with no seeking and normal speed; pausing is fine |
| **● Easy · 04:12** | something forgiving happened: a seek, a speed change, a reload |
| **Lost at 14:32** | the round is over and recorded; click to go again |

A round starts **Hardcore** when you press play near the start, and drops to
**Easy** the moment you seek or change speed. It only ever goes that way.
Hover the indicator to see why it dropped.

**Easy scores honestly.** The score is how far you have played continuously
from the start. Pauses and going back cost nothing. Skipping ahead leaves a gap
the score cannot cross until you go back and play it, so testing something
at 20:00 does not inflate anything. Easy progress survives a reload.

**Records are kept separately** for Hardcore and Easy: the best time and the
number of clears, stored on the scene itself as custom fields
(`round_best_hardcore`, `round_best_easy`, `round_clears_hardcore`,
`round_clears_easy`). A Hardcore result also counts toward Easy, because it
would have passed Easy's rules too.

- **Timeline:** a gold line marks your Hardcore best; a fainter blue one your
  Easy best when it is further.
- **Scene cards:** a small label, e.g. `HC 14:32 52% · Easy 18:10` or
  `Cleared ×2`.
- **Restart:** click the indicator (twice while a round is running, so a stray
  click does not throw a round away). It jumps to 0:00 and starts a fresh
  Hardcore round.

Pressing O on a scene with no round running just counts an O, as Stash always
does. Taking an O back from its dropdown never touches a score.

Scores need a Stash version with scene custom fields. On older versions the
tab and hiding still work and the plugin logs why scores are off.

## Settings

One text field, **Collections**, one collection per `;`:

```
Tab name = Studio name, options
```

| Option | |
|---|---|
| `score` | round scores for this collection |
| `show` | also keep its scenes in the main Scenes list |
| `mode:beat` | IntifaceSync starts scripts in this collection in this vibe mode (`auto`, `flow`, `beat`, `speed`, `position`) |
| `sort:date` | sort the tab by something other than O count |

Blank means `Cock Hero = Cock Hero, score, mode:beat`. Examples:

```
Cock Hero = Cock Hero, score, mode:beat; PMVs = PMV Heaven, show
```

Reload the page after changing it.

## With IntifaceSync

With `mode:beat`, a Cock Hero script you have never tuned starts in Beat
mode. Tuning it in IntifaceSync's script settings is remembered for that
script and wins from then on. Your global IntifaceSync defaults are not
changed.

Debug logging: `localStorage.collectionsDebug = "1"` in the browser console.
