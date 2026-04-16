#!/usr/bin/env bash
#
# v2-vs-v3 cohort maturity parity test.
#
# Proves that cohort_maturity (v3) produces identical results to
# cohort_maturity_v2 on synth graphs. Uses the CLI analyse tool
# (same pipeline as the browser) — no reimplemented hash lookup.
#
# Phase 1: Data health checks (non-vacuousness)
#   - Graph JSON exists with expected edges
#   - Snapshot DB has rows for each edge's param_id
#   - CLI analyse returns cohort data (cohorts > 0, forecast_x > 0)
#
# Phase 2: Parity comparison
#   - Run analyse with --type cohort_maturity_v2 and --type cohort_maturity
#   - Compare maturity_rows field by field
#
# Usage:
#   bash graph-ops/scripts/v2-v3-parity-test.sh [graph-name] [options]
#
# Options:
#   --generate    Re-run synth_gen before testing
#   --verbose     Show detailed output
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - Synth graph generated (synth_gen.py --write-files)
#
# Examples:
#   bash graph-ops/scripts/v2-v3-parity-test.sh synth-mirror-4step
#   bash graph-ops/scripts/v2-v3-parity-test.sh synth-mirror-4step --generate

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

GRAPH_NAME="${1:-synth-mirror-4step}"
# Support graph-specific test case configuration
declare -a GRAPH_CASES
shift || true

GENERATE=false
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --generate) GENERATE=true ;;
    --verbose|-v) VERBOSE=true ;;
  esac
done

DATA_REPO_PATH="$_DAGNET_ROOT/$DATA_REPO_DIR"
GRAPH_FILE="$DATA_REPO_PATH/graphs/${GRAPH_NAME}.json"

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

_assert_nonzero() {
  local label="$1"
  local value="$2"
  TOTAL=$((TOTAL + 1))
  if [ -n "$value" ] && [ "$value" != "0" ] && [ "$value" != "null" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $label ($value)"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $label (got: ${value:-empty})"
  fi
}

echo "══════════════════════════════════════════════════════"
echo "  v2-vs-v3 parity test: $GRAPH_NAME"
echo "══════════════════════════════════════════════════════"

# ── Phase 0: Optional regeneration ─────────────────────────────────
if [ "$GENERATE" = "true" ]; then
  echo ""
  echo "Phase 0: Regenerating synth data..."
  cd "$_DAGNET_ROOT/graph-editor"
  . venv/bin/activate
  DB_CONNECTION="$(grep DB_CONNECTION .env.local 2>/dev/null | cut -d= -f2- || true)" \
    python ../bayes/synth_gen.py --graph "$GRAPH_NAME" --write-files 2>&1 | tail -5
  echo "  Done."
fi

# ── Phase 1: Data health checks ───────────────────────────────────
echo ""
echo "Phase 1: Data health checks"

# 1a. Graph JSON exists
test -f "$GRAPH_FILE"
_check "Graph JSON exists" "$?"

# 1b. Graph has non-dropout edges with p.id
N_EDGES=$(python3 -c "
import json
g = json.load(open('$GRAPH_FILE'))
nmap = {n['uuid']: n.get('id','') for n in g['nodes']}
n = sum(1 for e in g['edges']
        if 'dropout' not in nmap.get(e.get('to',''),'')
        and e.get('p',{}).get('id',''))
print(n)
" 2>/dev/null)
_assert_nonzero "Non-dropout edges with p.id" "$N_EDGES"

# 1c. Snapshot DB has rows for each edge
echo ""
echo "  Checking snapshot DB rows per edge..."
cd "$_DAGNET_ROOT/graph-editor"
. venv/bin/activate 2>/dev/null || true

python3 -c "
import json, os, sys
sys.path.insert(0, 'lib')
from dotenv import load_dotenv
load_dotenv('.env.local')
conn_str = ''
for f in ['.env.local', '.env', '../.env']:
    if os.path.exists(f):
        for line in open(f):
            if line.startswith('DB_CONNECTION='):
                conn_str = line.split('=',1)[1].strip()
if not conn_str:
    print('ERROR: No DB_CONNECTION found')
    sys.exit(1)
import psycopg2
conn = psycopg2.connect(conn_str)
cur = conn.cursor()
g = json.load(open('$GRAPH_FILE'))
nmap = {n['uuid']: n.get('id','') for n in g['nodes']}
ok = 0
fail = 0
for e in g['edges']:
    p_id = e.get('p',{}).get('id','')
    f_name = nmap.get(e.get('from',''),'')
    t_name = nmap.get(e.get('to',''),'')
    if not p_id or 'dropout' in t_name:
        continue
    cur.execute(
        \"SELECT slice_key, COUNT(*) FROM snapshots WHERE param_id LIKE %s AND core_hash NOT LIKE 'PLACEHOLDER%%' GROUP BY slice_key\",
        (f'%{p_id}',)
    )
    rows = cur.fetchall()
    has_cohort = any(sk == 'cohort()' and n > 0 for sk, n in rows)
    has_window = any(sk == 'window()' and n > 0 for sk, n in rows)
    total = sum(n for _, n in rows)
    status = 'OK' if (has_cohort and has_window) else 'MISSING'
    if status == 'OK':
        ok += 1
    else:
        fail += 1
    print(f'    {f_name:20s} -> {t_name:20s}  {status}  (cohort={has_cohort} window={has_window} total={total})')
conn.close()
print(f'EDGE_DB_RESULT:{ok}:{fail}')
" 2>&1 | while IFS= read -r line; do
  if [[ "$line" == EDGE_DB_RESULT:* ]]; then
    IFS=: read -r _ ok fail <<< "$line"
    if [ "$fail" = "0" ] && [ "$ok" -gt "0" ]; then
      echo "  ✓ All $ok edges have snapshot data"
    else
      echo "  ✗ $fail edges missing snapshot data ($ok OK)"
    fi
  else
    echo "$line"
  fi
done

# ── Phase 1d: CLI analyse returns non-empty cohort data ──────────
echo ""
echo "  Checking CLI analyse returns cohort data..."

# Define test cases: (label, dsl, expected_mode)
# Two date ranges:
# - "wide" (7-Mar to 21-Mar): mature cohorts, IS conditioning fires,
#   catches midpoint/fx/fy divergence.
# - "narrow" (15-Mar to 21-Mar): young cohorts, IS may NOT fire on
#   broken implementations, catches fan width divergence from missing
#   IS conditioning (the prod graph failure mode).
declare -a CASES=(
  "single-hop-cohort-wide|from(m4-registered).to(m4-success).cohort(7-Mar-26:21-Mar-26)|cohort"
  "single-hop-cohort-narrow|from(m4-registered).to(m4-success).cohort(15-Mar-26:21-Mar-26)|cohort"
  "multi-hop-cohort-wide|from(m4-delegated).to(m4-success).cohort(7-Mar-26:21-Mar-26)|cohort"
  "multi-hop-cohort-narrow|from(m4-delegated).to(m4-success).cohort(15-Mar-26:21-Mar-26)|cohort"
  "single-hop-window|from(m4-registered).to(m4-success).window(7-Mar-26:21-Mar-26)|window"
)

TMPDIR_PARITY=$(mktemp -d)
trap "rm -rf $TMPDIR_PARITY" EXIT

for case_spec in "${CASES[@]}"; do
  IFS='|' read -r label dsl mode <<< "$case_spec"

  # Run v2 (strip nvm "Now using node..." line from stdout)
  V2_FILE="$TMPDIR_PARITY/${label}_v2.json"
  bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" "$dsl" \
    --type cohort_maturity_v2 --topo-pass --no-snapshot-cache --format json \
    2>/dev/null | sed '1{/^Now using/d}' \
    > "$V2_FILE" || true

  # Check v2 has maturity_rows with cohorts
  V2_ROWS=$(python3 -c "
import json, sys
try:
    d = json.load(open('$V2_FILE'))
    rows = d.get('result',{}).get('data',[]) or d.get('result',{}).get('maturity_rows',[])
    n_with_mid = sum(1 for r in rows if r.get('midpoint') is not None)
    n_with_fx = sum(1 for r in rows if r.get('forecast_x') is not None and r['forecast_x'] > 0)
    n_with_ev = sum(1 for r in rows if r.get('evidence_x') is not None and r['evidence_x'] > 0)
    print(f'{len(rows)}:{n_with_mid}:{n_with_fx}:{n_with_ev}')
except Exception as e:
    print(f'0:0:0:0')
" 2>/dev/null)

  IFS=: read -r total mid fx ev <<< "$V2_ROWS"
  TOTAL=$((TOTAL + 1))
  # Non-vacuousness: must have midpoints AND evidence (observed cohorts)
  # AND forecast_x (population model with carrier). Without all three,
  # the test exercises a degenerate code path.
  if [ "$total" -gt "5" ] && [ "$mid" -gt "0" ] && [ "$ev" -gt "0" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ v2 $label: $total rows, $mid midpoint, $fx forecast_x, $ev evidence_x"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ v2 $label: $total rows, $mid midpoint, $fx forecast_x, $ev evidence_x (NEED evidence_x > 0)"
  fi

  # Run v3 (strip nvm "Now using node..." line from stdout)
  V3_FILE="$TMPDIR_PARITY/${label}_v3.json"
  bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" "$dsl" \
    --type cohort_maturity --topo-pass --no-snapshot-cache --format json \
    2>/dev/null | sed '1{/^Now using/d}' \
    > "$V3_FILE" || true

  V3_ROWS=$(python3 -c "
import json, sys
try:
    d = json.load(open('$V3_FILE'))
    rows = d.get('result',{}).get('data',[]) or d.get('result',{}).get('maturity_rows',[])
    n_with_mid = sum(1 for r in rows if r.get('midpoint') is not None)
    n_with_fx = sum(1 for r in rows if r.get('forecast_x') is not None and r['forecast_x'] > 0)
    n_with_ev = sum(1 for r in rows if r.get('evidence_x') is not None and r['evidence_x'] > 0)
    print(f'{len(rows)}:{n_with_mid}:{n_with_fx}:{n_with_ev}')
except Exception as e:
    print(f'0:0:0:0')
" 2>/dev/null)

  IFS=: read -r total3 mid3 fx3 ev3 <<< "$V3_ROWS"
  TOTAL=$((TOTAL + 1))
  if [ "$total3" -gt "5" ] && [ "$mid3" -gt "0" ] && [ "$ev3" -gt "0" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ v3 $label: $total3 rows, $mid3 midpoint, $fx3 forecast_x, $ev3 evidence_x"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ v3 $label: $total3 rows, $mid3 midpoint, $fx3 forecast_x, $ev3 evidence_x (NEED evidence_x > 0)"
  fi
done

# ── Phase 2: Parity comparison ─────────────────────────────────────
echo ""
echo "Phase 2: v2-vs-v3 parity comparison"

for case_spec in "${CASES[@]}"; do
  IFS='|' read -r label dsl mode <<< "$case_spec"

  V2_FILE="$TMPDIR_PARITY/${label}_v2.json"
  V3_FILE="$TMPDIR_PARITY/${label}_v3.json"

  if [ ! -s "$V2_FILE" ] || [ ! -s "$V3_FILE" ]; then
    TOTAL=$((TOTAL + 1))
    FAIL=$((FAIL + 1))
    echo "  ✗ $label: missing v2 or v3 output"
    continue
  fi

  PARITY_RESULT=$(python3 -c "
import json, sys

v2 = json.load(open('$V2_FILE'))
v3 = json.load(open('$V3_FILE'))

v2_rows = v2.get('result',{}).get('data',[]) or v2.get('result',{}).get('maturity_rows',[])
v3_rows = v3.get('result',{}).get('data',[]) or v3.get('result',{}).get('maturity_rows',[])

v2_by_tau = {r['tau_days']: r for r in v2_rows}
v3_by_tau = {r['tau_days']: r for r in v3_rows}
shared = sorted(set(v2_by_tau) & set(v3_by_tau))

if len(shared) < 5:
    print(f'FAIL:too few shared tau ({len(shared)})')
    sys.exit(0)

failures = []
for tau in shared:
    r2, r3 = v2_by_tau[tau], v3_by_tau[tau]
    issues = []

    # Midpoint
    m2, m3 = r2.get('midpoint'), r3.get('midpoint')
    if m2 is not None and m3 is not None:
        d = abs(m2 - m3)
        if d > 0.03:
            issues.append(f'mid:{m2:.4f}/{m3:.4f} D={d:.4f}')

    # Fan width 90%
    fb2 = (r2.get('fan_bands') or {}).get('90')
    fb3 = (r3.get('fan_bands') or {}).get('90')
    if fb2 and fb3:
        w2 = fb2[1] - fb2[0]
        w3 = fb3[1] - fb3[0]
        if w2 > 0.01:
            wr = w3 / w2
            if abs(wr - 1.0) > 0.20:
                issues.append(f'fan90:{w2:.4f}/{w3:.4f} r={wr:.2f}')

    # Forecast x (denominator scaling)
    fx2, fx3 = r2.get('forecast_x'), r3.get('forecast_x')
    if fx2 is not None and fx3 is not None and fx2 > 1.0:
        fxr = fx3 / fx2
        if abs(fxr - 1.0) > 0.20:
            issues.append(f'fx:{fx2:.1f}/{fx3:.1f} r={fxr:.2f}')

    # Forecast y
    fy2, fy3 = r2.get('forecast_y'), r3.get('forecast_y')
    if fy2 is not None and fy3 is not None and fy2 > 1.0:
        fyr = fy3 / fy2
        if abs(fyr - 1.0) > 0.20:
            issues.append(f'fy:{fy2:.1f}/{fy3:.1f} r={fyr:.2f}')

    if issues:
        failures.append(f't={tau}: ' + '; '.join(issues))

# Print diagnostic table
print('TAU  | v2 mid  | v3 mid  | D mid | v2 fx   | v3 fx   | v2 w90  | v3 w90  |')
print('-----|---------|---------|-------|---------|---------|---------|---------|')
for tau in shared[:25]:
    r2, r3 = v2_by_tau[tau], v3_by_tau[tau]
    m2 = r2.get('midpoint')
    m3 = r3.get('midpoint')
    dm = abs(m2-m3) if m2 is not None and m3 is not None else 0
    fx2 = r2.get('forecast_x')
    fx3 = r3.get('forecast_x')
    fb2 = (r2.get('fan_bands') or {}).get('90')
    fb3 = (r3.get('fan_bands') or {}).get('90')
    w2 = (fb2[1]-fb2[0]) if fb2 else None
    w3 = (fb3[1]-fb3[0]) if fb3 else None
    _f = lambda v: f'{v:7.4f}' if isinstance(v,(int,float)) else '   None'
    _fx = lambda v: f'{v:7.1f}' if isinstance(v,(int,float)) else '   None'
    print(f'{tau:4d} | {_f(m2)} | {_f(m3)} | {dm:.4f}| {_fx(fx2)} | {_fx(fx3)} | {_f(w2)} | {_f(w3)} |')

if failures:
    print(f'FAIL:{len(failures)} tau diverge')
    for f in failures[:10]:
        print(f'  {f}')
else:
    print(f'PASS:{len(shared)} tau match')
" 2>/dev/null)

  TOTAL=$((TOTAL + 1))
  # Parse result
  RESULT_LINE=$(echo "$PARITY_RESULT" | grep "^PASS:\|^FAIL:" | head -1)
  if [[ "$RESULT_LINE" == PASS:* ]]; then
    PASS=$((PASS + 1))
    echo "  ✓ $label parity: ${RESULT_LINE#PASS:}"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $label parity: ${RESULT_LINE#FAIL:}"
  fi

  # Print diagnostic table if verbose or failed
  if [ "$VERBOSE" = "true" ] || [[ "$RESULT_LINE" == FAIL:* ]]; then
    echo "$PARITY_RESULT" | grep -v "^PASS:\|^FAIL:" | sed 's/^/    /'
  fi
done

# ── Summary ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo "  $PASS passed, $FAIL failed out of $TOTAL"
echo "══════════════════════════════════════════════════════"

exit $FAIL
