#!/usr/bin/env bash
# Copy plugins into a running Stash instance and restart the IntifaceSync backend.
# Usage: ./scripts/deploy.sh [/path/to/stash/plugins]  or set STASH_PLUGINS.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-${STASH_PLUGINS:-}}"
if [ -z "$DEST" ]; then
  echo "Set STASH_PLUGINS or pass the plugin directory." >&2
  echo "Docker example: STASH_PLUGINS=/srv/stash/config/plugins ./scripts/deploy.sh" >&2
  exit 1
fi
./scripts/validate.sh || { echo "Refusing to deploy: validation failed." >&2; exit 1; }
for d in IntifaceSync QuickRate QuickMark QuickNav; do
  [ -d "plugins/$d" ] || continue
  mkdir -p "$DEST/$d"
  cp -v "plugins/$d"/*.js "plugins/$d"/*.yml "$DEST/$d/" 2>/dev/null || true
  cp -v "plugins/$d"/*.py "$DEST/$d/" 2>/dev/null || true
done
echo
echo "Deployed. Now in Stash: Settings > Plugins > Reload."
echo "IntifaceSync Python changed? Run its Stop Backend then Start Backend task."
