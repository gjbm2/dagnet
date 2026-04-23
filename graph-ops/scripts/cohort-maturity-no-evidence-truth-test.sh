#!/usr/bin/env bash
# cohort_maturity zero-evidence truth-degeneracy canary.
#
# Exercises the public CLI tooling (`analyse.sh`) on a stable synth
# no-evidence boundary and asserts that the exposed chart/model curves are
# approximately the analytic `p × CDF(tau)` implied by the synth truth.
#
# Why this exists:
#   - the direct Python contract test locks the `fe is None` logic path
#   - this script locks the FE/CLI/analysis stack on the same invariant
#
# Fixture:
#   synth-mirror-4step, single edge m4-delegated -> m4-registered
#   query: window(31-Jan-26:15-Mar-26).asat(1-Feb-26)
#
# Usage:
#   bash graph-ops/scripts/cohort-maturity-no-evidence-truth-test.sh

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use "$(cat "$_DAGNET_ROOT/graph-editor/.nvmrc")" >/dev/null 2>/dev/null || true
fi

GRAPH="synth-mirror-4step"
EDGE_NAME="m4-delegated-to-registered"
QUERY="from(m4-delegated).to(m4-registered).window(31-Jan-26:15-Mar-26).asat(1-Feb-26)"
TRUTH_FILE="$_DAGNET_ROOT/bayes/truth/synth-mirror-4step.truth.yaml"
SIDECAR_FILE="$_DAGNET_ROOT/bayes/fixtures/synth-mirror-4step.bayes-vars.json"
PYTHON_BIN="$_DAGNET_ROOT/graph-editor/venv/bin/python3"
TMP_DIR="$(mktemp -d)"
OUT_FILE="$TMP_DIR/cli.json"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ ! -f "$TRUTH_FILE" ]; then
  echo "FAIL: truth file not found: $TRUTH_FILE"
  exit 1
fi

if [ ! -f "$SIDECAR_FILE" ]; then
  echo "FAIL: Bayes sidecar not found: $SIDECAR_FILE"
  exit 1
fi

echo "══════════════════════════════════════════════════════════════"
echo " cohort_maturity zero-evidence truth-degeneracy canary"
echo " Graph: ${GRAPH}"
echo " Query: ${QUERY}"
echo " Truth edge: ${EDGE_NAME}"
echo "══════════════════════════════════════════════════════════════"
echo ""

echo "── Preflight ──"
(
  cd "$_DAGNET_ROOT"
  DB_CONNECTION="$(grep DB_CONNECTION graph-editor/.env.local | cut -d= -f2-)" \
    PYTHONPATH="$_DAGNET_ROOT" \
    "$PYTHON_BIN" bayes/synth_gen.py --graph "$GRAPH" --write-files --enrich \
    >/dev/null 2>&1
) || {
  echo "FAIL: synth preflight failed for $GRAPH"
  exit 1
}
echo "  synth fixture ensured"
echo ""

echo "── CLI Probe ──"
bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH" "$QUERY" \
  --type cohort_maturity \
  --no-cache \
  --no-snapshot-cache \
  --format json \
  --bayes-vars "$SIDECAR_FILE" \
  2>/dev/null | sed '/^Now using node/d' > "$OUT_FILE" || {
    echo "FAIL: analyse.sh did not produce JSON output"
    exit 1
  }
echo "  CLI output captured"
echo ""

echo "── Invariant ──"
"$PYTHON_BIN" - "$OUT_FILE" "$TRUTH_FILE" "$EDGE_NAME" <<'PY'
import json
import math
import sys

import yaml

out_path, truth_path, edge_name = sys.argv[1:4]
TOL = 0.012
COLLAPSE_TOL = 1e-6
MIN_EXPECTED = 0.003

with open(out_path) as f:
    raw = f.read()
try:
    payload = json.loads(raw[raw.find("{"):])
except Exception as exc:
    print(f"FAIL: invalid JSON output: {exc}")
    sys.exit(1)

result = payload.get("result") or payload
rows = result.get("data") or []
if not rows:
    print("FAIL: result.data is empty")
    sys.exit(1)

model_curves = (result.get("metadata") or {}).get("model_curves") or {}
if not model_curves:
    print("FAIL: metadata.model_curves missing")
    sys.exit(1)

curve_entry = next(iter(model_curves.values()))
curve = curve_entry.get("curve") or []
curve_by_tau = {
    int(point["tau_days"]): float(point["model_rate"])
    for point in curve
    if point.get("tau_days") is not None and point.get("model_rate") is not None
}
if not curve_by_tau:
    print("FAIL: promoted overlay curve is empty")
    sys.exit(1)

truth = yaml.safe_load(open(truth_path))
edge = (truth.get("edges") or {}).get(edge_name)
if edge is None:
    print(f"FAIL: truth edge {edge_name!r} missing from {truth_path}")
    sys.exit(1)

p = float(edge["p"])
mu = float(edge["mu"])
sigma = float(edge["sigma"])
onset = float(edge["onset"])

def shifted_lognormal_cdf(tau: int) -> float:
    model_age = float(tau) - onset
    if model_age <= 0 or sigma <= 0:
        return 0.0
    z = (math.log(model_age) - mu) / sigma
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))

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
    expected = p * shifted_lognormal_cdf(tau)
    if expected < MIN_EXPECTED:
        continue
    eligible.append({
        "tau": tau,
        "midpoint": float(midpoint),
        "model_midpoint": float(model_midpoint),
        "overlay": float(overlay),
        "expected": float(expected),
        "evidence_x": row.get("evidence_x"),
        "evidence_y": row.get("evidence_y"),
    })

if len(eligible) < 8:
    print(f"FAIL: only {len(eligible)} informative rows found")
    sys.exit(1)

print(f"  informative rows: {len(eligible)}")
print(f"  {'tau':>4}  {'midpoint':>12}  {'model_mid':>12}  {'overlay':>12}  {'expected':>12}")
for row in eligible[:8]:
    print(
        f"  {row['tau']:4d}  {row['midpoint']:12.8f}  {row['model_midpoint']:12.8f}  "
        f"{row['overlay']:12.8f}  {row['expected']:12.8f}"
    )

violations = []
for row in eligible:
    tau = row["tau"]
    midpoint = row["midpoint"]
    model_midpoint = row["model_midpoint"]
    overlay = row["overlay"]
    expected = row["expected"]
    evidence_x = row["evidence_x"]
    evidence_y = row["evidence_y"]

    if evidence_x is not None or evidence_y is not None:
        violations.append(
            f"tau={tau}: expected null evidence, got evidence_x/evidence_y="
            f"{evidence_x!r}/{evidence_y!r}"
        )

    if abs(midpoint - model_midpoint) > COLLAPSE_TOL:
        violations.append(
            f"tau={tau}: midpoint={midpoint:.8f} != model_midpoint={model_midpoint:.8f}"
        )

    if abs(overlay - model_midpoint) > COLLAPSE_TOL:
        violations.append(
            f"tau={tau}: overlay={overlay:.8f} != model_midpoint={model_midpoint:.8f}"
        )

    if abs(midpoint - expected) > TOL:
        violations.append(
            f"tau={tau}: midpoint={midpoint:.8f} differs from expected={expected:.8f}"
        )

    if abs(model_midpoint - expected) > TOL:
        violations.append(
            f"tau={tau}: model_midpoint={model_midpoint:.8f} differs from expected={expected:.8f}"
        )

    if abs(overlay - expected) > TOL:
        violations.append(
            f"tau={tau}: overlay={overlay:.8f} differs from expected={expected:.8f}"
        )

if violations:
    print("FAIL: truth-degeneracy invariant violated:")
    for issue in violations[:12]:
        print(f"  {issue}")
    sys.exit(1)

print(
    f"PASS: public no-evidence curve matches truth-backed analytic p×CDF "
    f"within {TOL:.3f} on {len(eligible)} taus"
)
PY
