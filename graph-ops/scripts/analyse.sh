#!/usr/bin/env bash
# Run a graph analysis via the Python BE and return the result JSON.
#
# Usage:
#   bash graph-ops/scripts/analyse.sh <graph-name> <query-dsl> --type <analysis-type> [options]
#
# Examples:
#   bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" --type graph_overview
#   bash graph-ops/scripts/analyse.sh my-graph "cohort(1-Jan-26:1-Apr-26)" --type cohort_maturity
#
# Prerequisites:
#   - Python BE running (default: localhost:9000, override via PYTHON_API_URL)
#   - Data repo available (path resolved from .private-repos.conf)
#   - Node 18+ (via nvm)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

if [ $# -lt 2 ]; then
  echo "Usage: bash graph-ops/scripts/analyse.sh <graph-name> <query-dsl> --type <analysis-type> [options]"
  echo ""
  echo "Options:"
  echo "  --type <type>            Analysis type (graph_overview, cohort_maturity, etc.)"
  echo "  --get <key>              Extract a value via dot-path from the result"
  echo "  --format json|yaml       Output format (default: json)"
  echo "  --no-cache               Bypass disk bundle cache"
  echo "  --verbose, -v            Show all internal debug logging"
  echo ""
  echo "Environment:"
  echo "  PYTHON_API_URL           Python BE URL (default: http://localhost:9000)"
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

npx tsx src/cli/analyse.ts \
  --graph "$DATA_REPO_PATH" \
  --name "$GRAPH_NAME" \
  --query "$QUERY_DSL" \
  "$@"
