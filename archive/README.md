# Archive

Not published. `build_site.py` only scans `plugins/`, and `validate.sh` only
checks `plugins/`, so nothing here is built, tested or shipped.

- **QuickCriteria 2.3.0** — companion for the Advanced Rating plugin, scores
  every criterion on a performer page. Dropped because it went unused. It
  worked at the time it was archived; the v2.3.0 fixes (hidden-criterion tags
  were being stripped on save, config loading before tag discovery) are in.
  See `docs/MAINTENANCE.md` §4.4 for how it works if it ever comes back.

- **QuickRate 1.3.0, QuickMark 1.1.0, QuickNav 1.1.0** — superseded by
  **QuickTools 1.0.0**, which merges all three. Kept only for reference while
  QuickTools proves itself on real installs; delete them once it has.

Delete this folder if you want it gone for good. Once the first commit is
pushed it also lives in git history, so removing it later is not destructive.
