#!/usr/bin/env bash
#
# Multi-hop cohort/window metamorphic canary (doc 64 Family D + G) — pytest delegate.
#
# The test logic now lives in
# graph-editor/lib/tests/test_multihop_evidence_parity.py and runs
# through the long-lived dagnet-cli daemon.
#
# Two metamorphic claims on synth-mirror-4step:
#   Claim 1 — cohort vs window collapse on non-latent upstream multi-hop
#   Claim 2 — cohort vs window diverge on latent upstream single-hop
# Plus a v2 cross-version signal that helps localise regressions.
#
#   bash graph-ops/scripts/multihop-evidence-parity-test.sh
#   bash graph-ops/scripts/multihop-evidence-parity-test.sh evidence_x
#   bash graph-ops/scripts/multihop-evidence-parity-test.sh TestSinglehopDiverge
#
# See docs/current/codebase/GRAPH_OPS_TOOLING.md §"Long-lived daemon mode".

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

TEST_FILE="lib/tests/test_multihop_evidence_parity.py"

if [ $# -gt 0 ]; then
  exec python -m pytest "$TEST_FILE" -k "$1" --tb=short -v
else
  exec python -m pytest "$TEST_FILE" --tb=short -v
fi
