#!/usr/bin/env bash
#
# Conditioned forecast parity test (doc 47) — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_conditioned_forecast_parity.py and runs
# through the long-lived dagnet-cli daemon.
#
# Phases preserved:
#   Phase 1 — data health checks (graph, snapshot DB, CF returns edges)
#   Phase 2 — per-edge whole-graph p_mean vs v3 chart midpoint parity
#   Phase 3 — sibling PMF consistency (sum ≤ 1.0 per parent)
#   Phase 4 — historical asat visibility (synth-simple-abc only)
#
#   bash graph-ops/scripts/conditioned-forecast-parity-test.sh
#   bash graph-ops/scripts/conditioned-forecast-parity-test.sh Phase4
#   bash graph-ops/scripts/conditioned-forecast-parity-test.sh sibling
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_conditioned_forecast_parity.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
