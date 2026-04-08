#!/usr/bin/env bash
# Doc 31 parity test — prove old path and new path produce identical results.
#
# Usage:
#   bash graph-ops/scripts/parity-test.sh <graph-name> <query-dsl> --subject <dsl> [options]
#
# The --subject flag is the analytics DSL (e.g. from(x).to(y)) — the subject
# part only, WITHOUT a window. The query-dsl carries the window separately.
# This mirrors how the browser sends them.
#
# Examples:
#   bash graph-ops/scripts/parity-test.sh my-graph "window(-90d:)" \
#     --subject "from(landing).to(signup)"
#
#   bash graph-ops/scripts/parity-test.sh my-graph "cohort(-90d:)" \
#     --subject "from(a).to(b)" --type daily_conversions
#
# Prerequisites:
#   - Python BE running (default: localhost:9000, override via PYTHON_API_URL)
#   - Data repo available (path resolved from .private-repos.conf)
#   - Node 22+ (via nvm)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

if [ $# -lt 2 ]; then
  echo "Usage: bash graph-ops/scripts/parity-test.sh <graph-name> <query-dsl> [options]"
  echo ""
  echo "Options:"
  echo "  --type <type>     Single analysis type to test (default: all snapshot types)"
  echo "  --subject <dsl>   Separate subject DSL (e.g. from(x).to(y))"
  echo "  --verbose, -v     Show detailed output"
  echo ""
  echo "Environment:"
  echo "  PYTHON_API_URL    Python BE URL (default: http://localhost:9000)"
  exit 1
fi

GRAPH_NAME="$1"
QUERY_DSL="$2"
shift 2

# Set up Node via nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

cd "$_DAGNET_ROOT/graph-editor"

if [ -f .nvmrc ]; then
  nvm use "$(cat .nvmrc)" 2>/dev/null || true
fi

npx tsx src/cli/parity-test.ts \
  --graph "$DATA_REPO_PATH" \
  --name "$GRAPH_NAME" \
  --query "$QUERY_DSL" \
  "$@"
