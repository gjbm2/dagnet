#!/usr/bin/env bash
#
# Multi-hop composition parity test — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_window_cohort_convergence.py and runs
# through the long-lived dagnet-cli daemon.
#
# Note: the bash original supported three graph configurations
# (synth-mirror-4step, synth-slow-path, synth-lat4) selected via the
# first positional argument. The pytest version currently parametrises
# only synth-mirror-4step to match historical default CI behaviour.
# Extend ``_CASES`` in the pytest module to bring the others back.
#
#   bash graph-ops/scripts/window-cohort-convergence-test.sh
#   bash graph-ops/scripts/window-cohort-convergence-test.sh synth-mirror-4step
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_window_cohort_convergence.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
