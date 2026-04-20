#!/usr/bin/env bash
#
# Chart-graph agreement test (doc 29f §Phase G).
#
# Asserts that the topo pass and cohort maturity chart produce
# consistent forecast rates for the same edge on the same data.
#
# Two assertions:
#
# A. p.mean ≈ model_midpoint at max_tau
#    Both are the (roughly) unconditioned asymptotic rate.
#    p.mean comes from compute_forecast_summary (topo pass);
#    model_midpoint comes from p_draws × CDF (chart prior).
#    These use different codepaths but answer a similar question.
#    Expected: GREEN today (both near the prior rate).
#
# B. p.mean ≈ midpoint at max_tau
#    Both should be the IS-conditioned asymptotic rate.
#    midpoint comes from the chart's per-cohort sequential IS +
#    population model. p.mean comes from aggregate tempered IS.
#    Different IS strategies produce different conditioning.
#    Expected: RED until Phase G (different IS codepaths).
#
# Usage:
#   bash graph-ops/scripts/chart-graph-agreement-test.sh [graph-name]
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - Synth graph generated (synth_gen.py --write-files)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

GRAPH_NAME="${1:-synth-mirror-4step}"
VERBOSE=false
for arg in "${@:2}"; do
  case "$arg" in
    --verbose|-v) VERBOSE=true ;;
  esac
done

DATA_REPO_PATH="$_DAGNET_ROOT/$DATA_REPO_DIR"

PASS=0
FAIL=0
TOTAL=0

echo "══════════════════════════════════════════════════════"
echo "  Chart-graph agreement test: $GRAPH_NAME"
echo "══════════════════════════════════════════════════════"

TMPDIR_AGR=$(mktemp -d)
trap "rm -rf $TMPDIR_AGR" EXIT

# ── Test cases ─────────────────────────────────────────────────────
# label | chart DSL | param-pack DSL | edge-id
# Two date ranges test different scoping scenarios:
# - "full": covers the entire param file. Scoped == all cohorts.
#   Tests pure codepath divergence (IS strategy difference).
# - "narrow": 15-day window of young cohorts. Scoped ≠ all.
#   Tests D18 fix (scoping) + codepath divergence.
declare -a CASES=(
  "full-range|from(m4-registered).to(m4-success).cohort(12-Dec-25:21-Mar-26)|cohort(12-Dec-25:21-Mar-26)|m4-registered-to-success"
  "narrow-range|from(m4-registered).to(m4-success).cohort(7-Mar-26:21-Mar-26)|cohort(7-Mar-26:21-Mar-26)|m4-registered-to-success"
)

for case_spec in "${CASES[@]}"; do
  IFS='|' read -r label chart_dsl pp_dsl edge_id <<< "$case_spec"

  # ── Step 1: param-pack (topo pass) ────────────────────────────────
  PP_FILE="$TMPDIR_AGR/${label}_pp.json"
  bash "$_DAGNET_ROOT/graph-ops/scripts/param-pack.sh" \
    "$GRAPH_NAME" "$pp_dsl" --format json \
    2>/dev/null | sed '1{/^Now using/d}' \
    > "$PP_FILE" || true

  # ── Step 2: chart (analyse) ───────────────────────────────────────
  CHART_FILE="$TMPDIR_AGR/${label}_chart.json"
  bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" \
    "$GRAPH_NAME" "$chart_dsl" \
    --type cohort_maturity --topo-pass --no-snapshot-cache --format json \
    2>/dev/null | sed '1{/^Now using/d}' \
    > "$CHART_FILE" || true

  # ── Step 3: compare ───────────────────────────────────────────────
  RESULT=$(python3 -c "
import json, sys

pp = json.load(open('$PP_FILE'))
pp_mean = pp.get('e.${edge_id}.p.mean')
if pp_mean is None:
    print('A_SKIP|no p.mean')
    print('B_SKIP|no p.mean')
    sys.exit(0)
pp_mean = float(pp_mean)

ch = json.load(open('$CHART_FILE'))
rows = ch.get('result',{}).get('data',[]) or ch.get('result',{}).get('maturity_rows',[])
if not rows:
    print('A_SKIP|no chart rows')
    print('B_SKIP|no chart rows')
    sys.exit(0)

# Read model_midpoint and midpoint at the last available tau.
# Both converge toward asymptotic rates at large tau.
last_model_mid = None
last_mid = None
last_tau = None
for r in reversed(rows):
    tau = r['tau_days']
    if last_tau is None:
        last_tau = tau
    if last_model_mid is None and r.get('model_midpoint') is not None:
        last_model_mid = float(r['model_midpoint'])
    if last_mid is None and r.get('midpoint') is not None:
        last_mid = float(r['midpoint'])
    if last_model_mid is not None and last_mid is not None:
        break

# Assertion A: p.mean ≈ model_midpoint (unconditioned prior rate)
# Tolerance: 5%. model_midpoint at max_tau may not have fully
# converged, so allow for that.
if last_model_mid is not None:
    delta_a = abs(pp_mean - last_model_mid)
    ok_a = delta_a < 0.05
    status_a = 'A_PASS' if ok_a else 'A_FAIL'
    print(f'{status_a}|p.mean={pp_mean:.4f} model_mid@{last_tau}={last_model_mid:.4f} D={delta_a:.4f}')
else:
    print('A_SKIP|no model_midpoint in chart')

# Assertion B: p.mean ≈ midpoint (conditioned rate at convergence)
# This tests IS conditioning agreement. Expected RED until Phase G.
if last_mid is not None:
    delta_b = abs(pp_mean - last_mid)
    ok_b = delta_b < 0.05
    status_b = 'B_PASS' if ok_b else 'B_FAIL'
    print(f'{status_b}|p.mean={pp_mean:.4f} midpoint@{last_tau}={last_mid:.4f} D={delta_b:.4f}')
else:
    print('B_SKIP|no midpoint in chart')
" 2>/dev/null)

  while IFS= read -r line; do
    IFS='|' read -r status detail <<< "$line"
    tag="${status%%_*}"  # A or B
    result="${status#*_}"  # PASS, FAIL, or SKIP

    TOTAL=$((TOTAL + 1))
    case "$result" in
      PASS)
        PASS=$((PASS + 1))
        echo "  ✓ $label [$tag]: $detail"
        ;;
      SKIP)
        FAIL=$((FAIL + 1))
        echo "  ⊘ $label [$tag]: SKIPPED — $detail"
        ;;
      FAIL)
        FAIL=$((FAIL + 1))
        if [ "$tag" = "B" ]; then
          echo "  ✗ $label [$tag]: $detail  (expected — Phase G)"
        else
          echo "  ✗ $label [$tag]: $detail"
        fi
        ;;
    esac
  done <<< "$RESULT"
done

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo "  $PASS passed, $FAIL failed out of $TOTAL"
echo ""
echo "  [A] p.mean vs model_midpoint (prior rate)"
echo "      Should pass today — both near unconditioned rate."
echo "  [B] p.mean vs midpoint (conditioned rate)"
echo "      Expected RED until Phase G unifies IS codepaths."
echo "══════════════════════════════════════════════════════"

exit $FAIL
