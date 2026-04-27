#!/usr/bin/env bash
#
# CF truth-parity test (doc 50) — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_cf_truth_parity.py and runs through the
# long-lived dagnet-cli daemon. This shim preserves the historical
# invocation surface (argv passes through to pytest's -k filter).
#
#   bash graph-ops/scripts/cf-truth-parity.sh
#   bash graph-ops/scripts/cf-truth-parity.sh synth-simple-abc
#   NON_LATENCY_TOL=0.03 bash graph-ops/scripts/cf-truth-parity.sh
#   LAGGY_BOUND=0.10 bash graph-ops/scripts/cf-truth-parity.sh
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_cf_truth_parity.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
