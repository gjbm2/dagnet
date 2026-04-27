#!/usr/bin/env bash
#
# Chart-graph agreement test (doc 29f §Phase G) — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_chart_graph_agreement.py and runs through
# the long-lived dagnet-cli daemon. This shim preserves the historical
# invocation surface.
#
#   bash graph-ops/scripts/chart-graph-agreement-test.sh
#   bash graph-ops/scripts/chart-graph-agreement-test.sh full-range
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_chart_graph_agreement.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
