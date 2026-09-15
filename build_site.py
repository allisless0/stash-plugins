#!/usr/bin/env python3
"""Build the Stash plugin source index and per-plugin zips.

Output goes to _site/main/ and is published to GitHub Pages by the workflow in
.github/workflows/deploy.yml. The index schema is the one Stash documents and
the one stashapp/CommunityScripts uses, so any Stash instance can add this
source the same way it adds the official one.
"""
import hashlib
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT    = Path(__file__).parent
PLUGINS = ROOT / "plugins"
OUT     = ROOT / "_site" / "main"
# Everything inside a plugin folder except maintainer-only files.
SKIP    = {"test_vibe.py", "__pycache__"}


def git_date(path: Path) -> str:
    """Date of the last commit touching this plugin, for the index."""
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cd", "--date=format:%Y-%m-%d %H:%M:%S", "--", str(path)],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        stamp = out.stdout.strip()
        if stamp:
            return stamp
    except Exception:
        pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def files_for(plugin_dir: Path):
    for f in sorted(plugin_dir.rglob("*")):
        if not f.is_file():
            continue
        if any(part in SKIP for part in f.relative_to(plugin_dir).parts):
            continue
        if f.suffix in {".pyc", ".log"}:
            continue
        yield f


def main() -> int:
    if not PLUGINS.is_dir():
        print("no plugins/ directory", file=sys.stderr)
        return 1
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    index = []
    for plugin_dir in sorted(p for p in PLUGINS.iterdir() if p.is_dir()):
        pid      = plugin_dir.name
        manifest = plugin_dir / f"{pid}.yml"
        if not manifest.exists():
            print(f"skip {pid}: no {pid}.yml (manifest name must match the folder)")
            continue
        meta = yaml.safe_load(manifest.read_text())
        if not meta or not meta.get("name") or not meta.get("version"):
            print(f"skip {pid}: manifest needs name and version", file=sys.stderr)
            return 1

        zip_path = OUT / f"{pid}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in files_for(plugin_dir):
                z.write(f, Path(pid) / f.relative_to(plugin_dir))

        sha = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        entry = {
            "id":      pid,
            "name":    meta["name"],
            "version": str(meta["version"]),
            "date":    git_date(plugin_dir),
            "path":    f"{pid}.zip",
            "sha256":  sha,
        }
        if meta.get("description"):
            entry["metadata"] = {"description": meta["description"]}
        index.append(entry)
        print(f"packed {pid} v{meta['version']}  {zip_path.stat().st_size:>7} bytes")

    if not index:
        print("nothing to publish", file=sys.stderr)
        return 1

    (OUT / "index.yml").write_text(
        yaml.safe_dump(index, sort_keys=False, allow_unicode=True, default_flow_style=False)
    )
    # A landing page so the Pages root is not a 404.
    readme = ROOT / "README.md"
    (ROOT / "_site" / "index.html").write_text(
        "<!doctype html><meta charset=utf-8>"
        "<title>Stash plugin source</title>"
        "<style>body{font:16px/1.5 system-ui;max-width:40em;margin:4em auto;padding:0 1em}"
        "code{background:#eee;padding:2px 5px;border-radius:3px}</style>"
        "<h1>Stash plugin source</h1>"
        "<p>Add this URL under <em>Settings &rsaquo; Plugins &rsaquo; Add Source</em>:</p>"
        "<p><code>main/index.yml</code> relative to this page.</p>"
        f"<p>{len(index)} plugin(s) published.</p>"
    )
    print(f"\nwrote {OUT/'index.yml'} with {len(index)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
