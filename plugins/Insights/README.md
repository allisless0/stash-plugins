# Insights

A stats dashboard on Stash's **Stats** page, in place of Stash's own numbers.
Six tabs, each with its own colour; every bar shows its exact value, and every
bar, day, row and tile leads into Stash.

## You

This week and today, your streak and best streak, your record day, and watch
time per O. A year calendar with each month's total (click a day to open it),
O's or watch time by week, month or year, when you O by weekday and hour with
totals, a day's timeline, and your rhythm (longest break, how often).

**What works for you:** for each trait, how your O's (or your watching)
compare with how much of the library has it. **1.5x** means it gets you there
half again as often as its share of the library would suggest. Pick a trait
in the list on the left; each value gets a bar centred on 1x (right and green:
more than its share, left and coral: less). Values are ranked by strength,
which weighs the lift by how many scenes back it, and the three strongest are
highlighted. Traits with a natural order (height, age, length, resolution...)
stay in that order. Groups too small to judge are hidden; show them below. Performer
traits (nationality with flags, ethnicity, hair, eyes, height, weight, cup
size, natural or enhanced, tattoos, piercings, age and career stage in the
scene, favourites, performer tags) and scene traits (tags, studios, cast,
length, resolution, release era, interactive). **Your strongest pulls** sums
up the clearest ones.

Also: your performers (by O's, per scene, time watched, favourites gone
quiet), your scenes (most O's, most played, not revisited), and your queue:
never watched, started, watched but not rated, played three or more times
without an O, rated four stars and up without an O, not organized.

## Actions

Everything that asks for something to be done, in one place.

- **Duplicate cleaner.** Finds exact copies with Stash's phash match and picks
  the copy to keep in each group: **HEVC or AV1** (the default), **best
  quality** or **smallest**. In HEVC mode a group is left for you to look at
  (nothing ticked) when it has no HEVC/AV1 copy, or when another copy is
  sharper than the HEVC/AV1 one. Untick or tick any copy yourself.
  - **Tag for delete** puts QuickTools' delete tag on the ticked copies. Safe;
    nothing is removed.
  - **Remove** (asks twice) works group by group: it first merges the copies
    into the kept scene with Stash's own merge, so their O's, plays, markers,
    tags, performers, galleries, groups, links and StashDB ids move over, and
    then deletes the copies' files from disk. A group that changed since the
    scan is skipped. Turn the merge off to delete the copies outright.
- **Not HEVC or AV1 yet:** biggest gain first, with what re-encoding would
  save. Tag them "Re-encode" (top 100 or all) for a tool like Tdarr or
  Unmanic, or open them all in Stash.
- **Worth upgrading:** below 720p or a legacy codec, most watched first.
- **Space hogs:** files far over the usual bitrate for their resolution.
- **Fix next:** the metadata gaps that would lift your grade most, files
  without a phash (one button generates them, for just those scenes), and
  things that look wrong (scenes with no file, dates before a performer turned
  18, performers who share a name, future dates, tags used once, performers
  and studios with no scenes).

## Library

Scenes, hours (and how long that is nonstop), size on disk and where it goes
by resolution. Performers, studios, tags, galleries and groups. The records:
longest, shortest, biggest file, oldest release, newest addition, biggest
cast, most played, most tagged, the performer with the most scenes and the
busiest studio. Scenes by release year or by the year they were added (click a
year for its months, a month for its scenes), lengths, ratings with O's per
scene, cast sizes, and how much is played, organized, rated, marked up.

## Files and quality

A console-style read of your files: video and audio codec, container,
resolution, frame rate and shape (landscape, portrait, VR). Bitrate spread per
resolution, what an hour of video costs in each codec, and where the space
goes: a ranked list by studio, network, codec or resolution.

## Metadata health

A grade for how complete your metadata is, the quickest ways to raise it, and
completeness for scenes, performers and studios. Each row opens the items
missing it. Things that look wrong rather than missing are on the Actions
tab.

## Collection

The library's growth month by month, top tags and what goes with each, studio
networks and the largest independents, who is in it by gender and country
(with flags), the performers who share the most scenes, ages on the scene
date, and new faces per year.

## Watch time

Counted while a scene's own player is playing, not hover previews or the wall,
and saved into Stash once a minute, so it is the same on every device. If you
used **O Stats**, Insights finds its watch history and offers to import it.

## Good to know

- O's without a date (older Stash versions, imports) count in totals and
  per-scene figures; day charts say how many they could not place.
- The library is read once and kept for 30 minutes; **Refresh** reads it again.
  Missing-field counts come from Stash's own filters, so a number always
  matches the list it opens.
- Stash's own rows of numbers on the Stats page are hidden, since Insights
  shows all of them. To keep them, turn on **Show Stash's own numbers** in
  Settings > Plugins > Insights.
- Everything is computed in your browser; nothing is sent anywhere. Insights
  only changes your library from the Actions tab, when you press a button.
- Replaces **O Stats** and **Stats Enhancer**: disable both once Insights is
  installed (import O Stats' watch history first).
