#!/usr/bin/env bash
#
# v3 degeneracy invariants — outside-in harness.
#
# Exercises the public CLI tooling (analyse.sh) against stable synth
# fixtures and asserts the semantic invariants from
#   docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md
# and
#   docs/current/project-bayes/60-forecast-adaptation-programme.md
#
# All checks target cohort_maturity_v3 only. v2 is not tested here.
#
# Invariants covered (prose; see the README at the foot of this script
# for pointers into the semantics doc):
#
#   I1  Zero-evidence window degenerates to the subject-span CDF shape,
#       not a flat line at p.mean.
#   I2  Zero-evidence cohort with A != X and non-trivial upstream
#       latency rises more slowly than zero-evidence window.
#   I3  Zero-evidence cohort with A = X is semantically identical to
#       zero-evidence window on the same edge.
#   I4  Window asymptotic midpoint equals the Bayesian posterior p.mean
#       (within tolerance) when evidence is present and data has matured.
#   I5  Cohort midpoint is never materially above window midpoint at
#       any tau, on a single-hop edge with any upstream latency.
#
# Every invariant is checked by running analyse.sh with a specific
# query shape, reading result.data[] rows, and comparing midpoint /
# model_midpoint values against expected shape constraints.
#
# Usage:
#   bash graph-ops/scripts/v3-degeneracy-invariants.sh
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - synth-mirror-4step and synth-lat4 generated and enriched
#     (the script runs synth_gen.py preflight automatically)
#   - Bayes-vars sidecar for synth-mirror-4step (auto-detected;
#     invariants that require it are skipped if missing)

set -o pipefail

. "$(dirname "$0")/_load-conf.sh"

# Suppress nvm noise on stdout globally
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use "$(cat "$_DAGNET_ROOT/graph-editor/.nvmrc")" >/dev/null 2>&1 || true
fi

# ── Preflight: ensure synth data is fresh ─────────────────────────────

_ensure_synth_data() {
  local graph_name="$1"
  echo "  freshness preflight: $graph_name"
  (
    cd "$_DAGNET_ROOT"
    . graph-editor/venv/bin/activate
    PYTHONPATH="$_DAGNET_ROOT" \
    DB_CONNECTION="$(grep DB_CONNECTION graph-editor/.env.local | cut -d= -f2-)" \
      python bayes/synth_gen.py --graph "$graph_name" --write-files --enrich \
      >/dev/null 2>&1
  ) || { echo "ERROR: synth_gen failed for $graph_name"; exit 1; }
}

# ── PASS/FAIL counters ────────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0
RESULTS=()

_record() {
  local label="$1"
  local verdict="$2"
  local detail="$3"
  case "$verdict" in
    PASS) PASS=$((PASS + 1)); echo "  ✓ $label: $detail" ;;
    FAIL) FAIL=$((FAIL + 1)); echo "  ✗ $label: $detail" ;;
    SKIP) SKIP=$((SKIP + 1)); echo "  - $label: SKIP — $detail" ;;
  esac
  RESULTS+=("$verdict|$label|$detail")
}

# ── analyse.sh helper: v3 + --bayes-vars optional, capture to JSON ───

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

_run_v3() {
  # args: outfile graph dsl [--bayes-vars <path>]
  local outfile="$1"; shift
  local graph="$1"; shift
  local dsl="$1"; shift
  bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$graph" "$dsl" \
    --type cohort_maturity --no-cache --no-snapshot-cache --format json \
    "$@" 2>/dev/null | sed '/^Now using/d' > "$outfile" || true
}

# ── Invariant checks ──────────────────────────────────────────────────

# I1: zero-evidence window must not be flat at p.mean
#
# Contract: on a latency edge with no post-frontier data, window's v3
# curve should be p × CDF_subject(tau), rising from near 0 at tau=0 toward
# p.mean as tau passes t95. The current defect produces midpoint == p.mean
# at every tau — a flat line. We test the shape by requiring that at
# tau=0 the midpoint is materially below p.mean and at the last tau the
# midpoint is materially above tau=0 (i.e. the curve is not constant).
_check_I1() {
  local graph="$1"; local edge_dsl="$2"; local sidecar="$3"
  local label="I1 [$graph: $edge_dsl]"

  local out="$TMPDIR/i1_window.json"
  if [ -n "$sidecar" ]; then
    _run_v3 "$out" "$graph" "${edge_dsl}.window(-1d:)" --bayes-vars "$sidecar"
  else
    _run_v3 "$out" "$graph" "${edge_dsl}.window(-1d:)"
  fi

  local verdict
  verdict=$(python3 - "$out" <<'PY'
import json, sys
p = sys.argv[1]
try:
    raw = open(p).read()
    d = json.loads(raw[raw.find('{'):])
except Exception as e:
    print(f"FAIL|parse error: {e}"); sys.exit(0)

rows = (d.get('result') or {}).get('data') or []
if not rows:
    print("FAIL|no result.data rows"); sys.exit(0)

mids = [r.get('model_midpoint') for r in rows if isinstance(r.get('model_midpoint'), (int, float))]
n = len(mids)

# A meaningful subject-span CDF check needs enough taus to span the edge's
# latency. If v3 only emits a couple of rows, that is itself a defect
# (the chart cannot render a curve from 2 points), but call it out
# explicitly rather than misreport it as a shape failure.
if n < 5:
    print(f"FAIL|too few rows to assess curve shape (n={n}, need ≥ 5) — v3 is not producing a trajectory")
    sys.exit(0)

first = mids[0]
last = mids[-1]
mx = max(mids)

if mx <= 0:
    print(f"FAIL|curve is identically zero across {n} taus — v3 is producing neither a rate nor a model curve")
    sys.exit(0)

# Flat-line detection: variation across trajectory / max < 1%
rel_variation = (max(mids) - min(mids)) / max(abs(mx), 1e-9)
if rel_variation < 0.01:
    print(f"FAIL|curve is flat (rel_var={rel_variation:.2%}) — first={first:.4f} last={last:.4f} max={mx:.4f}; expected a rising subject-span CDF")
    sys.exit(0)

# Subject-span CDF must start near 0 and end near p (i.e. near max)
if first > 0.30 * mx:
    print(f"FAIL|curve does not start near 0 — first={first:.4f} max={mx:.4f}; expected model_midpoint(tau=0) ≈ 0")
    sys.exit(0)

print(f"PASS|rises from {first:.4f} to {last:.4f} (max={mx:.4f}, rel_var={rel_variation:.1%})")
PY
)
  local v="${verdict%%|*}"
  local d="${verdict#*|}"
  _record "$label" "$v" "$d"
}

# I2: zero-evidence cohort with A != X rises more slowly than window
#
# Contract: when the anchor is upstream of the edge's from-node and the
# A→X path has non-trivial latency, cohort's v3 curve should show a
# material lag vs window's. We test by requiring cohort(tau) <= window(tau)
# at every tau (within small tolerance) and cohort reaches 0.5 * p_ref
# materially later than window.
_check_I2() {
  local graph="$1"; local edge_dsl="$2"; local sidecar="$3"
  local label="I2 [$graph: $edge_dsl]"

  local w_out="$TMPDIR/i2_window.json"
  local c_out="$TMPDIR/i2_cohort.json"
  if [ -n "$sidecar" ]; then
    _run_v3 "$w_out" "$graph" "${edge_dsl}.window(-1d:)" --bayes-vars "$sidecar"
    _run_v3 "$c_out" "$graph" "${edge_dsl}.cohort(-1d:)" --bayes-vars "$sidecar"
  else
    _run_v3 "$w_out" "$graph" "${edge_dsl}.window(-1d:)"
    _run_v3 "$c_out" "$graph" "${edge_dsl}.cohort(-1d:)"
  fi

  local verdict
  verdict=$(python3 - "$w_out" "$c_out" <<'PY'
import json, sys

def load_curve(p):
    try:
        raw = open(p).read()
        d = json.loads(raw[raw.find('{'):])
    except Exception:
        return None
    rows = (d.get('result') or {}).get('data') or []
    return {r['tau_days']: r.get('model_midpoint') for r in rows
            if 'tau_days' in r and isinstance(r.get('model_midpoint'), (int, float))}

wc = load_curve(sys.argv[1])
cc = load_curve(sys.argv[2])
if not wc or not cc:
    print(f"FAIL|missing curve data wc={bool(wc)} cc={bool(cc)}"); sys.exit(0)

common = sorted(set(wc) & set(cc))
if len(common) < 5:
    print(f"FAIL|too few overlapping taus to assess lag (n={len(common)}) — v3 is not producing a trajectory long enough to compare")
    sys.exit(0)

# Cohort must not exceed window beyond epsilon tolerance
eps = 0.03
violations = [(t, cc[t], wc[t]) for t in common if cc[t] > wc[t] + eps]
if violations:
    t, c, w = violations[0]
    print(f"FAIL|cohort above window at tau={t}: cohort={c:.4f} window={w:.4f} (first of {len(violations)})")
    sys.exit(0)

# Cohort must show a material lag. If the two curves are byte-identical
# at every tau, the mode distinction has been dropped on the v3 path —
# call that out specifically because it is the expected symptom of the
# zero-evidence degeneracy defect.
max_diff = max(abs(wc[t] - cc[t]) for t in common)
if max_diff < 1e-6:
    print(f"FAIL|cohort and window curves are identical at every tau (max_diff={max_diff:.2e}) — mode distinction lost")
    sys.exit(0)

target = 0.5 * max(wc.values())
def first_reach(curve, thresh):
    for t in sorted(curve):
        if curve[t] >= thresh:
            return t
    return None

w_half = first_reach(wc, target)
c_half = first_reach(cc, target)
if w_half is None:
    print(f"FAIL|window never reaches 0.5 * max — max={max(wc.values()):.4f}"); sys.exit(0)
if c_half is None:
    print(f"PASS|cohort lag severe: window reaches 0.5·max at tau={w_half}, cohort never does in observed range")
    sys.exit(0)
if c_half <= w_half:
    print(f"FAIL|cohort not lagged — window hits 0.5·max at tau={w_half}, cohort at tau={c_half} (expected cohort > window)")
    sys.exit(0)

print(f"PASS|cohort lagged (window reaches 0.5·max at tau={w_half}, cohort at tau={c_half})")
PY
)
  local v="${verdict%%|*}"
  local d="${verdict#*|}"
  _record "$label" "$v" "$d"
}

# I3: zero-evidence cohort with A=X equals window on the same edge
#
# Contract: when the anchor is the edge's from-node, carrier_to_x
# collapses to identity and the cohort query is semantically the same
# as window on that edge. v3 outputs must agree numerically.
_check_I3() {
  local graph="$1"; local from_node="$2"; local to_node="$3"; local sidecar="$4"
  local label="I3 [$graph: A=X=$from_node, edge to $to_node]"

  local w_out="$TMPDIR/i3_window.json"
  local c_out="$TMPDIR/i3_cohort.json"
  local w_dsl="from(${from_node}).to(${to_node}).window(-1d:)"
  local c_dsl="from(${from_node}).to(${to_node}).cohort(${from_node},-1d:)"
  if [ -n "$sidecar" ]; then
    _run_v3 "$w_out" "$graph" "$w_dsl" --bayes-vars "$sidecar"
    _run_v3 "$c_out" "$graph" "$c_dsl" --bayes-vars "$sidecar"
  else
    _run_v3 "$w_out" "$graph" "$w_dsl"
    _run_v3 "$c_out" "$graph" "$c_dsl"
  fi

  local verdict
  verdict=$(python3 - "$w_out" "$c_out" <<'PY'
import json, sys

def load_curve(p):
    try:
        raw = open(p).read()
        d = json.loads(raw[raw.find('{'):])
    except Exception:
        return None, None
    res = d.get('result') or {}
    rows = res.get('data') or []
    # Some result payloads may set an error/status; return None if no rows.
    return {r['tau_days']: r.get('model_midpoint') for r in rows
            if 'tau_days' in r and isinstance(r.get('model_midpoint'), (int, float))}, res

wc, _ = load_curve(sys.argv[1])
cc, cres = load_curve(sys.argv[2])
if wc is None or cc is None:
    print(f"FAIL|load error wc={wc is not None} cc={cc is not None}"); sys.exit(0)
if not cc:
    # cohort(A,…) with A=X may be rejected by the planner; treat as SKIP
    print(f"SKIP|cohort query returned no rows (planner may not support A=X DSL form)")
    sys.exit(0)
if not wc:
    print(f"FAIL|window returned no rows"); sys.exit(0)

common = sorted(set(wc) & set(cc))
if not common:
    print(f"FAIL|no overlap between window and cohort curves"); sys.exit(0)

max_diff = max(abs(wc[t] - cc[t]) for t in common)
tol = 0.01  # 1 absolute percentage point
if max_diff > tol:
    # find worst tau
    worst = max(common, key=lambda t: abs(wc[t]-cc[t]))
    print(f"FAIL|window/cohort differ by {max_diff:.4f} at tau={worst}: w={wc[worst]:.4f} c={cc[worst]:.4f}")
    sys.exit(0)

print(f"PASS|window and cohort agree within {tol:.4f} across {len(common)} taus (max_diff={max_diff:.4f})")
PY
)
  local v="${verdict%%|*}"
  local d="${verdict#*|}"
  _record "$label" "$v" "$d"
}

# I4: window asymptotic midpoint equals p.mean (with evidence)
#
# Contract: on a latency edge, as tau → large, window Y/X converges to
# the edge probability p. With evidence present, v3 window midpoint at
# large tau should match Bayesian p.mean within 10%.
_check_I4() {
  local graph="$1"; local edge_dsl="$2"; local window_range="$3"; local sidecar="$4"; local p_expected="$5"
  local label="I4 [$graph: $edge_dsl]"

  local out="$TMPDIR/i4_window.json"
  if [ -n "$sidecar" ]; then
    _run_v3 "$out" "$graph" "${edge_dsl}.window(${window_range})" --bayes-vars "$sidecar"
  else
    _run_v3 "$out" "$graph" "${edge_dsl}.window(${window_range})"
  fi

  local verdict
  verdict=$(python3 - "$out" "$p_expected" <<'PY'
import json, sys
p = sys.argv[1]; p_exp = float(sys.argv[2])
try:
    raw = open(p).read()
    d = json.loads(raw[raw.find('{'):])
except Exception as e:
    print(f"FAIL|parse error: {e}"); sys.exit(0)

rows = (d.get('result') or {}).get('data') or []
mids = [r.get('midpoint') for r in rows if isinstance(r.get('midpoint'), (int, float))]
if len(mids) < 5:
    print(f"FAIL|insufficient rows ({len(mids)})"); sys.exit(0)

mature = sum(mids[-5:]) / 5
rel_err = abs(mature - p_exp) / max(abs(p_exp), 1e-9)
if rel_err > 0.10:
    print(f"FAIL|mature window midpoint {mature:.4f} diverges from p={p_exp:.4f} ({rel_err:.1%})")
    sys.exit(0)
print(f"PASS|mature window midpoint {mature:.4f} ≈ p={p_exp:.4f} ({rel_err:.1%} off)")
PY
)
  local v="${verdict%%|*}"
  local d="${verdict#*|}"
  _record "$label" "$v" "$d"
}

# I5: cohort never above window (zero-evidence)
#
# Contract: on a single-hop edge, cohort midpoint is never materially
# above window midpoint at any tau, regardless of upstream latency.
# This is a blanket guard against mode-distinction loss manifesting as
# cohort overshooting window.
_check_I5() {
  local graph="$1"; local edge_dsl="$2"; local sidecar="$3"
  local label="I5 [$graph: $edge_dsl]"

  local w_out="$TMPDIR/i5_window.json"
  local c_out="$TMPDIR/i5_cohort.json"
  if [ -n "$sidecar" ]; then
    _run_v3 "$w_out" "$graph" "${edge_dsl}.window(-1d:)" --bayes-vars "$sidecar"
    _run_v3 "$c_out" "$graph" "${edge_dsl}.cohort(-1d:)" --bayes-vars "$sidecar"
  else
    _run_v3 "$w_out" "$graph" "${edge_dsl}.window(-1d:)"
    _run_v3 "$c_out" "$graph" "${edge_dsl}.cohort(-1d:)"
  fi

  local verdict
  verdict=$(python3 - "$w_out" "$c_out" <<'PY'
import json, sys

def load_curve(p):
    try:
        raw = open(p).read()
        d = json.loads(raw[raw.find('{'):])
    except Exception:
        return None
    rows = (d.get('result') or {}).get('data') or []
    return {r['tau_days']: r.get('midpoint') for r in rows
            if 'tau_days' in r and isinstance(r.get('midpoint'), (int, float))}

wc = load_curve(sys.argv[1])
cc = load_curve(sys.argv[2])
if not wc or not cc:
    print(f"FAIL|missing data wc={bool(wc)} cc={bool(cc)}"); sys.exit(0)

common = sorted(set(wc) & set(cc))
if not common:
    print(f"FAIL|no tau overlap"); sys.exit(0)

eps = 0.03  # generous tolerance for MC noise
violations = [(t, cc[t], wc[t]) for t in common if cc[t] > wc[t] + eps]
if violations:
    t, c, w = violations[0]
    print(f"FAIL|cohort above window at tau={t}: cohort={c:.4f} window={w:.4f} (first of {len(violations)}/{len(common)})")
    sys.exit(0)

print(f"PASS|cohort ≤ window + {eps} at all {len(common)} shared taus")
PY
)
  local v="${verdict%%|*}"
  local d="${verdict#*|}"
  _record "$label" "$v" "$d"
}

# ── Run ───────────────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════════════════"
echo "  v3 degeneracy invariants — outside-in CLI harness"
echo "══════════════════════════════════════════════════════════════"
echo ""

echo "── Preflight ──"
_ensure_synth_data synth-mirror-4step
_ensure_synth_data synth-lat4

SIDECAR_M4="$_DAGNET_ROOT/bayes/fixtures/synth-mirror-4step.bayes-vars.json"
if [ ! -f "$SIDECAR_M4" ]; then
  echo "  WARN: Bayes-vars sidecar for synth-mirror-4step not found — I1/I2/I3/I4/I5 will run with analytic vars only"
  SIDECAR_M4=""
fi

# synth-lat4: no sidecar assumed; analytic only.
SIDECAR_LAT4=""

echo ""
echo "── Invariants ──"
echo ""

# Terminal edge on synth-mirror-4step — anchor m4-landing is 4 hops upstream
M4_TERMINAL="from(m4-registered).to(m4-success)"

# synth-lat4 b→c edge — anchor a is 1 hop upstream of b; strong latency all round
LAT4_BC="from(synth-lat4-b).to(synth-lat4-c)"

# I1 — zero-evidence window on a latency edge with upstream latency
_check_I1 synth-mirror-4step "$M4_TERMINAL" "$SIDECAR_M4"
_check_I1 synth-lat4 "$LAT4_BC" "$SIDECAR_LAT4"

# I2 — zero-evidence cohort must lag window when upstream latency is non-trivial
_check_I2 synth-mirror-4step "$M4_TERMINAL" "$SIDECAR_M4"
_check_I2 synth-lat4 "$LAT4_BC" "$SIDECAR_LAT4"

# I3 — cohort with A=X collapses to window
_check_I3 synth-mirror-4step "m4-registered" "m4-success" "$SIDECAR_M4"
_check_I3 synth-lat4 "synth-lat4-b" "synth-lat4-c" "$SIDECAR_LAT4"

# I4 — window asymptote equals posterior p.mean (with evidence)
# synth-mirror-4step: terminal edge truth p=0.7; Bayesian posterior p=0.7101.
# Use absolute frontier with asat=22-Mar-26 so evidence binds.
_check_I4 synth-mirror-4step "$M4_TERMINAL" "1-Mar-26:22-Mar-26.asat(22-Mar-26)" "$SIDECAR_M4" "0.7"

# I5 — cohort never above window, zero-evidence
_check_I5 synth-mirror-4step "$M4_TERMINAL" "$SIDECAR_M4"
_check_I5 synth-lat4 "$LAT4_BC" "$SIDECAR_LAT4"

# ── Summary ───────────────────────────────────────────────────────────

TOTAL=$((PASS + FAIL))
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Results: $PASS pass / $FAIL fail / $SKIP skip   (of $TOTAL scored)"
echo "══════════════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failing invariants:"
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r v l d <<< "$r"
    [ "$v" = "FAIL" ] && echo "  ✗ $l: $d"
  done
fi

exit "$FAIL"

# ── Notes for maintainers ─────────────────────────────────────────────
#
# Why this harness exists
#   The v3 chart path has been observed to lose mode distinction between
#   window() and cohort() under specific conditions (see doc 65). Without
#   outside-in invariants, regressions are hard to detect because the
#   model-curve numbers look plausible individually.
#
# Adding a new invariant
#   Write a `_check_IN` function following the same pattern: take the
#   required graph/DSL/sidecar arguments, call _run_v3 to capture a JSON
#   result, pipe it through a python3 heredoc that prints PASS|detail
#   or FAIL|detail on stdout, record via _record. Keep heredocs readable
#   and prefer qualitative shape checks over point-comparisons.
#
# Tolerances
#   Generous where the invariant is qualitative (I1 curve rises, I5 no
#   overshoot). Tight where the contract is numeric (I3 A=X exact agreement,
#   I4 asymptote).
#
# Fixtures
#   synth-mirror-4step for primary coverage (linear chain, mixed latency,
#   sidecar available). synth-lat4 for the all-latency divergence case.
#   Keep fixtures stable per doc 60 §"Rationale for the designated graphs".
