#!/usr/bin/env bash
# cohort_maturity no-evidence degeneration contract test.
#
# Invariant: at a public-tooling no-evidence limit, the cohort_maturity
# result should collapse onto one model-only forecast family:
#   - conditioned row midpoint (`midpoint`)
#   - forecast-only row midpoint (`model_midpoint`)
#   - metadata overlay curve (`metadata.model_curves[*].curve`)
# must all coincide, while the raw evidence curve remains absent.
#
# This test intentionally uses `analyse.sh`, not a direct Python handler
# call, so it exercises the same FE preparation + BE analysis path the UI
# uses.
#
# Fixture:
#   synth-mirror-4step with an early `asat(1-Feb-26)` over a window that
#   still yields non-empty rows. At this boundary the analysis returns rows
#   but `evidence_x` / `evidence_y` stay null, giving a real public-tooling
#   degeneration limit.
#
# Usage:
#   bash graph-ops/scripts/cohort-maturity-no-evidence-test.sh

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use "$(cat "$_DAGNET_ROOT/graph-editor/.nvmrc")" >/dev/null 2>/dev/null || true
fi

GRAPH="synth-mirror-4step"
WINDOW="31-Jan-26:15-Mar-26"
ASAT="1-Feb-26"
EPS="1e-6"
TMP_DIR="${TMPDIR:-/tmp}/cohort-maturity-no-evidence-$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

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

run_case() {
  local case_name="$1"
  local dsl="$2"
  local out="$TMP_DIR/${case_name}.json"

  bash graph-ops/scripts/analyse.sh "$GRAPH" "$dsl" \
    --type cohort_maturity --no-snapshot-cache --format json \
    --get "result" 2>/dev/null | grep -v "^Now using node" > "$out" || {
      fail_test "${case_name}" "analyse.sh failed to produce output"
      return
    }

  local rc=0
  python3 - "$out" "$case_name" "$EPS" <<'PYEOF' || rc=$?
import json
import math
import sys

out_path, case_name, eps_s = sys.argv[1:4]
eps = float(eps_s)

with open(out_path) as f:
    try:
        d = json.load(f)
    except Exception as e:
        print(f"  FAIL: {case_name} — invalid JSON output: {e}")
        sys.exit(2)

rows = d.get("data") or []
if not rows:
    print(f"  FAIL: {case_name} — result.data is empty")
    sys.exit(1)

model_curves = (d.get("metadata") or {}).get("model_curves") or {}
if not model_curves:
    print(f"  FAIL: {case_name} — metadata.model_curves missing")
    sys.exit(1)

entry = next(iter(model_curves.values()))
curve = entry.get("curve") or []
curve_by_tau = {
    int(p["tau_days"]): float(p["model_rate"])
    for p in curve
    if p.get("tau_days") is not None and p.get("model_rate") is not None
}
if not curve_by_tau:
    print(f"  FAIL: {case_name} — promoted overlay curve is empty")
    sys.exit(1)

eligible = []
for row in rows:
    tau = row.get("tau_days")
    midpoint = row.get("midpoint")
    model_midpoint = row.get("model_midpoint")
    if tau is None or midpoint is None or model_midpoint is None:
        continue
    tau = int(tau)
    overlay = curve_by_tau.get(tau)
    if overlay is None:
        continue
    # Skip the dead/zero segment before the model has risen; it is
    # mechanically equal and not informative for degeneration checks.
    if max(abs(float(midpoint)), abs(float(model_midpoint)), abs(float(overlay))) < 1e-4:
        continue
    eligible.append({
        "tau": tau,
        "midpoint": float(midpoint),
        "model_midpoint": float(model_midpoint),
        "overlay": float(overlay),
        "evidence_x": row.get("evidence_x"),
        "evidence_y": row.get("evidence_y"),
        "fan_upper": row.get("fan_upper"),
        "model_fan_upper": row.get("model_fan_upper"),
        "fan_lower": row.get("fan_lower"),
        "model_fan_lower": row.get("model_fan_lower"),
    })

if len(eligible) < 5:
    print(f"  FAIL: {case_name} — only {len(eligible)} informative rows found")
    sys.exit(1)

print(f"  informative rows: {len(eligible)}")
print(f"  {'tau':>4}  {'midpoint':>12}  {'model_mid':>12}  {'overlay':>12}")

violations = []
for row in eligible[:8]:
    print(
        f"  {row['tau']:4d}  {row['midpoint']:12.8f}  "
        f"{row['model_midpoint']:12.8f}  {row['overlay']:12.8f}"
    )

for row in eligible:
    tau = row["tau"]
    midpoint = row["midpoint"]
    model_midpoint = row["model_midpoint"]
    overlay = row["overlay"]

    if row["evidence_x"] is not None or row["evidence_y"] is not None:
        violations.append(
            f"tau={tau}: expected evidence_x/evidence_y to be null, got "
            f"{row['evidence_x']!r}/{row['evidence_y']!r}"
        )

    if abs(midpoint - model_midpoint) > eps:
        violations.append(
            f"tau={tau}: midpoint={midpoint:.8f} != model_midpoint={model_midpoint:.8f}"
        )

    if abs(overlay - model_midpoint) > eps:
        violations.append(
            f"tau={tau}: overlay={overlay:.8f} != model_midpoint={model_midpoint:.8f}"
        )

    fu = row["fan_upper"]
    mfu = row["model_fan_upper"]
    fl = row["fan_lower"]
    mfl = row["model_fan_lower"]
    if fu is not None and mfu is not None and abs(float(fu) - float(mfu)) > eps:
        violations.append(
            f"tau={tau}: fan_upper={float(fu):.8f} != model_fan_upper={float(mfu):.8f}"
        )
    if fl is not None and mfl is not None and abs(float(fl) - float(mfl)) > eps:
        violations.append(
            f"tau={tau}: fan_lower={float(fl):.8f} != model_fan_lower={float(mfl):.8f}"
        )

if violations:
    print(f"  FAIL: {case_name} — degeneration invariant violated:")
    for issue in violations[:10]:
        print(f"    {issue}")
    sys.exit(1)

print(f"  PASS: {case_name} — midpoint/model_midpoint/overlay collapse with null evidence")
PYEOF

  if [ $rc -eq 0 ]; then
    pass_test "${case_name}"
  else
    fail_test "${case_name}" "degeneration invariant failed"
  fi
}

echo "══════════════════════════════════════════════════════════════"
echo " cohort_maturity no-evidence degeneration contract test"
echo " Graph: ${GRAPH}"
echo " Window: ${WINDOW}  asat: ${ASAT}"
echo "══════════════════════════════════════════════════════════════"
echo ""

run_case "window_single_hop" \
  "from(m4-delegated).to(m4-registered).window(${WINDOW}).asat(${ASAT})"

run_case "cohort_single_hop" \
  "from(m4-delegated).to(m4-registered).cohort(${WINDOW}).asat(${ASAT})"

run_case "window_multi_hop" \
  "from(m4-created).to(m4-success).window(${WINDOW}).asat(${ASAT})"

run_case "cohort_multi_hop" \
  "from(m4-created).to(m4-success).cohort(${WINDOW}).asat(${ASAT})"

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
