#!/usr/bin/env bash
#
# v2-vs-v3 cohort_maturity parity test — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_v2_v3_parity_outside_in.py and runs
# through the long-lived dagnet-cli daemon.
#
# (Distinct from graph-editor/lib/tests/test_v2_v3_parity.py, which is
# the row-schema/handler-level parity gate that calls the BE handler
# directly. This shim drives the outside-in CLI variant.)
#
# The bash original supported synth-diamond-test as an alternative
# graph and a --generate flag; the pytest port currently parametrises
# only synth-mirror-4step. Extend ``_CASES`` if needed; rerun synth_gen
# manually when fixtures need refreshing.
#
#   bash graph-ops/scripts/v2-v3-parity-test.sh
#   bash graph-ops/scripts/v2-v3-parity-test.sh single-hop
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_v2_v3_parity_outside_in.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
