#!/usr/bin/env bash
# Every check that must pass before anything is considered done.
# Run from the repo root: ./scripts/validate.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
note() { printf '%s\n' "$*"; }

note "== JS syntax =="
for f in plugins/*/*.js; do
  if node --check "$f" >/dev/null 2>&1; then note "  ok   $f"
  else note "  FAIL $f"; node --check "$f"; fail=1; fi
done

note "== Python syntax =="
for f in plugins/*/*.py; do
  if python3 -m py_compile "$f" 2>/dev/null; then note "  ok   $f"
  else note "  FAIL $f"; python3 -m py_compile "$f"; fail=1; fi
done

note "== YAML manifests =="
for f in plugins/*/*.yml; do
  if python3 -c "import sys,yaml;d=yaml.safe_load(open(sys.argv[1]));assert d.get('name') and d.get('version'),'missing name/version'" "$f" 2>/dev/null
  then note "  ok   $f  v$(python3 -c "import sys,yaml;print(yaml.safe_load(open(sys.argv[1]))['version'])" "$f")"
  else note "  FAIL $f"; fail=1; fi
done

note "== Browser storage ban (Stash plugins must not use localStorage for device state) =="
# localStorage IS used deliberately for UI prefs and the tab lock; this only
# catches it creeping into the IntifaceSync safety path.
if grep -n "localStorage" plugins/IntifaceSync/IntifaceSync.js | grep -qi "manual\|panic\|deadman"; then
  note "  FAIL device state persisted to localStorage"; fail=1
else note "  ok"; fi

note "== IntifaceSync safety chain =="
for sym in "def panic" "async def _panic" "async def _watchdog" "DEADMAN_S"; do
  if grep -q "$sym" plugins/IntifaceSync/IntifaceSync.py; then note "  ok   $sym"
  else note "  FAIL missing $sym"; fail=1; fi
done
if grep -q 'await self._handle(ws, {"type": "pause"})' plugins/IntifaceSync/IntifaceSync.py; then
  note "  FAIL disconnect uses pause instead of _panic"; fail=1
fi
# 1.25: the driving tab leaving must panic even while other tabs stay open,
# and only the driver may feed the deadman.
if grep -q 'if was_driver or not self.clients:' plugins/IntifaceSync/IntifaceSync.py; then
  note "  ok   driver disconnect panics"
else note "  FAIL driver disconnect no longer panics"; fail=1; fi
if grep -q 'if ws is self._driver or self._driver is None:' plugins/IntifaceSync/IntifaceSync.py; then
  note "  ok   deadman follows the driver"
else note "  FAIL deadman no longer restricted to the driving tab"; fail=1; fi

note "== QuickTools tests =="
if node scripts/test_quicktools.js >/tmp/test_qt.out 2>&1; then
  note "  ok   $(grep -c '^  ok' /tmp/test_qt.out) checks passed"
else
  note "  FAIL"; grep -v '^  ok' /tmp/test_qt.out; fail=1
fi

note "== IntifaceSync test suite =="
if timeout 300 python3 plugins/IntifaceSync/test_vibe.py >/tmp/test_vibe.out 2>&1; then
  note "  ok   $(grep -c 'OK$' /tmp/test_vibe.out) checks passed"
else
  note "  FAIL"; tail -25 /tmp/test_vibe.out; fail=1
fi

note ""
if [ "$fail" -eq 0 ]; then note "ALL CHECKS PASSED"; else note "VALIDATION FAILED"; fi
exit "$fail"
