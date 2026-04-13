#!/usr/bin/env bash
# Commission a Bayes fit via the same payload construction as the FE.
#
# Usage:
#   bash graph-ops/scripts/bayes.sh <graph-name> [options]
#
# Examples:
#   bash graph-ops/scripts/bayes.sh my-graph
#   bash graph-ops/scripts/bayes.sh my-graph --submit
#   bash graph-ops/scripts/bayes.sh my-graph --preflight
#   bash graph-ops/scripts/bayes.sh my-graph --output payload.json
#
# Prerequisites:
#   - Python BE running for --preflight / --submit (default: localhost:9000)
#   - Data repo available (path resolved from .private-repos.conf)
#   - Node 18+ (via nvm)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

if [ $# -lt 1 ]; then
  echo "Usage: bash graph-ops/scripts/bayes.sh <graph-name> [options]"
  echo ""
  echo "Options:"
  echo "  --preflight              Dry-run against server (binding_receipt: gate)"
  echo "  --submit                 Full submit + poll until done"
  echo "  --output <path>          Write payload JSON to file"
  echo "  --format json|yaml       Output format (default: json)"
  echo "  --no-cache               Bypass disk bundle cache"
  echo "  --verbose, -v            Show all internal debug logging"
  echo ""
  echo "Environment:"
  echo "  PYTHON_API_URL           Python BE URL (default: http://localhost:9000)"
  exit 1
fi

GRAPH_NAME="$1"
shift

# Set up Node via nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

cd "$_DAGNET_ROOT/graph-editor"

if [ -f .nvmrc ]; then
  nvm use "$(cat .nvmrc)" 2>/dev/null || true
fi

npx tsx src/cli/bayes.ts \
  --graph "$DATA_REPO_PATH" \
  --name "$GRAPH_NAME" \
  "$@"
