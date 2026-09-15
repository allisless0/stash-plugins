# Maintainer setup

## Repo

Public repo at `github.com/allisless0/stash-plugins`.

```bash
cd stash-plugins
git init -b main
git add .
git commit -m "Initial import: IntifaceSync 1.16-vibe, QuickRate 1.3.0, QuickMark 1.1.0, QuickNav 1.1.0"
git remote add origin git@github.com:allisless0/stash-plugins.git
git push -u origin main
```

Set the identity **before the first commit** if you do not want your usual name
and address on these:

```bash
git config user.name  "allisless0"
git config user.email "allisless0@users.noreply.github.com"
```

The email matters more than the name. Without it, commits carry whatever global
email you have configured, which may link back to another identity.

## Enable Pages

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
