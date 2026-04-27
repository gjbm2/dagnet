#!/usr/bin/env bash
#
# cohort_maturity no-evidence degeneration contract test — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_cohort_maturity_no_evidence.py and runs
# through the long-lived dagnet-cli daemon.
#
#   bash graph-ops/scripts/cohort-maturity-no-evidence-test.sh
#   bash graph-ops/scripts/cohort-maturity-no-evidence-test.sh window_single_hop
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_cohort_maturity_no_evidence.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
