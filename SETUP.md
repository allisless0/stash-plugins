# Maintainer setup

## Repo

Public repo at `github.com/allisless0/stash-plugins`.

The repo is already live. Day-to-day:

```bash
git add -A
git commit -m "your message"
git push
```

Pushing to `main` triggers validate, build and publish. A failing
`validate.sh` blocks the release, so nothing broken reaches users.

## Pages

GitHub > repo **Settings > Pages** > Build and deployment > Source:
**GitHub Actions**. Then push once. The workflow validates, builds and
publishes.

Source URL for users:
`https://allisless0.github.io/stash-plugins/main/index.yml`

Announce it on the Stash community forum and add it to their third-party source
list.

## Claude Code

```bash
cd stash-plugins
claude
```

In place already:

- **`CLAUDE.md`** — rules and environment quirks, loaded every session. Short on
  purpose; long instruction files get followed less consistently.
- **`docs/MAINTENANCE.md`** — the deep reference, pointed at rather than
  duplicated so it stays out of context until needed.
- **`.claude/settings.json`** — `PostToolUse` hook running
  `scripts/syntax-check.sh` after every Edit or Write. Exit code 2 feeds errors
  straight back.
- **`scripts/validate.sh`** — the real gate. Also runs in CI, so a broken
  change cannot reach users.

## Local deploy

```bash
export STASH_PLUGINS=/path/to/stash/config/plugins   # put this in your shell rc
./scripts/deploy.sh
```

Then Stash > Settings > Plugins > Reload, and hard-refresh the browser.
**If any `.py` changed, also run IntifaceSync's Stop Backend then Start
Backend.** Reloading plugins does not restart the Python process, and this is
the most common reason a backend change appears to do nothing.

For faster iteration, symlink instead of copying:

```bash
ln -s "$PWD/plugins/IntifaceSync" /path/to/stash/config/plugins/IntifaceSync
```

## Releasing

Bump the version in the plugin's `.yml`, commit, push to `main`. That is the
whole release process. Stash compares the version in the index against what the
user has installed, so an unchanged version means nobody gets the update.

## Habits that matter here

**Commit before touching the safety chain.** `git revert` is the fastest way
back from a device that will not stop.

**Test on hardware you can see.** Toy on the table, not on you, until a change
has been through a full play / pause / close-the-browser cycle.

**Keep `docs/MAINTENANCE.md` §6b current.** It is the only thing carrying
context between sessions.

**You are shipping to strangers now.** A bug that leaves someone else's device
running is worse than one that leaves yours running. Treat `validate.sh` as a
floor, not a ceiling.
