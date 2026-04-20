#!/usr/bin/env bash
# cohort_maturity main-midline == promoted-overlay contract test.
#
# Invariant: in f-view the main chart's model_midpoint (unconditioned sweep
# midline, p × CDF_path(τ) with no evidence conditioning) must equal the
# promoted source's model_curve overlay at every τ.
#
# Rationale: the unconditioned sweep and the overlay both plot the same
# quantity — p × CDF from the resolved params. Bands differ legitimately
# (main fan = predictive via alpha_pred + latency dispersions; overlay
# bands = epistemic), but midlines must match because they are the same
# mathematical construction.
#
# If this invariant fails, the overlay is drawing a different path CDF than
# the main chart — typically because the overlay reads a single `path_mu`
# scalar from the posterior rather than composing the per-edge FW path CDF
# used by the main chart's sweep engine.
#
# Red test: currently FAILS for cohort() mode with anchor != from_node
# (widened-span case). Passes for window mode. Should pass for all cases
# after the overlay composes A→Y path CDF via compose_span_kernel_for_source,
# matching the main chart's path-CDF construction.
#
# Prerequisites:
#   - Python BE running (dev-server.py on localhost:9000)
#   - synth-mirror-4step generated:
#       cd graph-editor && . venv/bin/activate
#       DB_CONNECTION="$(grep DB_CONNECTION .env.local | cut -d= -f2-)" \
#         python ../bayes/synth_gen.py --graph synth-mirror-4step --write-files
#
# Usage:
#   bash graph-ops/scripts/cohort-maturity-model-parity-test.sh

set -uo pipefail

. "$(dirname "$0")/_load-conf.sh"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use "$(cat "$_DAGNET_ROOT/graph-editor/.nvmrc")" >/dev/null 2>/dev/null || true
fi

GRAPH="synth-mirror-4step"
TMP_DIR="${TMPDIR:-/tmp}/cohort-maturity-parity-$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

# synth-mirror-4step topology (latency edges only — cohort_maturity
# requires latency > 0):
#   m4-delegated → m4-registered (LATENCY)
#   m4-registered → m4-success   (LATENCY)
# Anchor for cohort() is the furthest-upstream START node (m4-landing),
# so cohort() on any of these edges invokes the widened-span path (A ≠ X).

# Relative-tolerance threshold for midline == overlay match.
# Small numerical drift from MC is acceptable; ~350% divergence (the
# current bug) is not.
EPS_REL="0.001"  # 0.1% relative difference at each τ (post-P0: overlay uses
                 # main's own MC draws, so divergence is float precision)
EPS_ABS="1e-6"   # absolute floor for near-zero rates

PASS=0
FAIL=0
ERRORS=""

pass_test() {
  PASS=$((PASS + 1))
  echo "  PASS: $1"
}

fail_test() {
  FAIL=$((FAIL + 1))
  ERRORS="${ERRORS}\n  FAIL: $1 — $2"
  echo "  FAIL: $1 — $2"
}

echo "══════════════════════════════════════════════════════════════"
echo " cohort_maturity model-parity contract test"
echo " Invariant: main.model_midpoint[τ] == overlay.model_rate[τ]"
echo " Graph: ${GRAPH}"
echo "══════════════════════════════════════════════════════════════"

run_case() {
  local case_name="$1"
  local dsl="$2"

  echo ""
  echo "── ${case_name} ─────────────────────────────────────────────"
  echo "   DSL: ${dsl}"

  local out="$TMP_DIR/${case_name// /_}.json"
  # Strip nvm banner by skipping the first line (it starts with "Now using node")
  bash graph-ops/scripts/analyse.sh "$GRAPH" "$dsl" \
    --type cohort_maturity --no-snapshot-cache --format json \
    --get "result" 2>/dev/null | grep -v "^Now using node" > "$out" || {
      fail_test "${case_name}" "analyse.sh failed to produce output"
      return
    }

  local rc=0
  python3 - "$out" "$case_name" "$EPS_REL" "$EPS_ABS" <<'PYEOF' || rc=$?
import json, sys

out_path, case_name, eps_rel_s, eps_abs_s = sys.argv[1:5]
eps_rel = float(eps_rel_s)
eps_abs = float(eps_abs_s)

with open(out_path) as f:
    try:
        d = json.load(f)
    except Exception as e:
        print(f"  FAIL: {case_name} — invalid JSON output: {e}")
        sys.exit(2)

mc = (d.get('metadata') or {}).get('model_curves') or {}
if not mc:
    print(f"  FAIL: {case_name} — no model_curves in metadata")
    sys.exit(2)

# Take the single key (one scenario × one subject in these tests)
key = list(mc.keys())[0]
entry = mc[key]
curve = entry.get('curve') or []
promoted = entry.get('promotedSource') or (d.get('metadata') or {}).get('promoted_source')
overlay_by_tau = {int(c['tau_days']): float(c['model_rate']) for c in curve
                  if c.get('model_rate') is not None}

# Sanity gate: per-source curve asymptotes must approach their own
# per-source forecast_mean (edge rate), not a path-cumulative probability.
# A widened-span bug silently scales per-source curves by A→Y cumulative
# p instead of target-edge p, leaving them stuck near zero. Catch that
# by checking each source's curve peak is within a reasonable factor of
# its forecast_mean.
source_curves = entry.get('sourceModelCurves') or {}
source_curve_issues = []
for src_name, src_entry in source_curves.items():
    src_curve = src_entry.get('curve') or []
    src_params = src_entry.get('params') or {}
    src_fm = src_params.get('forecast_mean')
    if src_fm is None or not src_curve:
        continue
    src_rates = [c.get('model_rate') for c in src_curve if c.get('model_rate') is not None]
    if not src_rates:
        continue
    peak = max(src_rates)
    # Asymptote should approach forecast_mean (edge rate). Accept anything
    # above half of forecast_mean as "meaningfully rising". If peak is
    # < 10% of forecast_mean, something is suppressing the curve —
    # almost certainly a scaling bug.
    if src_fm > 0 and peak < 0.1 * src_fm:
        source_curve_issues.append(
            f"{src_name}: peak={peak:.6f} but forecast_mean={src_fm:.6f} "
            f"(<10% of expected asymptote — likely p-scaling bug)"
        )

rows = d.get('data') or []
midline_by_tau = {int(r['tau_days']): r.get('model_midpoint') for r in rows
                  if r.get('tau_days') is not None}

if not overlay_by_tau:
    print(f"  FAIL: {case_name} — overlay curve empty (promoted={promoted})")
    sys.exit(2)
if not midline_by_tau:
    print(f"  FAIL: {case_name} — main chart has no model_midpoint rows")
    sys.exit(2)

# Evaluate at representative taus present in BOTH series
common_taus = sorted(set(overlay_by_tau) & set(midline_by_tau))
if not common_taus:
    print(f"  FAIL: {case_name} — no common τ between overlay and midline")
    sys.exit(2)

# Sample taus: asymptote, mid-rise, early. Filter to common_taus present.
tau_max = max(common_taus)
sample_candidates = [1, 5, 10, 15, 20, 25, 30,
                     tau_max // 2, tau_max - 1]
sample_taus = sorted(set(t for t in sample_candidates if t in overlay_by_tau and t in midline_by_tau))
if not sample_taus:
    sample_taus = common_taus[: min(10, len(common_taus))]

worst_tau = None
worst_rel = 0.0
failures = []

print(f"  Promoted source: {promoted}")
print(f"  τ in [{min(common_taus)}, {tau_max}], sampling {len(sample_taus)} points")
print(f"  {'τ':>4}  {'overlay':>10}  {'midline':>10}  {'abs_diff':>10}  {'rel_diff':>8}")

for t in sample_taus:
    o = overlay_by_tau[t]
    m = midline_by_tau[t]
    if m is None:
        continue
    m = float(m)
    abs_diff = abs(m - o)
    denom = max(abs(o), abs(m), eps_abs)
    rel_diff = abs_diff / denom
    marker = ' '
    if abs_diff > eps_abs and rel_diff > eps_rel:
        marker = '!'
        failures.append((t, o, m, rel_diff))
    if rel_diff > worst_rel:
        worst_rel = rel_diff
        worst_tau = t
    print(f" {marker}{t:>4}  {o:>10.6f}  {m:>10.6f}  {abs_diff:>10.6f}  {rel_diff*100:>7.2f}%")

if source_curve_issues:
    print(f"  FAIL: {case_name} — per-source scaling issues:")
    for issue in source_curve_issues:
        print(f"    {issue}")
    sys.exit(1)

if failures:
    print(f"  FAIL: {case_name} — {len(failures)} τ violate invariant "
          f"(worst: τ={worst_tau}, rel={worst_rel*100:.2f}%). "
          "Overlay path CDF diverges from main chart sweep.")
    sys.exit(1)
else:
    print(f"  PASS: {case_name} — midline matches overlay within {eps_rel*100:.1f}% "
          f"(worst: τ={worst_tau}, rel={worst_rel*100:.2f}%); "
          f"{len(source_curves)} per-source curves scaled correctly")
    sys.exit(0)
PYEOF

  if [ $rc -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: ${case_name}"
  fi
}

# ── Case 1: Window mode, single-hop ───────────────────────────────────────
# Edge-local latency. Baseline: should already match.
run_case "window_single_hop" \
  "from(m4-delegated).to(m4-registered).window(-90d:)"

# ── Case 2: Cohort mode, single-hop, anchor != from_node (widened span) ─
# The current failing case. Main chart composes A→Y path CDF via
# mc_span_cdfs; overlay reads path_mu from model_vars (different value).
run_case "cohort_single_hop_widened" \
  "from(m4-delegated).to(m4-registered).cohort(-90d:)"

# ── Case 3: Cohort mode, multi-hop ────────────────────────────────────────
# Overlay already uses compose_span_kernel_for_source here; should match.
run_case "cohort_multi_hop" \
  "from(m4-created).to(m4-success).cohort(-90d:)"

# ── Case 4: Window mode, multi-hop ────────────────────────────────────────
run_case "window_multi_hop" \
  "from(m4-created).to(m4-success).window(-90d:)"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Results: ${PASS} passed, ${FAIL} failed"
if [ $FAIL -gt 0 ]; then
  echo ""
  echo " Failures:"
  echo -e "$ERRORS"
fi
echo "══════════════════════════════════════════════════════════════"

exit $FAIL
