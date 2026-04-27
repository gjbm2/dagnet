#!/usr/bin/env bash
#
# cohort_maturity main-midline == promoted-overlay contract test — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_cohort_maturity_model_parity.py and runs
# through the long-lived dagnet-cli daemon.
#
#   bash graph-ops/scripts/cohort-maturity-model-parity-test.sh
#   bash graph-ops/scripts/cohort-maturity-model-parity-test.sh cohort_single_hop_widened
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_cohort_maturity_model_parity.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
