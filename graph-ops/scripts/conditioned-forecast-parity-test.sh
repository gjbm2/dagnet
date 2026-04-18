#!/usr/bin/env bash
#
# Conditioned forecast parity test (doc 47).
#
# Proves that the whole-graph conditioned forecast endpoint produces
# correct per-edge scalars by comparing against the v3 chart path
# (single-edge reference). Uses CLI analyse as the test driver —
# same pipeline as the browser.
#
# Phase 1: Data health checks (non-vacuousness)
#   - Graph JSON exists with expected edges
#   - CLI conditioned_forecast returns edges with non-null p_mean
#
# Phase 2: Per-edge parity comparison
#   - For each edge: run v3 chart, extract midpoint at max_tau
#   - Compare against whole-graph conditioned forecast p_mean
#   - Diagnostic table with per-edge pass/fail
#
# Usage:
#   bash graph-ops/scripts/conditioned-forecast-parity-test.sh [graph-name] [options]
#
# Options:
#   --verbose     Show detailed output (diagnostic tables)
#   --generate    Re-run synth_gen before testing
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - Synth graph generated and hydrated (synth_gen.py --write-files --enrich)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

GRAPH_NAME="${1:-synth-simple-abc}"
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
echo "  Conditioned forecast parity test: $GRAPH_NAME"
echo "  (doc 47 — whole-graph vs single-edge v3 reference)"
echo "══════════════════════════════════════════════════════"

TMPDIR_CF=$(mktemp -d)
trap "rm -rf $TMPDIR_CF" EXIT

# ── Phase 0: Optional regeneration ─────────────────────────────────
if [ "$GENERATE" = "true" ]; then
  echo ""
  echo "Phase 0: Regenerating synth data..."
  cd "$_DAGNET_ROOT/graph-editor"
  . venv/bin/activate
  DB_CONNECTION="$(grep DB_CONNECTION .env.local 2>/dev/null | cut -d= -f2- || true)" \
    PYTHONPATH="$_DAGNET_ROOT" \
    python ../bayes/synth_gen.py --graph "$GRAPH_NAME" --write-files --enrich 2>&1 | tail -5
  echo "  Done."
fi

# ── Phase 1: Data health checks ───────────────────────────────────
echo ""
echo "Phase 1: Data health checks"

# 1a. Graph JSON exists
test -f "$GRAPH_FILE"
_check "Graph JSON exists" "$?"

# 1b. Graph has parameterised edges with p.id
EDGE_INFO=$(python3 -c "
import json
g = json.load(open('$GRAPH_FILE'))
nmap = {n['uuid']: n.get('id','') for n in g['nodes']}
edges = []
for e in g['edges']:
    p_id = e.get('p',{}).get('id','')
    to_name = nmap.get(e.get('to',''),'')
    if p_id and 'dropout' not in to_name:
        f_name = nmap.get(e.get('from',''),'')
        edges.append(f'{e[\"uuid\"]}|{f_name}|{to_name}')
print(len(edges))
for e in edges:
    print(e)
" 2>/dev/null)

N_EDGES=$(echo "$EDGE_INFO" | head -1)
_assert_nonzero "Parameterised edges with p.id" "$N_EDGES"

# Collect edge UUIDs and node IDs for later comparison
declare -a EDGE_UUIDS=()
declare -a EDGE_FROM_IDS=()
declare -a EDGE_TO_IDS=()
while IFS='|' read -r uuid from_id to_id; do
  EDGE_UUIDS+=("$uuid")
  EDGE_FROM_IDS+=("$from_id")
  EDGE_TO_IDS+=("$to_id")
done <<< "$(echo "$EDGE_INFO" | tail -n +2)"

# 1c. Snapshot DB has rows
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
        \"SELECT COUNT(*) FROM snapshots WHERE param_id LIKE %s AND core_hash NOT LIKE 'PLACEHOLDER%%'\",
        (f'%{p_id}',)
    )
    count = cur.fetchone()[0]
    if count > 0:
        ok += 1
    else:
        fail += 1
    print(f'    {f_name:20s} -> {t_name:20s}  {\"OK\" if count > 0 else \"MISSING\"} ({count} rows)')
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

# ── Phase 1d: Conditioned forecast returns edges ──────────────────
echo ""
echo "  Running conditioned forecast (whole-graph, temporal only)..."

# Graph-specific DSL: same ranges used by v2-v3 parity test
_define_dsl_synth_simple_abc() { DSL="window(-90d:)"; }
_define_dsl_synth_mirror_4step() { DSL="cohort(7-Mar-26:21-Mar-26)"; }

DSL=""
_fn="_define_dsl_${GRAPH_NAME//-/_}"
if declare -f "$_fn" > /dev/null 2>&1; then
  "$_fn"
else
  DSL="window(-90d:)"
fi

WG_FILE="$TMPDIR_CF/wg_conditioned.json"
bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" "$DSL" \
  --type conditioned_forecast --topo-pass --format json \
  2>/dev/null | sed '1{/^Now using/d}' \
  > "$WG_FILE" || true

WG_N_EDGES=$(python3 -c "
import json, sys
try:
    r = json.load(open('$WG_FILE'))
    edges = r.get('scenarios', [{}])[0].get('edges', [])
    n = len([e for e in edges if e.get('p_mean') is not None])
    print(n)
except:
    print(0)
" 2>/dev/null)

TOTAL=$((TOTAL + 1))
if [ "$WG_N_EDGES" -gt "0" ] 2>/dev/null; then
  PASS=$((PASS + 1))
  echo "  ✓ Conditioned forecast returned $WG_N_EDGES edges with p_mean"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ Conditioned forecast returned 0 edges with p_mean (THIS IS THE DOC 47 BUG)"
  if [ "$VERBOSE" = "true" ] && [ -s "$WG_FILE" ]; then
    echo "    Response:"
    python3 -c "import json; print(json.dumps(json.load(open('$WG_FILE')), indent=2)[:500])" 2>/dev/null | sed 's/^/    /'
  fi
fi

# ── Phase 2: Parity comparison ─────────────────────────────────────
echo ""
echo "Phase 2: Per-edge parity (whole-graph p_mean vs v3 chart midpoint)"

# Skip if conditioned forecast returned no edges (the bug we're fixing)
if [ "$WG_N_EDGES" = "0" ] 2>/dev/null || [ -z "$WG_N_EDGES" ]; then
  echo "  SKIPPED — conditioned forecast returned no edges (Phase 1 must pass first)"
else
  # Run v3 chart for each edge to get single-edge reference midpoint
  for i in "${!EDGE_UUIDS[@]}"; do
    uuid="${EDGE_UUIDS[$i]}"
    from_id="${EDGE_FROM_IDS[$i]}"
    to_id="${EDGE_TO_IDS[$i]}"

    V3_FILE="$TMPDIR_CF/v3_${from_id}_${to_id}.json"
    bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" \
      "from(${from_id}).to(${to_id}).${DSL}" \
      --type cohort_maturity --topo-pass --no-snapshot-cache --format json \
      2>/dev/null | sed '1{/^Now using/d}' \
      > "$V3_FILE" || true
  done

  # Compare all edges
  PARITY_RESULT=$(python3 -c "
import json, sys, os

# Load whole-graph result
wg = json.load(open('$WG_FILE'))
wg_edges = wg.get('scenarios', [{}])[0].get('edges', [])
wg_by_uuid = {e['edge_uuid']: e for e in wg_edges}

# Load graph for node map
g = json.load(open('$GRAPH_FILE'))
nmap = {n['uuid']: n.get('id','') for n in g['nodes']}

# Per-edge comparison
results = []
for edge in g['edges']:
    p_id = edge.get('p',{}).get('id','')
    to_name = nmap.get(edge.get('to',''),'')
    from_name = nmap.get(edge.get('from',''),'')
    if not p_id or 'dropout' in to_name:
        continue

    uuid = edge['uuid']
    is_downstream = not any(
        n.get('entry',{}).get('is_start',False) for n in g['nodes']
        if n['uuid'] == edge.get('from')
    )

    # Whole-graph p_mean
    wg_edge = wg_by_uuid.get(uuid)
    wg_pmean = wg_edge.get('p_mean') if wg_edge else None

    # V3 chart reference: p@∞ from the last row (engine-evaluated at
    # saturation_tau, same quantity CF writes to the graph). Falls
    # back to last-row midpoint for older server builds.
    v3_file = f'$TMPDIR_CF/v3_{from_name}_{to_name}.json'
    v3_mid = None
    v3_tau = None
    if os.path.exists(v3_file):
        try:
            v3 = json.load(open(v3_file))
            rows = v3.get('result',{}).get('data',[]) or v3.get('result',{}).get('maturity_rows',[])
            if rows:
                last = rows[-1]
                v3_tau = last.get('tau_days')
                p_inf = last.get('p_infinity_mean')
                if p_inf is not None:
                    v3_mid = float(p_inf)
                else:
                    for r in reversed(rows):
                        if r.get('midpoint') is not None:
                            v3_mid = float(r['midpoint'])
                            v3_tau = r.get('tau_days')
                            break
        except:
            pass

    results.append({
        'edge': f'{from_name} -> {to_name}',
        'uuid': uuid[:12],
        'wg_pmean': wg_pmean,
        'v3_mid': v3_mid,
        'v3_tau': v3_tau,
        'is_downstream': is_downstream,
    })

# Print diagnostic table
print(f'{\"edge\":30s} | {\"wg p_mean\":>10s} | {\"v3 mid@T\":>10s} | {\"delta\":>8s} | {\"downstream\":>10s} | result')
print('-' * 95)

n_pass = 0
n_fail = 0
n_skip = 0

for r in results:
    wg = r['wg_pmean']
    v3 = r['v3_mid']
    if wg is None or v3 is None:
        status = 'SKIP'
        n_skip += 1
        delta_str = '    —   '
        wg_str = f'{wg:10.4f}' if wg is not None else '      None'
        v3_str = f'{v3:10.4f}' if v3 is not None else '      None'
    else:
        delta = abs(wg - v3)
        delta_str = f'{delta:8.4f}'
        wg_str = f'{wg:10.4f}'
        v3_str = f'{v3:10.4f}'
        # Tolerance: 0.005 (0.5% absolute on probability)
        # Tight enough to catch systematic errors; wide enough for MC variance.
        if delta < 0.005:
            status = 'PASS'
            n_pass += 1
        else:
            status = 'FAIL'
            n_fail += 1
    ds = 'yes' if r['is_downstream'] else 'no'
    print(f'{r[\"edge\"]:30s} | {wg_str} | {v3_str} | {delta_str} | {ds:>10s} | {status}')

print(f'')
print(f'SUMMARY:{n_pass}:{n_fail}:{n_skip}')
" 2>/dev/null)

  # Parse summary
  SUMMARY_LINE=$(echo "$PARITY_RESULT" | grep "^SUMMARY:" | head -1)
  if [ -n "$SUMMARY_LINE" ]; then
    IFS=: read -r _ p f s <<< "$SUMMARY_LINE"
    TOTAL=$((TOTAL + 1))
    # Skipped edges count as failures — every parameterised edge with
    # snapshot data must produce a result. Silent omissions hide bugs.
    if [ "$f" = "0" ] && [ "$s" = "0" ] && [ "$p" -gt "0" ] 2>/dev/null; then
      PASS=$((PASS + 1))
      echo "  ✓ Parity: $p edges match"
    else
      FAIL=$((FAIL + 1))
      echo "  ✗ Parity: $p pass, $f FAIL, $s SKIPPED (skips count as failures)"
    fi
  else
    TOTAL=$((TOTAL + 1))
    FAIL=$((FAIL + 1))
    echo "  ✗ Parity comparison failed to produce summary"
  fi

  # Print diagnostic table if verbose or failed
  if [ "$VERBOSE" = "true" ] || [[ "${SUMMARY_LINE:-}" == *":0:"* ]] || true; then
    echo "$PARITY_RESULT" | grep -v "^SUMMARY:" | sed 's/^/    /'
  fi
fi

# ── Phase 3: Sibling PMF consistency ──────────────────────────────
# After applying conditioned forecast p_mean values, sibling edges
# from the same parent node must still sum to ≤1.0 (PMF invariant).
# This verifies the BE response is compatible with the FE write path
# (UpdateManager.applyBatchLAGValues + sibling rebalancing).
echo ""
echo "Phase 3: Sibling PMF consistency"

if [ "$WG_N_EDGES" = "0" ] 2>/dev/null || [ -z "$WG_N_EDGES" ]; then
  echo "  SKIPPED — no conditioned forecast results"
else
  PMF_RESULT=$(python3 -c "
import json, sys

wg = json.load(open('$WG_FILE'))
g = json.load(open('$GRAPH_FILE'))
nmap = {n['uuid']: n.get('id','') for n in g['nodes']}
wg_edges = wg.get('scenarios', [{}])[0].get('edges', [])
wg_by_uuid = {e['edge_uuid']: e for e in wg_edges}

# Group edges by parent node
parent_groups = {}
for e in g['edges']:
    from_uuid = e.get('from','')
    from_name = nmap.get(from_uuid, from_uuid[:12])
    parent_groups.setdefault(from_name, []).append(e)

n_pass = 0
n_fail = 0
for parent, siblings in parent_groups.items():
    if len(siblings) < 2:
        continue
    total = 0.0
    details = []
    for s in siblings:
        to_name = nmap.get(s.get('to',''), '?')
        wg_e = wg_by_uuid.get(s['uuid'])
        p = wg_e['p_mean'] if wg_e and wg_e.get('p_mean') is not None else s.get('p',{}).get('mean', 0)
        total += p
        details.append(f'{to_name}={p:.4f}')
    ok = total <= 1.01  # allow tiny float rounding
    if ok:
        n_pass += 1
    else:
        n_fail += 1
    status = 'PASS' if ok else 'FAIL'
    print(f'  {parent}: sum={total:.4f} ({\" + \".join(details)}) {status}')
print(f'PMF_SUMMARY:{n_pass}:{n_fail}')
" 2>/dev/null)

  PMF_LINE=$(echo "$PMF_RESULT" | grep "^PMF_SUMMARY:" | head -1)
  if [ -n "$PMF_LINE" ]; then
    IFS=: read -r _ p f <<< "$PMF_LINE"
    TOTAL=$((TOTAL + 1))
    if [ "$f" = "0" ] && [ "$p" -gt "0" ] 2>/dev/null; then
      PASS=$((PASS + 1))
      echo "  ✓ All $p sibling groups have PMF ≤ 1.0"
    else
      FAIL=$((FAIL + 1))
      echo "  ✗ $f sibling groups have PMF > 1.0"
    fi
  fi

  echo "$PMF_RESULT" | grep -v "^PMF_SUMMARY:" | sed 's/^/  /'
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo "  $PASS passed, $FAIL failed out of $TOTAL"
echo ""
echo "  Phase 1: temporal-only request returns non-empty edges"
echo "  Phase 2: whole-graph p_mean matches v3 chart midpoint"
echo "  Phase 3: sibling PMF consistency (sum ≤ 1.0)"
echo "══════════════════════════════════════════════════════"

exit $FAIL
