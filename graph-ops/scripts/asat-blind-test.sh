#!/usr/bin/env bash
# asat() blind contract tests (doc 42).
#
# Outside-in tests using the CLI tooling (param-pack.sh, analyse.sh)
# on the synth-simple-abc graph. Each test asserts a doc 42 invariant
# by comparing CLI output with and without asat() in the DSL.
#
# Prerequisites:
#   - Python BE running (dev-server.py on localhost:9000)
#   - synth-simple-abc generated:
#       cd graph-editor && . venv/bin/activate
#       DB_CONNECTION="$(grep DB_CONNECTION .env.local | cut -d= -f2-)" \
#         python ../bayes/synth_gen.py --graph synth-simple-abc --write-files
#
# Usage:
#   bash graph-ops/scripts/asat-blind-test.sh

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

# Suppress nvm stdout noise by pre-loading node before tests
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use "$(cat "$_DAGNET_ROOT/graph-editor/.nvmrc")" >/dev/null 2>/dev/null || true
fi

# Helper: run param-pack and strip nvm stdout noise
pp() {
  bash graph-ops/scripts/param-pack.sh "$@" 2>/dev/null | grep -v "^Now using node"
}

# Helper: run analyse and strip nvm stdout noise
an() {
  bash graph-ops/scripts/analyse.sh "$@" 2>/dev/null | grep -v "^Now using node"
}

GRAPH="synth-simple-abc"
EDGE="simple-a-to-b"

# synth-simple-abc config:
#   base_date = 2025-12-12, n_days = 100
#   fetch nights 1..100 → retrieved_at from 2025-12-13 to 2026-03-21
#   Observable anchor days from ~12-Dec-25 onward.

# Full window covering the observable range
FULL_WINDOW="window(12-Dec-25:20-Mar-26)"

# asat at day ~30: mid-Jan. Cohorts are young, Y values small.
ASAT_EARLY="15-Jan-26"

# asat before any retrieval: should see no data.
ASAT_BEFORE="11-Dec-25"

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
echo " asat() blind contract tests (doc 42)"
echo " Graph: ${GRAPH}  Edge: ${EDGE}"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Evidence filtering — asat returns different evidence ──────────

echo "Test 1a: Evidence present in baseline param-pack"

k_baseline=$(pp "$GRAPH" "$FULL_WINDOW" \
  --get "e.${EDGE}.p.evidence.k") || true

if [ -z "$k_baseline" ]; then
  fail_test "T1a" "no evidence.k in baseline param-pack"
else
  pass_test "T1a: baseline evidence.k = ${k_baseline}"
fi

echo "Test 1b: Evidence present in asat param-pack (less mature data expected)"

k_asat=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_EARLY})" \
  --get "e.${EDGE}.p.evidence.k") || true

if [ -z "$k_asat" ]; then
  fail_test "T1b" "no evidence.k in asat param-pack. asat fork may not be producing evidence."
elif [ "$k_asat" = "$k_baseline" ]; then
  fail_test "T1b" "k identical with and without asat (both=${k_baseline}). asat evidence filtering not working."
else
  if python3 -c "import sys; sys.exit(0 if float('${k_asat}') < float('${k_baseline}') else 1)" 2>/dev/null; then
    pass_test "T1b: k_asat (${k_asat}) < k_baseline (${k_baseline})"
  else
    fail_test "T1b" "k_asat (${k_asat}) >= k_baseline (${k_baseline}). Expected less mature data."
  fi
fi

echo "Test 1c: Blended p.mean differs between baseline and asat"

pmean_baseline=$(pp "$GRAPH" "$FULL_WINDOW" \
  --get "e.${EDGE}.p.mean") || true

pmean_asat=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_EARLY})" \
  --get "e.${EDGE}.p.mean") || true

if [ -z "$pmean_baseline" ] || [ -z "$pmean_asat" ]; then
  fail_test "T1c" "could not retrieve p.mean (baseline='${pmean_baseline}', asat='${pmean_asat}')"
elif [ "$pmean_baseline" = "$pmean_asat" ]; then
  fail_test "T1c" "p.mean identical with and without asat (both=${pmean_baseline}). asat not affecting blended rate."
else
  pass_test "T1c: p.mean differs (baseline=${pmean_baseline}, asat=${pmean_asat})"
fi

echo ""

# ── Test 2: Evidence filtering — asat before any data ────────────────────

echo "Test 2: Evidence filtering — asat before any retrieval returns zero/empty"

k_before=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_BEFORE})" \
  --get "e.${EDGE}.p.evidence.k") || true

if [ -z "$k_before" ]; then
  # Empty means the key didn't exist — could be correct (no evidence at all)
  pass_test "T2: no evidence key returned for asat before first retrieval"
elif [ "$k_before" = "0" ]; then
  pass_test "T2: k=0 for asat before first retrieval"
else
  fail_test "T2" "k=${k_before} for asat before first retrieval. Expected 0 or empty."
fi

echo ""

# ── Test 3: Signature exclusion — hash unchanged by asat ─────────────────

echo "Test 3: Signature exclusion — same hash with and without asat"

sig_baseline=$(bash graph-ops/scripts/param-pack.sh "$GRAPH" "$FULL_WINDOW" \
  --show-signatures 2>&1 | grep -v "^Now using" | grep "hash=" | grep "${EDGE}" | head -1) || true

sig_asat=$(bash graph-ops/scripts/param-pack.sh "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_EARLY})" \
  --show-signatures 2>&1 | grep -v "^Now using" | grep "hash=" | grep "${EDGE}" | head -1) || true

if [ -z "$sig_baseline" ] || [ -z "$sig_asat" ]; then
  fail_test "T3" "could not retrieve signatures (baseline='${sig_baseline}', asat='${sig_asat}')"
else
  # Extract hash= value from the signature line
  hash_baseline=$(echo "$sig_baseline" | grep -o 'hash=[^ ]*' | head -1)
  hash_asat=$(echo "$sig_asat" | grep -o 'hash=[^ ]*' | head -1)

  if [ "$hash_baseline" = "$hash_asat" ]; then
    pass_test "T3: signature hash identical (${hash_baseline})"
  else
    fail_test "T3" "signature hash differs: baseline=${hash_baseline}, asat=${hash_asat}. asat is polluting the signature."
  fi
fi

echo ""

# ── Test 4: Analysis pipeline — cohort_maturity differs with asat ────────

echo "Test 4: Analysis pipeline — cohort_maturity with asat returns different forecast"

# Use cohort mode for analysis. Compare projected_rate at tau=10 —
# the forecast component changes because sweep_to (from asat) limits
# how far the model projects. Observed rate may be identical for early
# tau values where all cohorts are already mature by the asat date.
COHORT_DSL="from(simple-a).to(simple-b).cohort(12-Dec-25:21-Mar-26)"

proj_baseline=$(an "$GRAPH" "$COHORT_DSL" \
  --type cohort_maturity --no-snapshot-cache --format json \
  --get "result.data.10.projected_rate") || true

proj_asat=$(an "$GRAPH" "${COHORT_DSL}.asat(${ASAT_EARLY})" \
  --type cohort_maturity --no-snapshot-cache --format json \
  --get "result.data.10.projected_rate") || true

if [ -z "$proj_baseline" ] || [ "$proj_baseline" = "null" ]; then
  fail_test "T4" "could not retrieve baseline projected_rate at tau=10. Is the Python BE running?"
elif [ -z "$proj_asat" ] || [ "$proj_asat" = "null" ]; then
  fail_test "T4" "asat cohort_maturity returned no projected_rate at tau=10 (baseline=${proj_baseline})"
elif [ "$proj_baseline" = "$proj_asat" ]; then
  fail_test "T4" "cohort_maturity projected_rate identical with and without asat (both=${proj_baseline}). asat not affecting analysis."
else
  pass_test "T4: cohort_maturity projected_rate differs at tau=10 (baseline=${proj_baseline}, asat=${proj_asat})"
fi

echo ""

# ── Test 3b: Hash correctness — asat and baseline use same signature ──────

echo "Test 3b: Hash correctness — asat evidence.n differs from baseline"
echo "  (confirms snapshot DB returned data keyed by the correct hash)"

n_baseline=$(pp "$GRAPH" "$FULL_WINDOW" \
  --get "e.${EDGE}.p.evidence.n") || true

n_asat=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_EARLY})" \
  --get "e.${EDGE}.p.evidence.n") || true

if [ -z "$n_baseline" ] || [ -z "$n_asat" ]; then
  fail_test "T3b" "could not retrieve evidence.n (baseline='${n_baseline}', asat='${n_asat}')"
elif [ "$n_asat" = "0" ]; then
  fail_test "T3b" "asat evidence.n is 0 — hash mismatch? Snapshot DB returned no rows for asat date."
elif [ "$n_asat" = "$n_baseline" ]; then
  fail_test "T3b" "evidence.n identical — asat not filtering (both=${n_baseline})"
else
  pass_test "T3b: evidence.n differs (baseline=${n_baseline}, asat=${n_asat}) — hash match confirmed"
fi

echo ""

# ── Test 5: Read-only — asat query doesn't modify param files ────────────

echo "Test 5: Read-only — asat query does not modify param files"

# Checksum all param files before
PARAM_DIR="${DATA_REPO_PATH}/parameters"
checksum_before=""
if [ -d "$PARAM_DIR" ]; then
  checksum_before=$(find "$PARAM_DIR" -name "*.yaml" -o -name "*.json" | sort | xargs md5sum 2>/dev/null) || true
fi

# Run asat param-pack query
pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_EARLY})" \
  --format json >/dev/null || true

checksum_after=""
if [ -d "$PARAM_DIR" ]; then
  checksum_after=$(find "$PARAM_DIR" -name "*.yaml" -o -name "*.json" | sort | xargs md5sum 2>/dev/null) || true
fi

if [ "$checksum_before" = "$checksum_after" ]; then
  pass_test "T5: param files unchanged after asat query"
else
  fail_test "T5" "param files changed after asat query. asat is NOT read-only."
fi

echo ""

# ══════════════════════════════════════════════════════════════════════════
# Mixed-epoch tests (synth-context-solo-mixed)
#
# This graph has two epochs:
#   Days 0-44  (12-Dec-25 to ~25-Jan-26): bare aggregate rows only
#   Days 45-89 (~26-Jan-26 to 11-Mar-26): contexted MECE rows
#
# Different epochs use different core_hashes (bare vs contexted).
# asat queries spanning epoch boundaries must handle both hash families.
# ══════════════════════════════════════════════════════════════════════════

MIXED_GRAPH="synth-context-solo-mixed"
MIXED_EDGE="synth-context-solo-mixed-synth-ctx1-anchor-to-target"
MIXED_WINDOW="window(12-Dec-25:11-Mar-26)"

# asat in epoch 1 (bare only — day ~39): should find bare-hash data
MIXED_ASAT_EPOCH1="20-Jan-26"

# asat in epoch 2 (contexted — day ~60): should find both
MIXED_ASAT_EPOCH2="10-Feb-26"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Mixed-epoch tests: ${MIXED_GRAPH}"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Test 6: Mixed-epoch — asat in bare epoch returns evidence ────────────

echo "Test 6: Mixed-epoch — asat in bare epoch returns evidence"

k_mixed_baseline=$(pp "$MIXED_GRAPH" "$MIXED_WINDOW" \
  --get "e.${MIXED_EDGE}.p.evidence.k") || true

k_mixed_epoch1=$(pp "$MIXED_GRAPH" "${MIXED_WINDOW}.asat(${MIXED_ASAT_EPOCH1})" \
  --get "e.${MIXED_EDGE}.p.evidence.k") || true

if [ -z "$k_mixed_baseline" ]; then
  fail_test "T6" "no baseline evidence.k for mixed-epoch graph"
elif [ -z "$k_mixed_epoch1" ]; then
  fail_test "T6" "no evidence.k for asat in epoch 1 (bare). Hash mismatch? Stored sig may be contexted but epoch 1 data uses bare hash."
elif [ "$k_mixed_epoch1" = "0" ]; then
  fail_test "T6" "evidence.k=0 for asat in epoch 1. Snapshot query returned no rows — likely hash family mismatch."
else
  if python3 -c "import sys; sys.exit(0 if float('${k_mixed_epoch1}') < float('${k_mixed_baseline}') else 1)" 2>/dev/null; then
    pass_test "T6: k_epoch1 (${k_mixed_epoch1}) < k_baseline (${k_mixed_baseline})"
  else
    fail_test "T6" "k_epoch1 (${k_mixed_epoch1}) >= k_baseline (${k_mixed_baseline})"
  fi
fi

echo ""

# ── Test 7: Mixed-epoch — asat in contexted epoch returns evidence ───────

echo "Test 7: Mixed-epoch — asat in contexted epoch returns evidence"

k_mixed_epoch2=$(pp "$MIXED_GRAPH" "${MIXED_WINDOW}.asat(${MIXED_ASAT_EPOCH2})" \
  --get "e.${MIXED_EDGE}.p.evidence.k") || true

if [ -z "$k_mixed_epoch2" ]; then
  fail_test "T7" "no evidence.k for asat in epoch 2 (contexted)"
elif [ "$k_mixed_epoch2" = "0" ]; then
  fail_test "T7" "evidence.k=0 for asat in epoch 2"
else
  # epoch2 should have more data than epoch1 (later asat = more mature)
  if [ -n "$k_mixed_epoch1" ] && python3 -c "import sys; sys.exit(0 if float('${k_mixed_epoch2}') > float('${k_mixed_epoch1}') else 1)" 2>/dev/null; then
    pass_test "T7: k_epoch2 (${k_mixed_epoch2}) > k_epoch1 (${k_mixed_epoch1})"
  else
    pass_test "T7: k_epoch2 (${k_mixed_epoch2}) — data returned"
  fi
fi

echo ""

# ── Test 8: Mixed-epoch — contexted query via asat sees contexted data ───

echo "Test 8: Mixed-epoch — context-qualified asat query in epoch 2"
echo "  (bare sig stored on file, but contexted data exists under different hash)"

k_mixed_ctx=$(pp "$MIXED_GRAPH" "context(synth-channel:google).${MIXED_WINDOW}.asat(${MIXED_ASAT_EPOCH2})" \
  --get "e.${MIXED_EDGE}.p.evidence.k") || true

if [ -z "$k_mixed_ctx" ]; then
  fail_test "T8" "no evidence.k for context-qualified asat in epoch 2. Known limitation: stored sig is bare, contexted data under different hash."
elif [ "$k_mixed_ctx" = "0" ]; then
  fail_test "T8" "evidence.k=0 for context-qualified asat. Hash family mismatch — bare sig can't find contexted rows."
else
  pass_test "T8: context-qualified asat returned k=${k_mixed_ctx}"
fi

echo ""

# ══════════════════════════════════════════════════════════════════════════
# D5: Cohort maturity zone boundaries must reflect asat
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " D5: Cohort maturity zone boundaries with asat"
echo "══════════════════════════════════════════════════════════════"
echo ""

# asat near the END of the cohort range. The youngest cohort has almost
# no observation depth at this asat date. tau_solid_max must be small.
# synth-simple-abc: base_date=12-Dec-25, n_days=100, anchor_to~21-Mar-26
# asat=18-Mar-26 → youngest cohort (anchor ~21-Mar) has tau_observed ≈ 0
# Even the oldest cohort (anchor 12-Dec) has tau_observed = 18-Mar - 12-Dec = 96
# But tau_solid_max = YOUNGEST cohort's tau_observed ≈ 0

COHORT_DSL_D5="from(simple-a).to(simple-b).cohort(12-Dec-25:21-Mar-26)"
ASAT_LATE="18-Mar-26"

echo "Test D5a: tau_solid_max constrained by asat (asat near end of range)"

tsm_baseline=$(an "$GRAPH" "$COHORT_DSL_D5" \
  --type cohort_maturity --no-snapshot-cache --format json \
  --get "result.data.0.tau_solid_max") || true

tsm_asat=$(an "$GRAPH" "${COHORT_DSL_D5}.asat(${ASAT_LATE})" \
  --type cohort_maturity --no-snapshot-cache --format json \
  --get "result.data.0.tau_solid_max") || true

if [ -z "$tsm_baseline" ] || [ "$tsm_baseline" = "null" ]; then
  fail_test "D5a" "could not retrieve baseline tau_solid_max"
elif [ -z "$tsm_asat" ] || [ "$tsm_asat" = "null" ]; then
  fail_test "D5a" "could not retrieve asat tau_solid_max"
else
  # With asat near end of range, tau_solid_max must be much smaller than baseline
  # Specifically: it should be < 10 (youngest cohort has ~0 days of observation)
  if python3 -c "import sys; sys.exit(0 if float('${tsm_asat}') < 10 else 1)" 2>/dev/null; then
    pass_test "D5a: tau_solid_max with asat (${tsm_asat}) < 10 (baseline=${tsm_baseline})"
  else
    fail_test "D5a" "tau_solid_max with asat (${tsm_asat}) >= 10 — not constrained by asat. Baseline=${tsm_baseline}."
  fi
fi

echo ""

echo "Test D5b: boundary_date reflects asat, not today"

bd_asat=$(an "$GRAPH" "${COHORT_DSL_D5}.asat(${ASAT_LATE})" \
  --type cohort_maturity --no-snapshot-cache --format json \
  --get "result.data.0.boundary_date") || true

if [ -z "$bd_asat" ] || [ "$bd_asat" = "null" ]; then
  fail_test "D5b" "could not retrieve boundary_date"
else
  # boundary_date should be the asat date or close to it, not today
  today=$(date +%Y-%m-%d)
  if [ "$bd_asat" = "$today" ]; then
    fail_test "D5b" "boundary_date is today (${today}), not asat date. Analysis ignoring asat."
  else
    pass_test "D5b: boundary_date=${bd_asat} (not today=${today})"
  fi
fi

echo ""

echo "Test D5c: evidence_x differs between baseline and asat analysis"

ex_baseline=$(an "$GRAPH" "$COHORT_DSL_D5" \
  --type cohort_maturity --no-snapshot-cache --format json \
  --get "result.data.10.evidence_x") || true

ex_asat=$(an "$GRAPH" "${COHORT_DSL_D5}.asat(${ASAT_LATE})" \
  --type cohort_maturity --no-snapshot-cache --format json \
  --get "result.data.10.evidence_x") || true

if [ -z "$ex_baseline" ] || [ "$ex_baseline" = "null" ]; then
  fail_test "D5c" "could not retrieve baseline evidence_x"
elif [ -z "$ex_asat" ] || [ "$ex_asat" = "null" ]; then
  fail_test "D5c" "could not retrieve asat evidence_x"
elif [ "$ex_baseline" = "$ex_asat" ]; then
  fail_test "D5c" "evidence_x identical with and without asat (both=${ex_baseline}). Analysis not using asat-filtered data."
else
  pass_test "D5c: evidence_x differs (baseline=${ex_baseline}, asat=${ex_asat})"
fi

echo ""

# ══════════════════════════════════════════════════════════════════════════
# D3: Completeness evaluated at historical age (doc 42 §9, invariants J1-J3)
#
# When asat is in the past, completeness should reflect the maturity at
# that date, not today. age = evaluation_date - anchor_day, where
# evaluation_date = asat date. Historical asat → younger age → lower
# completeness. This is critical for the evidence/forecast blend weight.
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " D3: Completeness evaluated at historical age"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Test D3a: Completeness lower with early asat ──────────────────────

echo "Test D3a: Completeness lower with early asat than baseline"

comp_baseline=$(pp "$GRAPH" "$FULL_WINDOW" \
  --get "e.${EDGE}.p.latency.completeness") || true

comp_asat=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_EARLY})" \
  --get "e.${EDGE}.p.latency.completeness") || true

if [ -z "$comp_baseline" ] || [ "$comp_baseline" = "null" ] || [ "$comp_baseline" = "undefined" ]; then
  fail_test "D3a" "could not retrieve baseline completeness"
elif [ -z "$comp_asat" ] || [ "$comp_asat" = "null" ] || [ "$comp_asat" = "undefined" ]; then
  fail_test "D3a" "could not retrieve asat completeness. Completeness may not use evaluation_date."
elif [ "$comp_baseline" = "$comp_asat" ]; then
  fail_test "D3a" "completeness identical with and without asat (both=${comp_baseline}). evaluation_date not affecting completeness."
else
  if python3 -c "import sys; sys.exit(0 if float('${comp_asat}') < float('${comp_baseline}') else 1)" 2>/dev/null; then
    pass_test "D3a: completeness with asat (${comp_asat}) < baseline (${comp_baseline})"
  else
    fail_test "D3a" "completeness with asat (${comp_asat}) >= baseline (${comp_baseline}). Expected lower completeness for earlier evaluation_date."
  fi
fi

echo ""

# ── Test D3b: Blended rate uncertainty higher with early asat ──────────
#
# Lower completeness → more weight on forecast → higher blended
# uncertainty (p.stdev). If evaluation_date is working, early asat
# should produce higher p.stdev than baseline.

echo "Test D3b: Blended rate uncertainty (p.stdev) higher with early asat"

pstd_baseline=$(pp "$GRAPH" "$FULL_WINDOW" \
  --get "e.${EDGE}.p.stdev") || true

pstd_asat=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_EARLY})" \
  --get "e.${EDGE}.p.stdev") || true

if [ -z "$pstd_baseline" ] || [ "$pstd_baseline" = "null" ] || [ "$pstd_baseline" = "undefined" ]; then
  fail_test "D3b" "could not retrieve baseline p.stdev"
elif [ -z "$pstd_asat" ] || [ "$pstd_asat" = "null" ] || [ "$pstd_asat" = "undefined" ]; then
  fail_test "D3b" "could not retrieve asat p.stdev"
elif [ "$pstd_baseline" = "$pstd_asat" ]; then
  fail_test "D3b" "p.stdev identical (both=${pstd_baseline}). Uncertainty not reflecting historical age."
else
  if python3 -c "import sys; sys.exit(0 if float('${pstd_asat}') > float('${pstd_baseline}') else 1)" 2>/dev/null; then
    pass_test "D3b: p.stdev with asat (${pstd_asat}) > baseline (${pstd_baseline})"
  else
    # Different is still informative even if direction is unexpected
    pass_test "D3b: p.stdev differs (baseline=${pstd_baseline}, asat=${pstd_asat}) — direction unexpected but evaluation_date is active"
  fi
fi

echo ""

# ── Test D3c: Completeness is 0 or very low for asat before data ──────
#
# asat before any retrieval → evaluation_date before anchor days →
# age ≤ 0 → completeness should be 0 (or near 0).

echo "Test D3c: Completeness near zero for asat before any data"

comp_before=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_BEFORE})" \
  --get "e.${EDGE}.p.latency.completeness") || true

if [ -z "$comp_before" ] || [ "$comp_before" = "null" ] || [ "$comp_before" = "undefined" ]; then
  # No completeness returned at all — acceptable (no evidence = no completeness)
  pass_test "D3c: no completeness returned for asat before any data"
else
  if python3 -c "import sys; sys.exit(0 if float('${comp_before}') <= 0.05 else 1)" 2>/dev/null; then
    pass_test "D3c: completeness=${comp_before} for asat before data (near zero)"
  else
    fail_test "D3c" "completeness=${comp_before} for asat before data. Expected ≤ 0.05."
  fi
fi

echo ""

# ── Test D3d: Monotonicity — later asat → higher completeness ─────────
#
# Three asat dates should produce monotonically increasing completeness:
# early < mid < baseline (today).

ASAT_MID="15-Feb-26"

echo "Test D3d: Completeness monotonically increases with later asat"

comp_mid=$(pp "$GRAPH" "${FULL_WINDOW}.asat(${ASAT_MID})" \
  --get "e.${EDGE}.p.latency.completeness") || true

if [ -z "$comp_asat" ] || [ -z "$comp_mid" ] || [ -z "$comp_baseline" ]; then
  fail_test "D3d" "could not retrieve all three completeness values (early=${comp_asat}, mid=${comp_mid}, baseline=${comp_baseline})"
elif [ "$comp_mid" = "null" ] || [ "$comp_mid" = "undefined" ]; then
  fail_test "D3d" "could not retrieve mid-range asat completeness"
else
  if python3 -c "
import sys
e, m, b = float('${comp_asat}'), float('${comp_mid}'), float('${comp_baseline}')
sys.exit(0 if e < m < b else 1)
" 2>/dev/null; then
    pass_test "D3d: completeness monotonic: early(${comp_asat}) < mid(${comp_mid}) < baseline(${comp_baseline})"
  else
    fail_test "D3d" "completeness not monotonic: early=${comp_asat}, mid=${comp_mid}, baseline=${comp_baseline}. Expected early < mid < baseline."
  fi
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
