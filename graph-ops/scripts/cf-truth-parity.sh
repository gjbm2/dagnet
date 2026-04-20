#!/usr/bin/env bash
#
# CF truth-parity test — Class B (lagless) assertion, Class A (laggy)
# informational + catastrophic-bound assertion. Scope: doc 50.
#
# Asserts:
#   - Lagless edges (σ=0): |cf_p - truth_p| < LAGLESS_TOL (default 0.05).
#     Class B's Beta-Binomial closed form should be exact given the
#     resolver's α/β; deviation beyond MC noise indicates a real defect.
#   - Laggy edges (σ>0): |cf_p - truth_p| < LAGGY_BOUND (default 0.20).
#     This is a *catastrophic* bound — wide enough to tolerate the
#     known κ=20 weak-prior bias in the legacy span_kernel/v2 path
#     (doc 56 Phase 1-4 scope) but tight enough to catch a regression
#     that breaks Class A entirely. The per-edge |Δ| is also printed
#     to make the bias size visible at every run.
#
# Continues across all fixtures even on failure; reports a final
# summary with the per-fixture pass/fail breakdown.
#
# Usage:
#   bash graph-ops/scripts/cf-truth-parity.sh [graph-name]
#   LAGLESS_TOL=0.03 bash graph-ops/scripts/cf-truth-parity.sh
#   LAGGY_BOUND=0.10 bash graph-ops/scripts/cf-truth-parity.sh
#
# Runs the suite across all T1-T7 fixtures when no graph specified.

set -uo pipefail

. "$(dirname "$0")/_load-conf.sh"

LAGLESS_TOL="${LAGLESS_TOL:-0.05}"
LAGGY_BOUND="${LAGGY_BOUND:-0.20}"

FIXTURES_DEFAULT=(
  "synth-simple-abc|window(-120d:)"
  "cf-fix-linear-no-lag|window(-60d:)"
  "synth-mirror-4step|cohort(7-Mar-26:21-Mar-26)"
  "cf-fix-branching|window(-60d:)"
  "cf-fix-diamond-mixed|window(-120d:)"
  "cf-fix-deep-mixed|window(-180d:)"
)

if [ $# -gt 0 ]; then
  FIXTURES=("$1|window(-120d:)")
else
  FIXTURES=("${FIXTURES_DEFAULT[@]}")
fi

echo "══════════════════════════════════════════════════════════════"
echo "  CF truth-parity"
echo "    Class B (lagless) tol = $LAGLESS_TOL  (asserted)"
echo "    Class A (laggy) bound = $LAGGY_BOUND  (asserted, catastrophic only)"
echo "══════════════════════════════════════════════════════════════"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true
cd "$_DAGNET_ROOT"

FAIL_LAGLESS=0
FAIL_LAGGY=0
declare -a FIXTURE_RESULTS=()

for entry in "${FIXTURES[@]}"; do
  IFS='|' read -r graph dsl <<< "$entry"
  echo ""
  echo "── $graph  ($dsl) ──"

  CF_JSON=$(bash graph-ops/scripts/analyse.sh "$graph" "$dsl" \
    --type conditioned_forecast --topo-pass --format json 2>/dev/null | \
    sed '1{/^Now using/d}')

  RC=0
  python3 <<PY || RC=$?
import json, yaml, sys
from pathlib import Path

graph = "$graph"
lagless_tol = $LAGLESS_TOL
laggy_bound = $LAGGY_BOUND
cf = json.loads('''$CF_JSON''')
truth = yaml.safe_load(open(f"/home/reg/dev/dagnet/bayes/truth/{graph}.truth.yaml"))

truth_edges = {}
for ek, ev in (truth.get("edges") or {}).items():
    truth_edges[(ev["from"], ev["to"])] = {
        "sigma": float(ev.get("sigma", 0.0)),
        "p": float(ev["p"]),
    }

cf_edges = (cf.get("scenarios") or [{}])[0].get("edges", [])
fail_lagless = 0
fail_laggy = 0
for e in cf_edges:
    fn, tn = e["from_node"], e["to_node"]
    truth_info = truth_edges.get((fn, tn))
    if not truth_info: continue
    cf_p = e.get("p_mean")
    if cf_p is None: continue
    sigma = truth_info["sigma"]
    truth_p = truth_info["p"]
    delta = abs(truth_p - cf_p)
    if sigma == 0:
        ok = delta < lagless_tol
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {fn+' -> '+tn:<52}  B (lagless)  truth={truth_p:.4f}  cf={cf_p:.4f}  |Δ|={delta:.4f}  tol={lagless_tol}")
        if not ok: fail_lagless += 1
    else:
        ok = delta < laggy_bound
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {fn+' -> '+tn:<52}  A (laggy)    truth={truth_p:.4f}  cf={cf_p:.4f}  |Δ|={delta:.4f}  bound={laggy_bound}")
        if not ok: fail_laggy += 1
# Encode counts in exit code: high byte = laggy fails, low byte = lagless fails
sys.exit((fail_laggy << 4) | (fail_lagless & 0x0F))
PY
  rc=$RC
  this_lagless=$(( rc & 0x0F ))
  this_laggy=$(( (rc >> 4) & 0x0F ))
  FAIL_LAGLESS=$(( FAIL_LAGLESS + this_lagless ))
  FAIL_LAGGY=$(( FAIL_LAGGY + this_laggy ))
  FIXTURE_RESULTS+=("$graph: lagless_fail=$this_lagless, laggy_fail=$this_laggy")
done

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Per-fixture summary:"
for r in "${FIXTURE_RESULTS[@]}"; do
  echo "    $r"
done
echo ""
echo "  Total Class B failures (lagless > tol): $FAIL_LAGLESS"
echo "  Total Class A failures (laggy > bound): $FAIL_LAGGY"

if [ $FAIL_LAGLESS -eq 0 ] && [ $FAIL_LAGGY -eq 0 ]; then
  echo "  ✓ All edges within tolerance"
  echo "══════════════════════════════════════════════════════════════"
  exit 0
fi

echo "══════════════════════════════════════════════════════════════"
exit $(( FAIL_LAGLESS + FAIL_LAGGY ))
