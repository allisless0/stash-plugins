# QuickCriteria

Keyboard companion for the [Advanced Rating](https://discourse.stashapp.cc/t/advanced-rating/7607)
plugin. Press **R** on a performer page to score every criterion in one pass,
with evidence from that performer's scene ratings.

It only reads and writes rating tags. It never writes `rating100` itself and
never touches scenes.

## Requires

Advanced Rating installed, with the performer criteria set up and saved at least
once so the tags exist.

## Install

```bash
docker cp QuickCriteria Stash:/root/.stash/plugins/
```

Settings → Plugins → **Reload Plugins**, then hard-reload the browser tab.

## Use

Mouse works too: click a star to set that score, click the same star again to
unrate, or use the × at the end of the row. Criteria are grouped under the same
headers Advanced Rating uses, when that config can be read.

| Key | Action |
|---|---|
| `R` | Open, and press again to save |
| `0`-`5` | Score the highlighted criterion and move to the next |
| `↑` `↓` | Move without scoring |
| `Backspace` | Unrate the highlighted criterion |
| `Enter` | Save |
| `Esc` | Cancel |

With five criteria a full pass is seven keystrokes: `R 4 5 3 4 2 Enter`.

A `•` marks criteria you changed but have not saved.

## Evidence panel

The footer shows how much your score is actually grounded in:

- How many of the performer's scenes you have rated, and the percentage
- The mean of those scene ratings, on the same 0–10 scale
- A warning when fewer than three scenes are rated
- A warning when your criteria average diverges from the scene average by more
  than 1.5 points

That last one is the useful part. If you score a performer 9/10 but their scenes
average 6.2, one of those two numbers is wrong, and it is worth knowing which.

The criteria mean shown is **unweighted**. Advanced Rating applies your group and
criterion weights when it recalculates, so the final `rating100` will differ.
The number here is for spotting divergence, not for predicting the stored score.

## Grouping

Group names, order and which criteria are enabled come from Advanced Rating's
own configuration, read best-effort. The key names there are not a stable
contract, so the parser accepts several shapes (arrays, JSON strings, object
maps) and falls back to a flat, tag-ordered list when it cannot make sense of
what it finds. Rating still works either way.

## How it finds your criteria

It reads the tag tree, not Advanced Rating's configuration:

```
Advanced Performer Rating
 └─ Face ★
     ├─ Face ★: 0
     └─ … Face ★: 5
```

Any criterion you add, rename or remove in Advanced Rating is picked up on the
next open with no configuration here. If you renamed the parent tag, set the new
name in Settings → Plugins → QuickCriteria. Failing that, it falls back to
finding any tag whose children look like criteria.

## Saving

All criteria are written in a single `performerUpdate`, which fires Advanced
Rating's `Performer.Update.Post` hook exactly once. The hook recalculates
`rating100` using your weights.

Tags unrelated to rating are carried through untouched, so nothing gets dropped.

Clicking outside cancels. Nothing is written unless you press `R` or `Enter`.

## Notes

- `R` is also QuickRate's hotkey, but QuickRate only binds on `/scenes/<id>` and
  this only binds on `/performers/<id>`, so they never collide.
- Advanced Rating also has a Scenes half. If you ever enable it, its hook will
  overwrite scene ratings set by QuickRate. Keep Advanced Rating on performers
  only.

## Debug

```js
localStorage.setItem("quickCriteriaDebug", "1");
```
