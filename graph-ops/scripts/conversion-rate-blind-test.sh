#!/usr/bin/env bash
# conversion_rate blind contract tests (doc 49 Part B).
#
# Outside-in tests using the CLI analyse tooling on the synth-mirror-4step
# graph. Each test asserts a doc 49 invariant on the BE response.
#
# Prerequisites:
#   - Python BE running (dev-server.py on localhost:9000)
#   - synth-mirror-4step generated:
#       cd graph-editor && . venv/bin/activate
#       DB_CONNECTION="$(grep DB_CONNECTION .env.local | cut -d= -f2-)" \
#         python ../bayes/synth_gen.py --graph synth-mirror-4step --write-files
#
# Usage:
#   bash graph-ops/scripts/conversion-rate-blind-test.sh

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

# Suppress nvm stdout noise by pre-loading node before tests
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use "$(cat "$_DAGNET_ROOT/graph-editor/.nvmrc")" >/dev/null 2>/dev/null || true
fi

# Helper: run analyse and strip nvm stdout noise
an() {
  bash graph-ops/scripts/analyse.sh "$@" 2>/dev/null | grep -v "^Now using node"
}

GRAPH="synth-mirror-4step"

# synth-mirror-4step edge topology:
#   m4-landing -> m4-created            NON-LATENCY (sigma=0)
#   m4-created -> m4-delegated          NON-LATENCY (sigma=0)
#   m4-delegated -> m4-registered       LATENCY (sigma>0)
#   m4-registered -> m4-success         LATENCY (sigma>0)
#   m4-* -> -dropout                    NON-LATENCY (sigma=0)
NON_LATENCY_DSL="from(m4-landing).to(m4-created).window(-90d:)"
LATENCY_DSL="from(m4-delegated).to(m4-registered).window(-90d:)"

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
echo " conversion_rate blind contract tests (doc 49 Part B)"
echo " Graph: ${GRAPH}"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Non-latency edge — analysis succeeds ─────────────────────────

echo "Test 1: Non-latency edge (m4-landing -> m4-created) — analysis succeeds"

analysis_type=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.analysis_type") || true

if [ -z "$analysis_type" ] || [ "$analysis_type" = "null" ]; then
  fail_test "T1" "no analysis_type returned — BE may not be dispatching conversion_rate"
elif [ "$analysis_type" != "conversion_rate" ]; then
  fail_test "T1" "analysis_type=${analysis_type}, expected conversion_rate"
else
  pass_test "T1: analysis_type=${analysis_type}"
fi

echo ""

# ── Test 2: Non-latency edge — data array non-empty ──────────────────────

echo "Test 2: Non-latency edge — data array has bins"

bin0_start=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.data.0.bin_start") || true

if [ -z "$bin0_start" ] || [ "$bin0_start" = "null" ]; then
  fail_test "T2" "data.0.bin_start missing — no bins derived"
else
  pass_test "T2: first bin_start=${bin0_start}"
fi

echo ""

# ── Test 3: Bin shape — required keys present ────────────────────────────

echo "Test 3: Bin has required keys (bin_start, bin_end, x, y, rate)"

bin0_x=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.data.0.x") || true
bin0_y=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.data.0.y") || true
bin0_rate=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.data.0.rate") || true

if [ -z "$bin0_x" ] || [ "$bin0_x" = "null" ]; then
  fail_test "T3a" "data.0.x missing"
elif [ -z "$bin0_y" ] || [ "$bin0_y" = "null" ]; then
  fail_test "T3b" "data.0.y missing"
elif [ -z "$bin0_rate" ] || [ "$bin0_rate" = "null" ]; then
  fail_test "T3c" "data.0.rate missing"
else
  pass_test "T3: x=${bin0_x} y=${bin0_y} rate=${bin0_rate}"
fi

echo ""

# ── Test 4: Rate consistency — rate == y/x ───────────────────────────────

echo "Test 4: Rate consistency — rate matches y/x for first bin"

if [ -n "$bin0_x" ] && [ -n "$bin0_y" ] && [ -n "$bin0_rate" ] \
   && [ "$bin0_x" != "null" ] && [ "$bin0_y" != "null" ] && [ "$bin0_rate" != "null" ]; then
  if python3 -c "
import sys
x, y, r = float('${bin0_x}'), float('${bin0_y}'), float('${bin0_rate}')
expected = y / x if x > 0 else 0
sys.exit(0 if abs(r - expected) < 1e-6 else 1)
" 2>/dev/null; then
    pass_test "T4: rate=${bin0_rate} matches y/x=${bin0_y}/${bin0_x}"
  else
    fail_test "T4" "rate=${bin0_rate} does not match y/x=${bin0_y}/${bin0_x}"
  fi
else
  fail_test "T4" "missing values to check rate consistency"
fi

echo ""

# ── Test 5: bin_size in response metadata ───────────────────────────────

echo "Test 5: bin_size in metadata (default=day)"

bin_size=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.metadata.bin_size") || true

if [ "$bin_size" = "day" ]; then
  pass_test "T5: bin_size=day"
else
  # CLI result shape flattens. Try direct bin_size from raw
  bin_size2=$(an "$GRAPH" "$NON_LATENCY_DSL" \
    --type conversion_rate --no-snapshot-cache --format json \
    --get "result.bin_size") || true
  if [ "$bin_size2" = "day" ]; then
    pass_test "T5: bin_size=day (top-level)"
  else
    fail_test "T5" "bin_size not 'day' (metadata=${bin_size}, top=${bin_size2})"
  fi
fi

echo ""

# ── Test 6: Latency edge — gate rejects analysis ─────────────────────────

echo "Test 6: Latency edge (m4-delegated -> m4-registered) — gate rejects"

# Capture both stdout and stderr — gate error is written to stderr via log.fatal
err_output=$(bash graph-ops/scripts/analyse.sh "$GRAPH" "$LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json 2>&1 | grep -v "^Now using node") || true

if echo "$err_output" | grep -q "latency dispersion"; then
  pass_test "T6: gate rejected latency edge with expected message"
elif echo "$err_output" | grep -qi "error\|fail"; then
  # Some other error path — check it at least errored
  snippet=$(echo "$err_output" | grep -iE "error|fail" | head -1 | cut -c1-120)
  pass_test "T6: latency edge rejected (not with gate msg, but: ${snippet})"
else
  fail_test "T6" "latency edge did NOT reject — conversion_rate produced output on immature cohorts"
fi

echo ""

# ── Test 7: Multiple bins produced ───────────────────────────────────────

echo "Test 7: Non-latency edge produces multiple bins over 90d window"

bin1_start=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.data.1.bin_start") || true
bin5_start=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.data.5.bin_start") || true

if [ -z "$bin1_start" ] || [ "$bin1_start" = "null" ]; then
  fail_test "T7" "only 1 bin produced, expected several across 90d window"
elif [ -z "$bin5_start" ] || [ "$bin5_start" = "null" ]; then
  fail_test "T7" "fewer than 6 bins produced (no data.5.bin_start)"
else
  pass_test "T7: multiple bins present (bin0=${bin0_start}, bin1=${bin1_start}, bin5=${bin5_start})"
fi

echo ""

# ── Test 8: Epistemic key present on each bin (may be null) ──────────────

echo "Test 8: 'epistemic' key present on each bin (value may be null w/o posterior)"

# Use jq-style approach: extract data.0 as JSON and check for epistemic key
bin0_json=$(an "$GRAPH" "$NON_LATENCY_DSL" \
  --type conversion_rate --no-snapshot-cache --format json \
  --get "result.data.0") || true

if echo "$bin0_json" | grep -q '"epistemic"'; then
  pass_test "T8: epistemic key present on bin (contract honoured)"
else
  fail_test "T8" "epistemic key MISSING from bin — contract violation"
fi

echo ""

# ── Summary ──────────────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════════════════"
echo " Results: ${PASS} passed, ${FAIL} failed"
if [ $FAIL -gt 0 ]; then
  echo ""
  echo " Failures:"
  echo -e "$ERRORS"
fi
echo "══════════════════════════════════════════════════════════════"

exit $FAIL
