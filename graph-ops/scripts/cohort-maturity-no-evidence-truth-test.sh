#!/usr/bin/env bash
#
# cohort_maturity zero-evidence truth-degeneracy canary — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_cohort_maturity_no_evidence_truth.py and
# runs through the long-lived dagnet-cli daemon.
#
#   bash graph-ops/scripts/cohort-maturity-no-evidence-truth-test.sh
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

exec python -m pytest lib/tests/test_cohort_maturity_no_evidence_truth.py --tb=short -v
