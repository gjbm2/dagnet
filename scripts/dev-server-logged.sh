#!/usr/bin/env bash
# dev-server-logged.sh — Run the Python dev server with stdout/stderr
# tee'd to debug/tmp.python-server.jsonl (JSONL format).
#
# Usage:  scripts/dev-server-logged.sh
#
# This is the recommended way to start the Python dev server during
# local development so that agents can read Python logs via
# extract-mark-logs.sh.  The server process is completely unmodified;
# this script captures its output externally.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRAPH_EDITOR="$REPO_ROOT/graph-editor"
DEBUG_DIR="$REPO_ROOT/debug"
PYTHON_LOG="$DEBUG_DIR/tmp.python-server.jsonl"

mkdir -p "$DEBUG_DIR"

# Activate the repo venv
# shellcheck disable=SC1091
. "$GRAPH_EDITOR/venv/bin/activate"

# jsonl_tee: read lines from stdin, write each as a JSONL entry to the
# log file, and also pass through to the given fd (1=stdout, 2=stderr).
jsonl_tee() {
  local level="$1"
  while IFS= read -r line; do
    printf '%s\n' "$line" >&3
    stripped="${line#"${line%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    [ -z "$stripped" ] && continue
    ts_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
    # Escape the message for JSON (backslashes, quotes, control chars)
    escaped=$(printf '%s' "$stripped" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()),end="")')
    printf '{"kind":"py","ts_ms":%s,"level":"%s","message":%s}\n' "$ts_ms" "$level" "$escaped" >> "$PYTHON_LOG"
  done
}

echo "Starting Python dev server with log tee → $PYTHON_LOG"

# Run the dev server.  Merge stdout and stderr so we get everything,
# and tee each line to both the terminal and the JSONL file.
exec 3>&1
cd "$GRAPH_EDITOR" && python dev-server.py 2>&1 | jsonl_tee "stdout"
