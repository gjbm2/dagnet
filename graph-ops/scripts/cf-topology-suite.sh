#!/usr/bin/env bash
#
# CF topology test suite (doc 50 §5).
#
# Runs the conditioned-forecast-parity-test against every topology
# fixture that exercises a cell of the T1–T7 matrix. Exits non-zero
# if any fixture fails.
#
# Coverage (doc 50 §5.1):
#   T1 (linear all-lag)        — synth-simple-abc
#   T2 (linear no-lag)         — cf-fix-linear-no-lag
#   T3 (linear mixed)          — synth-mirror-4step
#   T4 (branching mixed)       — cf-fix-branching
#   T6 (diamond mixed)         — cf-fix-diamond-mixed
#   T7 (deep mixed, 6 hops)    — cf-fix-deep-mixed
#
# (T5 "join" — converging paths with different lag profiles — is
# implicitly exercised by the rejoin arm of T6.)
#
# Acceptance invariants (doc 50 §5.3):
#   1. No silent drops: every parameterised edge appears in
#      `edges` or `skipped_edges`.
#   2. Class A ↔ Class B continuity: lagless edges converge to the
#      σ→0 limit of laggy edges (implicit in parity test Phase 2).
#   3. Chart parity: whole-graph CF p_mean equals v3 chart midpoint
#      to 4dp (enforced by conditioned-forecast-parity-test.sh Phase 2).
#   4. Sibling PMF ≤ 1.0 under mixed classes (Phase 3).
#   5. Whole-graph coverage: CF response lists every parameterised
#      edge (Phase 1 — temporal-only returns non-empty edges).
#
# Usage:
#   bash graph-ops/scripts/cf-topology-suite.sh
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - Fixtures generated (synth_gen.py --write-files --enrich) —
#     truth files live in bayes/truth/ and are generated on-demand.

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

FIXTURES=(
  "synth-simple-abc::T1 linear all-lag"
  "cf-fix-linear-no-lag::T2 linear no-lag"
  "synth-mirror-4step::T3 linear mixed"
  "cf-fix-branching::T4 branching mixed"
  "cf-fix-diamond-mixed::T6 diamond mixed"
  "cf-fix-deep-mixed::T7 deep mixed 6-hop"
)

PARITY_SCRIPT="$_DAGNET_ROOT/graph-ops/scripts/conditioned-forecast-parity-test.sh"

echo "══════════════════════════════════════════════════════════════"
echo "  CF Topology Suite (doc 50 §5 — T1–T7 matrix)"
echo "══════════════════════════════════════════════════════════════"
echo ""

PASS_FIXTURES=()
FAIL_FIXTURES=()
TMPDIR_SUITE=$(mktemp -d)
trap "rm -rf $TMPDIR_SUITE" EXIT

for entry in "${FIXTURES[@]}"; do
  IFS='::' read -r graph label <<< "$entry"
  # Second read token is '' from split on '::' — skip empty
  label="${label#:}"
  echo "── $label ($graph) ──"

  LOG_FILE="$TMPDIR_SUITE/${graph}.log"
  if bash "$PARITY_SCRIPT" "$graph" > "$LOG_FILE" 2>&1; then
    # Extract summary line
    summary=$(grep -E "^  [0-9]+ passed" "$LOG_FILE" | tail -1 || true)
    echo "  ✓ $graph — ${summary## }"
    PASS_FIXTURES+=("$graph")
  else
    summary=$(grep -E "^  [0-9]+ passed" "$LOG_FILE" | tail -1 || true)
    echo "  ✗ $graph — ${summary## }"
    echo "    Log tail:"
    tail -12 "$LOG_FILE" | sed 's/^/      /'
    FAIL_FIXTURES+=("$graph")
  fi
  echo ""
done

echo "══════════════════════════════════════════════════════════════"
echo "  Summary: ${#PASS_FIXTURES[@]} pass, ${#FAIL_FIXTURES[@]} fail out of ${#FIXTURES[@]}"
echo "══════════════════════════════════════════════════════════════"

if [ ${#FAIL_FIXTURES[@]} -gt 0 ]; then
  echo "Failed fixtures:"
  for g in "${FAIL_FIXTURES[@]}"; do
    echo "  - $g (log: $TMPDIR_SUITE/${g}.log)"
  done
  echo ""
  echo "To inspect a failure, re-run:"
  echo "  bash graph-ops/scripts/conditioned-forecast-parity-test.sh <graph-name> --verbose"
  exit 1
fi

exit 0
