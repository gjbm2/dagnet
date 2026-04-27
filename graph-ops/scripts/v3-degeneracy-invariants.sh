#!/usr/bin/env bash
#
# v3 degeneracy invariants — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_v3_degeneracy_invariants.py and runs
# through the long-lived dagnet-cli daemon.
#
#   bash graph-ops/scripts/v3-degeneracy-invariants.sh
#   bash graph-ops/scripts/v3-degeneracy-invariants.sh i2
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_v3_degeneracy_invariants.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
