#!/usr/bin/env bash
# Print top hot functions from a cProfile .pstats dump.
#
# Usage:
#   bash graph-ops/scripts/read-pstats.sh <pstats-file> [n=30] [sort=cumulative]
#
# Sort keys: cumulative, tottime, calls, name (see pstats docs).
#
# If <pstats-file> is "latest", the most-recent file in /tmp/dagnet-profiles/
# is used.

set -euo pipefail

ARG="${1:-latest}"
N="${2:-30}"
SORT="${3:-cumulative}"

if [ "$ARG" = "latest" ]; then
  FILE=$(ls -t /tmp/dagnet-profiles/*.pstats 2>/dev/null | head -1 || true)
  if [ -z "$FILE" ]; then
    echo "no .pstats files in /tmp/dagnet-profiles/" >&2
    exit 1
  fi
else
  FILE="$ARG"
fi

DAGNET_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON="$DAGNET_ROOT/graph-editor/venv/bin/python"

echo "=== $FILE ==="
"$PYTHON" - "$FILE" "$N" "$SORT" <<'PY'
import sys, pstats
path, n, sort = sys.argv[1], int(sys.argv[2]), sys.argv[3]
s = pstats.Stats(path).strip_dirs().sort_stats(sort)
s.print_stats(n)
PY
