#!/bin/bash
# Pre-commit validation hook for dagnet graph files.
#
# Runs validate-graph-deep.py on any graph JSON files staged for commit
# in the data repo. Blocks commit if errors found.
#
# Triggered by: PreToolUse on Bash commands containing "git commit"
# Location: dagnet/.claude/hooks/ (repo root)
set -e

# ── Read command from JSON input (same pattern as gate-check.sh) ──
INPUT=$(cat)

if command -v python3 >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except:
    print('')
" 2>/dev/null || echo "")
else
  COMMAND=$(echo "$INPUT" | grep -oP '"command"\s*:\s*"\K[^"]+' 2>/dev/null || echo "")
fi

# Only trigger on git commit commands
if ! echo "$COMMAND" | grep -q "git commit"; then
  exit 0
fi

# Resolve data repo path from config
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONF="$REPO_ROOT/.private-repos.conf"
if [ ! -f "$CONF" ]; then
  exit 0
fi
. "$CONF"
DATA_DIR="$REPO_ROOT/$DATA_REPO_DIR"

if [ ! -d "$DATA_DIR" ]; then
  exit 0
fi

# Check for staged graph files in the data repo
STAGED_GRAPHS=$(cd "$DATA_DIR" && git diff --cached --name-only 2>/dev/null | grep '^graphs/.*\.json$' || true)

if [ -z "$STAGED_GRAPHS" ]; then
  exit 0
fi

# Activate venv if available
VENV="$REPO_ROOT/graph-editor/venv/bin/activate"
if [ -f "$VENV" ]; then
  . "$VENV"
fi

# Run validator on each staged graph
VALIDATOR="$DATA_DIR/graph-ops/scripts/validate-graph-deep.py"
if [ ! -f "$VALIDATOR" ]; then
  echo "Warning: validate-graph-deep.py not found — skipping graph validation"
  exit 0
fi

FAILED=0
cd "$DATA_DIR"

for GRAPH in $STAGED_GRAPHS; do
  if [ ! -f "$GRAPH" ]; then
    continue
  fi

  echo "Validating $GRAPH..."

  if ! python3 "$VALIDATOR" "$GRAPH" --section A,B,D,E,F,G 2>&1; then
    FAILED=1
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Graph validation FAILED — commit blocked."
  echo "Fix the errors above, then retry the commit."
  exit 2
fi

exit 0
