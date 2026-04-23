#!/usr/bin/env bash
#
# Hydrate a graph: run FE aggregation + promotion + BE topo pass,
# write the populated graph back to disk.
#
# Produces a graph JSON equivalent to what the FE would have after
# opening the graph and running the full Stage 2 topo pass. Required
# for parity testing against synth graphs.
#
# Usage:
#   bash graph-ops/scripts/hydrate.sh <graph-name> <query-dsl> [options]
#
# Example:
#   bash graph-ops/scripts/hydrate.sh synth-mirror-4step "window(-90d:)"
#   bash graph-ops/scripts/hydrate.sh synth-simple-abc "window(-90d:)" \
#     --bayes-vars bayes/fixtures/synth-simple-abc.bayes-vars.json
#
# Options are forwarded to the CLI. See `npx tsx src/cli/hydrate.ts --help`.
# Notable options:
#   --bayes-vars <path>    Inject Bayesian posteriors before hydration
#   --force-vars           With --bayes-vars, bypass rhat/ess quality gates
#
# Requires Python BE running on localhost:9000.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAGNET_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SCRIPT_DIR/_load-conf.sh"

GRAPH_NAME="${1:?Usage: hydrate.sh <graph-name> <query-dsl>}"
QUERY_DSL="${2:?Usage: hydrate.sh <graph-name> <query-dsl>}"
shift 2

# Resolve nvm + node
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$DAGNET_ROOT/graph-editor"
nvm use "$(cat .nvmrc)" >/dev/null 2>&1 || true

# Resolve data repo path
DATA_REPO_PATH="$DAGNET_ROOT/$DATA_REPO_DIR"

# Run the CLI entry point via tsx
npx tsx src/cli/hydrate.ts \
  --graph "$DATA_REPO_PATH" \
  --name "$GRAPH_NAME" \
  --query "$QUERY_DSL" \
  "$@"
