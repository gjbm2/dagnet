#!/usr/bin/env bash
# Produce a param pack for a graph from cached snapshot data.
#
# Usage:
#   bash graph-ops/scripts/param-pack.sh <graph-name> <query-dsl> [--format yaml|json|csv] [--allow-external-fetch]
#
# Examples:
#   bash graph-ops/scripts/param-pack.sh my-graph "window(1-Dec-25:20-Dec-25)"
#   bash graph-ops/scripts/param-pack.sh my-graph "context(channel:google).window(-30d:)" --format json
#
# Prerequisites:
#   - Python BE running (default: localhost:9000, override via PYTHON_API_URL)
#   - Data repo available (path resolved from .private-repos.conf)
#   - Node 18+ (via nvm, resolved from graph-editor/.nvmrc)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

if [ $# -lt 2 ]; then
  echo "Usage: bash graph-ops/scripts/param-pack.sh <graph-name> <query-dsl> [options]"
  echo ""
  echo "Options:"
  echo "  --format yaml|json|csv   Output format (default: yaml)"
  echo "  --allow-external-fetch   Enable external source fetching (default: cache-only)"
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

# Run the CLI entry point via tsx
npx tsx src/cli/param-pack.ts \
  --graph "$DATA_REPO_PATH" \
  --name "$GRAPH_NAME" \
  --query "$QUERY_DSL" \
  "$@"
