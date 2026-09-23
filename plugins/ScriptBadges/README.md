# ScriptBadges

A small badge, bottom left, on every scene card that has a funscript:
**Script · 250**. The number is Stash's measure of how busy the script is, the
same number Stash shows on its own for interactive scenes.

Scenes without a funscript get no badge, so the ones without one are the ones
that need work. Turn on **Also mark scenes without a funscript** in the plugin
settings if you want those to say **No script** as well.

## How it knows

It uses Stash's own "interactive" flag, the same thing the Scenes page's
**Interactive** filter and Stash's Handy support go by. Two things follow:

- **Exact name.** Stash only counts a funscript named exactly like the video,
  next to it: `Scene.mp4` needs `Scene.funscript`. IntifaceSync is more
  forgiving and may play a script this badge says is missing; renaming the
  script to match the video fixes both.
- **Found at scan time.** After adding a funscript, rescan that folder
  (Settings › Tasks › Scan) and the badge updates.

To list everything that still needs a script, filter the Scenes page by
**Interactive: false**.

Debug logging: `localStorage.scriptBadgesDebug = "1"` in the browser console.
