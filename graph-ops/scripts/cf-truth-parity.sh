#!/usr/bin/env bash
#
# CF truth-parity test — lagless-edge (Class B) assertion + laggy-edge
# informational report. Scope: doc 50 Class B (σ=0 edges).
#
# Asserts:
#   - Lagless edges (σ=0): |cf_p - truth_p| < LAGLESS_TOL (default 0.05).
#     Class B's Beta-Binomial closed form should be exact given the
#     resolver's α/β; deviation beyond MC noise indicates a real defect.
#
# Reports (no assertion):
#   - Laggy edges (σ>0): |Δ| printed for each. CF has a pre-existing
#     numerical bias on laggy edges (visible on synth-simple-abc which
#     is all-laggy and untouched by doc 50). Magnitude depends on
#     cohort maturity vs query window — cohort-mode terminal edges can
#     exceed 0.5 when evidence is very sparse. Tracked separately as a
#     CF accuracy investigation, not gated here.
#
# Fails if any lagless edge exceeds LAGLESS_TOL. Laggy edges never
# fail this test.
#
# Usage:
#   bash graph-ops/scripts/cf-truth-parity.sh [graph-name]
#
# Runs the suite across all T1-T7 fixtures when no graph specified.

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

LAGLESS_TOL="${LAGLESS_TOL:-0.05}"

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
echo "  CF truth-parity (lagless tol=$LAGLESS_TOL; laggy informational)"
echo "══════════════════════════════════════════════════════════════"

cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true
cd "$_DAGNET_ROOT"

FAIL=0
for entry in "${FIXTURES[@]}"; do
  IFS='|' read -r graph dsl <<< "$entry"
  echo ""
  echo "── $graph  ($dsl) ──"

  CF_JSON=$(bash graph-ops/scripts/analyse.sh "$graph" "$dsl" \
    --type conditioned_forecast --topo-pass --format json 2>/dev/null | \
    sed '1{/^Now using/d}')

  python3 <<PY
import json, yaml, sys
from pathlib import Path

graph = "$graph"
lagless_tol = $LAGLESS_TOL
cf = json.loads('''$CF_JSON''')
truth = yaml.safe_load(open(f"/home/reg/dev/dagnet/bayes/truth/{graph}.truth.yaml"))

truth_edges = {}
for ek, ev in (truth.get("edges") or {}).items():
    truth_edges[(ev["from"], ev["to"])] = {
        "sigma": float(ev.get("sigma", 0.0)),
        "p": float(ev["p"]),
    }

cf_edges = (cf.get("scenarios") or [{}])[0].get("edges", [])
failed = 0
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
        # Class B — asserted
        ok = delta < lagless_tol
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {fn+' -> '+tn:<52}  B (lagless)   truth={truth_p:.4f}  cf={cf_p:.4f}  |Δ|={delta:.4f}  tol={lagless_tol}")
        if not ok: failed += 1
    else:
        # Class A — informational only (pre-existing CF bias tracked separately)
        print(f"  · {fn+' -> '+tn:<52}  A (laggy, info)  truth={truth_p:.4f}  cf={cf_p:.4f}  |Δ|={delta:.4f}")
sys.exit(failed)
PY
  rc=$?
  if [ $rc -ne 0 ]; then
    FAIL=$((FAIL + rc))
  fi
done

echo ""
echo "══════════════════════════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo "  ✓ All lagless (Class B) edges within tolerance $LAGLESS_TOL"
  exit 0
else
  echo "  ✗ $FAIL lagless edge(s) exceed tolerance $LAGLESS_TOL — real Class B defect"
  exit 1
fi
