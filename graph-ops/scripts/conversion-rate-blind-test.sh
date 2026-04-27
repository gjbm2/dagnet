#!/usr/bin/env bash
#
# conversion_rate blind contract tests (doc 49 Part B) — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_conversion_rate_blind.py and runs through
# the long-lived dagnet-cli daemon. The pytest equivalent makes 2 CLI
# calls instead of the bash original's ~9 (one per --get) — the
# non-latency response is computed once and shared across all assertions
# via a module-scoped fixture.
#
#   bash graph-ops/scripts/conversion-rate-blind-test.sh
#   bash graph-ops/scripts/conversion-rate-blind-test.sh test_t6
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_conversion_rate_blind.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
