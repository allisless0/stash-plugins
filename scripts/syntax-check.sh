#!/usr/bin/env bash
# Fast syntax-only gate for the PostToolUse hook. The full suite is too slow to
# run on every edit; ./scripts/validate.sh is the real gate before finishing.
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0
out=""
for f in plugins/*/*.js; do
  msg=$(node --check "$f" 2>&1) || out+="$f: $msg"$'\n'
done
for f in plugins/*/*.py; do
  msg=$(python3 -m py_compile "$f" 2>&1) || out+="$f: $msg"$'\n'
done
for f in plugins/*/*.yml; do
  msg=$(python3 -c "import sys,yaml;yaml.safe_load(open(sys.argv[1]))" "$f" 2>&1) || out+="$f: $msg"$'\n'
done
if [ -n "$out" ]; then
  echo "Syntax errors introduced:" >&2
  echo "$out" >&2
  exit 2
fi
exit 0
