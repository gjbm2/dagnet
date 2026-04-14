#!/usr/bin/env bash
# Latency reparam regression — doc 34 §11.8/§11.9.
# Calls run_regression.py three times with different feature flags.
#
# Usage:
#   scripts/run-reparam-regression.sh
set -uo pipefail  # no -e: individual runs may fail (expected MISSes)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
eval ". ${REPO_ROOT}/graph-editor/venv/bin/activate"
cd "$REPO_ROOT"

FAILURES=0

echo "=== A: baseline (no reparam) ==="
python bayes/run_regression.py \
  --draws 2000 --tune 2000 --chains 4 --max-parallel 1 --no-timeout \
  || FAILURES=$((FAILURES + 1))

echo ""
echo "=== B: reparam, 2 slice latency RVs (m + r offsets) ==="
python bayes/run_regression.py \
  --draws 2000 --tune 2000 --chains 4 --max-parallel 1 --no-timeout \
  --feature latency_reparam=true --feature latency_reparam_slices=2 \
  || FAILURES=$((FAILURES + 1))

echo ""
echo "=== C: reparam, 1 slice latency RV (m offset only) ==="
python bayes/run_regression.py \
  --draws 2000 --tune 2000 --chains 4 --max-parallel 1 --no-timeout \
  --feature latency_reparam=true --feature latency_reparam_slices=1 \
  || FAILURES=$((FAILURES + 1))

echo ""
echo "=== ALL THREE CONFIGS COMPLETE (${FAILURES} configs had failures) ==="
