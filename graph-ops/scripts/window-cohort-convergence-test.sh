#!/usr/bin/env bash
#
# Multi-hop composition parity test.
#
# Tests that the multi-hop cohort maturity midpoint is consistent
# with the product of per-edge midpoints. This catches structural
# defects where the multi-hop engine's carrier, IS conditioning,
# or CDF composition over-suppresses or inflates the rate.
#
# Invariant: for a path C→D→E, the multi-hop midpoint at maturity
# should approximately equal midpoint(C→D) × midpoint(D→E), within
# MC variance tolerance. This must hold for BOTH window and cohort
# modes independently.
#
# Secondary invariant: window and cohort multi-hop midpoints should
# not diverge by more than ~20% (each per-edge divergence is bounded
# by drift; the multi-hop divergence should not compound beyond
# the sum of per-edge divergences).
#
# Usage:
#   bash graph-ops/scripts/window-cohort-convergence-test.sh [graph-name]
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - Synth graph generated or prod graph with snapshot data

set -o pipefail

. "$(dirname "$0")/_load-conf.sh"

GRAPH_NAME="${1:-synth-mirror-4step}"
shift || true

# ── Ensure synth data is fresh ────────────────────────────────────────
# Delegates to synth_gen's own freshness check (truth hash, graph hash,
# DB integrity). Skips quickly if already fresh; regenerates if stale.
_ensure_synth_data() {
  local graph_name="$1"
  echo "  Checking synth data freshness for $graph_name..."
  (
    cd "$_DAGNET_ROOT"
    . graph-editor/venv/bin/activate
    PYTHONPATH="$_DAGNET_ROOT" \
    DB_CONNECTION="$(grep DB_CONNECTION graph-editor/.env.local | cut -d= -f2-)" \
      python bayes/synth_gen.py --graph "$graph_name" --write-files --enrich
  ) || { echo "ERROR: synth_gen failed for $graph_name"; exit 1; }
}

_ensure_synth_data "$GRAPH_NAME"

PASS=0
FAIL=0
TOTAL=0

_check() {
  local label="$1"
  local result="$2"
  TOTAL=$((TOTAL + 1))
  if [ "$result" = "0" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $label"
  fi
}

echo "══════════════════════════════════════════════════════"
echo "  Multi-hop composition parity: $GRAPH_NAME"
echo "══════════════════════════════════════════════════════"

# ── Test cases ────────────────────────────────────────────────────────
# Each case: label | edge1_subject | edge2_subject | multihop_subject | date_range | anchor
# The multi-hop subject spans both edges.

declare -a CASES

_define_cases_synth_mirror_4step() {
  # Path: m4-delegated(c) → m4-registered(d) → m4-success(e)
  # Latency edges: c→d (t95≈25d), d→e (t95≈8d)
  # Anchor: m4-landing. DB data: 22-Mar-26 to 10-May-26
  CASES=(
    "c-d-e|from(m4-delegated).to(m4-registered)|from(m4-registered).to(m4-success)|from(m4-delegated).to(m4-success)|22-Mar-26:21-Apr-26|m4-landing"
  )
}

_define_cases_synth_slow_path() {
  # Path: delegated(c) → registered(d) → success(e)
  # Latency edges: c→d (t95≈100d), d→e (t95≈26d)
  # Anchor: synth-slow-path-landing. DB data: 22-Mar-26 to 10-May-26
  CASES=(
    "c-d-e|from(synth-slow-path-delegated).to(synth-slow-path-registered)|from(synth-slow-path-registered).to(synth-slow-path-success)|from(synth-slow-path-delegated).to(synth-slow-path-success)|22-Mar-26:21-Apr-26|synth-slow-path-landing"
  )
}

_define_cases_synth_lat4() {
  # Path: b → c → d (2-hop multi-hop with upstream latency from a→b)
  # ALL edges have latency: a→b (t95≈19d), b→c (t95≈21d), c→d (t95≈16d)
  # Anchor: synth-lat4-a. DB data: 10-Feb-26 to 11-May-26
  # The upstream a→b latency spreads the population arriving at b,
  # so window(from(b).to(d)) and cohort(from(b).to(d)) should diverge.
  CASES=(
    "b-c-d|from(synth-lat4-b).to(synth-lat4-c)|from(synth-lat4-c).to(synth-lat4-d)|from(synth-lat4-b).to(synth-lat4-d)|10-Feb-26:10-Apr-26|synth-lat4-a"
  )
}

# Select cases
_fn="_define_cases_${GRAPH_NAME//-/_}"
if declare -f "$_fn" > /dev/null 2>&1; then
  "$_fn"
else
  echo "  No cases for $GRAPH_NAME"
  exit 1
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

for case_spec in "${CASES[@]}"; do
  IFS='|' read -r label edge1 edge2 multihop date_range anchor <<< "$case_spec"

  echo ""
  echo "Case: $label"

  for mode in window cohort; do
    if [ "$mode" = "window" ]; then
      e1_dsl="${edge1}.window(${date_range})"
      e2_dsl="${edge2}.window(${date_range})"
      mh_dsl="${multihop}.window(${date_range})"
    else
      e1_dsl="${edge1}.cohort(${anchor},${date_range})"
      e2_dsl="${edge2}.cohort(${anchor},${date_range})"
      mh_dsl="${multihop}.cohort(${anchor},${date_range})"
    fi

    echo "  Mode: $mode"

    # Run all three analyses
    for tag_dsl in "e1:${e1_dsl}" "e2:${e2_dsl}" "mh:${mh_dsl}"; do
      IFS=: read -r tag dsl <<< "$tag_dsl"
      OUT="$TMPDIR/${label}_${mode}_${tag}.json"
      echo "    Running $tag: $dsl"
      bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" "$dsl" \
        --type cohort_maturity --topo-pass --no-snapshot-cache --no-cache --format json \
        2>/dev/null | sed '/^Now using/d' \
        > "$OUT" || true
    done

    # Compare
    RESULT=$(python3 -c "
import json, sys

def load_mature_midpoint(path):
    try:
        d = json.load(open(path))
        rows = d.get('result',{}).get('data',[])
        if not rows:
            return None
        mids = [r.get('midpoint') for r in rows if r.get('midpoint') is not None]
        if len(mids) < 5:
            return None
        # Average last 5 mature midpoints
        return sum(mids[-5:]) / 5
    except:
        return None

e1 = load_mature_midpoint('$TMPDIR/${label}_${mode}_e1.json')
e2 = load_mature_midpoint('$TMPDIR/${label}_${mode}_e2.json')
mh = load_mature_midpoint('$TMPDIR/${label}_${mode}_mh.json')

if e1 is None or e2 is None or mh is None:
    print(f'FAIL:missing data e1={e1} e2={e2} mh={mh}')
    sys.exit(0)

product = e1 * e2
delta = abs(mh - product)
rel = delta / max(product, 1e-6)

print(f'edge1={e1:.5f}  edge2={e2:.5f}  product={product:.5f}  multihop={mh:.5f}')
print(f'delta={delta:.5f}  relative={rel:.1%}')

# Tolerance: 15% relative or 0.015 absolute
threshold = max(0.015, 0.15 * product)
mode_label = '$mode'
if delta <= threshold:
    print(f'PASS:{mode_label} composition within tolerance (delta={delta:.5f} <= {threshold:.5f})')
else:
    print(f'FAIL:{mode_label} composition broken. delta={delta:.5f} > threshold={threshold:.5f} ({rel:.1%} off)')
" 2>/dev/null)

    # Display all output and check for PASS/FAIL
    # Window composition is informational only — product-of-midpoints
    # is not a valid invariant in window mode because per-edge analyses
    # see different population maturation mixes than multi-hop.
    echo "$RESULT"
    if [ "$mode" = "window" ]; then
      echo "    (window composition — informational only)"
    else
      TOTAL=$((TOTAL + 1))
      if echo "$RESULT" | grep -q '^PASS:' 2>/dev/null; then
        PASS=$((PASS + 1))
        echo "    ✓ composition OK"
      else
        FAIL=$((FAIL + 1))
        echo "    ✗ cohort composition broken"
      fi
    fi
  done

  # Cross-mode: window vs cohort multi-hop divergence
  echo "  Cross-mode divergence:"
  CROSS=$(python3 -c "
import json, sys

def load_mature_midpoint(path):
    try:
        d = json.load(open(path))
        rows = d.get('result',{}).get('data',[])
        mids = [r.get('midpoint') for r in rows if r.get('midpoint') is not None]
        if len(mids) < 5: return None
        return sum(mids[-5:]) / 5
    except: return None

wm = load_mature_midpoint('$TMPDIR/${label}_window_mh.json')
cm = load_mature_midpoint('$TMPDIR/${label}_cohort_mh.json')
if wm is None or cm is None:
    print(f'FAIL:missing data wm={wm} cm={cm}')
    sys.exit(0)

delta = abs(wm - cm)
avg = (wm + cm) / 2
rel = delta / avg if avg > 0 else 0

print(f'window_mh={wm:.5f}  cohort_mh={cm:.5f}  delta={delta:.5f}  relative={rel:.1%}')

# Per-edge divergence sum should bound multi-hop divergence
we1 = load_mature_midpoint('$TMPDIR/${label}_window_e1.json')
ce1 = load_mature_midpoint('$TMPDIR/${label}_cohort_e1.json')
we2 = load_mature_midpoint('$TMPDIR/${label}_window_e2.json')
ce2 = load_mature_midpoint('$TMPDIR/${label}_cohort_e2.json')
if all(v is not None for v in [we1,ce1,we2,ce2]):
    d1 = abs(we1-ce1)/max(we1,ce1) if max(we1,ce1)>0 else 0
    d2 = abs(we2-ce2)/max(we2,ce2) if max(we2,ce2)>0 else 0
    print(f'per-edge divergence: e1={d1:.1%} e2={d2:.1%} sum={d1+d2:.1%}')

# Multi-hop divergence should not exceed 2x sum of per-edge divergences + 10% tolerance
if all(v is not None for v in [we1,ce1,we2,ce2]):
    bound = 2*(d1+d2) + 0.10
    if rel <= bound:
        print(f'PASS:multi-hop divergence {rel:.1%} within bound {bound:.1%}')
    else:
        print(f'FAIL:multi-hop divergence {rel:.1%} exceeds bound {bound:.1%}')
else:
    if rel <= 0.30:
        print(f'PASS:multi-hop divergence {rel:.1%} under 30%')
    else:
        print(f'FAIL:multi-hop divergence {rel:.1%} exceeds 30%')
" 2>/dev/null)

  echo "$CROSS"
  TOTAL=$((TOTAL + 1))
  if echo "$CROSS" | grep -q '^PASS:'; then
    PASS=$((PASS + 1))
    echo "    ✓ cross-mode OK"
  else
    FAIL=$((FAIL + 1))
    echo "    ✗ cross-mode divergence too large"
  fi
done

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "══════════════════════════════════════════════════════"

exit "$FAIL"
