#!/usr/bin/env bash
#
# Capture oracle baselines for doc 56 runtime-boundary migration.
#
# Produces committed JSON artefacts under bayes/baselines/doc56/ that
# freeze today's CF + v3 chart + daily-conversions + RNG-hash outputs.
# Phase 3 cut-over verification compares live outputs against these
# baselines under the tolerance stack in doc 56 §11.1.
#
# Re-running this script after land regenerates the files in place.
# A re-capture is only correct when an intentional behavioural change
# is being recorded — it must be its own commit with an explicit
# before/after delta in the message (doc 56 §11.1).
#
# Usage:
#   bash graph-ops/scripts/capture-doc56-baselines.sh [fixture-name]
#
# Without arguments, captures the full doc-50 topology matrix plus
# daily-conversions and the RNG-gate fixture. With a fixture name,
# captures only that single fixture (useful for iteration).
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - Data repo present, fixtures generated (synth_gen.py --write-files)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

BASELINE_DIR="$_DAGNET_ROOT/bayes/baselines/doc56"
mkdir -p "$BASELINE_DIR"

# Fixture matrix — DSLs match cf-truth-parity.sh so baselines align
# with the existing truth-parity harness's scope.
FIXTURES=(
  "synth-simple-abc|window(-120d:)"
  "cf-fix-linear-no-lag|window(-60d:)"
  "synth-mirror-4step|cohort(7-Mar-26:21-Mar-26)"
  "cf-fix-branching|window(-60d:)"
  "cf-fix-diamond-mixed|window(-120d:)"
  "cf-fix-deep-mixed|window(-180d:)"
)

# RNG gate fixture — single seed-locked case that exercises every
# frozen-import call site (doc 56 §11.1).
RNG_GRAPH="synth-mirror-4step"
RNG_DSL="from(m4-delegated).to(m4-success).cohort(7-Mar-26:21-Mar-26)"

# Daily-conversions gate — per §11.1 daily conversions is part of
# the gate set, captured on synth-mirror-4step's terminal edge.
DC_GRAPH="synth-mirror-4step"
DC_DSL="from(m4-registered).to(m4-success).cohort(7-Mar-26:21-Mar-26)"

ANALYSE="$_DAGNET_ROOT/graph-ops/scripts/analyse.sh"
DATA_REPO_PATH="$_DAGNET_ROOT/$DATA_REPO_DIR"
TMPDIR_CAP=$(mktemp -d)
trap "rm -rf $TMPDIR_CAP" EXIT

echo "══════════════════════════════════════════════════════════════"
echo "  Capturing doc 56 baselines → $BASELINE_DIR"
echo "══════════════════════════════════════════════════════════════"

# Emit capture-time metadata
GIT_SHA=$(git -C "$_DAGNET_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
DATA_SHA=$(git -C "$DATA_REPO_PATH" rev-parse HEAD 2>/dev/null || echo "unknown")
python3 <<PY > "$BASELINE_DIR/capture-metadata.json"
import json, datetime
print(json.dumps({
  'captured_at': datetime.datetime.utcnow().isoformat() + 'Z',
  'dagnet_git_sha': "$GIT_SHA",
  'data_repo_git_sha': "$DATA_SHA",
  'tolerances': {
    'deterministic_fields': '|Δ| ≤ 1e-10',
    'mc_quantiles': '|Δ| / value ≤ 2%',
    'rng_hash': 'byte-identical sha256',
  },
  'fixtures': [{'graph': f.split('|')[0], 'dsl': f.split('|')[1]} for f in """$(printf '%s\n' "${FIXTURES[@]}")""".strip().splitlines()],
  'rng_gate': {'graph': "$RNG_GRAPH", 'dsl': "$RNG_DSL"},
  'daily_conversions': {'graph': "$DC_GRAPH", 'dsl': "$DC_DSL"},
}, indent=2))
PY

# ─────────────────────────────────────────────────────────────────
# CF whole-graph per fixture
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── CF whole-graph baselines ──"

declare -A CF_RESULTS_BY_FIXTURE
CF_COMBINED="$BASELINE_DIR/cf-whole-graph.json"
CF_JSON_BUILDER="$TMPDIR_CAP/cf-builder.py"

# Start fresh combined file
echo "{" > "$CF_COMBINED.tmp"
FIRST_ENTRY=true

for entry in "${FIXTURES[@]}"; do
  IFS='|' read -r graph dsl <<< "$entry"
  echo "  $graph ($dsl)"

  CF_FILE="$TMPDIR_CAP/cf_${graph}.json"
  CF_STDERR="$TMPDIR_CAP/cf_${graph}.stderr"

  # Run CF whole-graph; capture stdout (JSON) and stderr (RNG hashes)
  bash "$ANALYSE" "$graph" "$dsl" \
    --type conditioned_forecast --format json \
    > "$CF_FILE" 2> "$CF_STDERR" || true

  # Strip the "Now using node..." nvm line if present
  sed -i '1{/^Now using/d}' "$CF_FILE"

  # Normalise: extract per-edge scalars keyed by from_id->to_id, not
  # UUID. synth_gen regenerates UUIDs on every run; node IDs are
  # stable (doc 17 §2.3, integrity check #9). Each per-edge response
  # carries its own rate_draws_sha256 inside _forensic (forecast_state
  # stashes it into _last_forensic, which the handler appends per edge).
  # skipped_edges keyed by edge_uuid from the response — resolve to
  # from_id->to_id via the graph for stability.
  python3 <<PY > "$TMPDIR_CAP/cf_${graph}_norm.json"
import json

with open("$CF_FILE") as f:
    resp = json.load(f)

with open("$DATA_REPO_PATH/graphs/${graph}.json") as f:
    graph_json = json.load(f)
nmap = {n["uuid"]: n.get("id", "") for n in graph_json.get("nodes", [])}
uuid_to_edge_key = {
    e["uuid"]: f"{nmap.get(e.get('from',''),'')}->{nmap.get(e.get('to',''),'')}"
    for e in graph_json.get("edges", [])
}

scenarios = resp.get("scenarios", [])
edges_out = {}
skipped_out = {}
if scenarios:
    sc = scenarios[0]
    for e in sc.get("edges", []):
        f_dict = e.get("_forensic") or {}
        key = f"{e.get('from_node','')}->{e.get('to_node','')}"
        edges_out[key] = {
            "from_node": e.get("from_node"),
            "to_node": e.get("to_node"),
            "p_mean": e.get("p_mean"),
            "p_sd": e.get("p_sd"),
            "completeness": e.get("completeness"),
            "completeness_sd": e.get("completeness_sd"),
            "rate_draws_sha256": f_dict.get("rate_draws_sha256") if isinstance(f_dict, dict) else None,
        }
    for s in sc.get("skipped_edges", []) or []:
        uuid = s.get("edge_uuid", "")
        key = uuid_to_edge_key.get(uuid, f"uuid:{uuid}")
        skipped_out[key] = {"reason": s.get("reason")}

n_with_hash = sum(1 for e in edges_out.values() if e.get("rate_draws_sha256"))
out = {
    "fixture": "$graph",
    "dsl": "$dsl",
    "n_edges": len(edges_out),
    "n_skipped": len(skipped_out),
    "n_rate_draws_hashes": n_with_hash,
    "edges": edges_out,
    "skipped_edges": skipped_out,
}
print(json.dumps(out, indent=2))
PY

  # Append to combined file
  if [ "$FIRST_ENTRY" = "true" ]; then
    FIRST_ENTRY=false
  else
    echo "," >> "$CF_COMBINED.tmp"
  fi
  echo "  \"$graph\":" >> "$CF_COMBINED.tmp"
  cat "$TMPDIR_CAP/cf_${graph}_norm.json" >> "$CF_COMBINED.tmp"

  N=$(python3 -c "import json; d=json.load(open('$TMPDIR_CAP/cf_${graph}_norm.json')); print(f\"{d['n_edges']} edges, {d['n_skipped']} skipped, {d['n_rate_draws_hashes']} hashes\")")
  echo "    → $N"
done

echo "}" >> "$CF_COMBINED.tmp"
python3 -c "import json; json.dump(json.load(open('$CF_COMBINED.tmp')), open('$CF_COMBINED','w'), indent=2)"
rm "$CF_COMBINED.tmp"
echo "  Wrote $CF_COMBINED"

# ─────────────────────────────────────────────────────────────────
# v3 chart per edge per fixture
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── v3 chart baselines ──"

V3_COMBINED="$BASELINE_DIR/v3-chart.json"
python3 <<PY > "$V3_COMBINED.init"
import json
print(json.dumps({}, indent=2))
PY
cp "$V3_COMBINED.init" "$V3_COMBINED"

for entry in "${FIXTURES[@]}"; do
  IFS='|' read -r graph dsl <<< "$entry"
  echo "  $graph ($dsl)"

  # Enumerate parameterised edges
  GRAPH_FILE="$DATA_REPO_PATH/graphs/${graph}.json"
  EDGE_LIST=$(python3 <<PY
import json
g = json.load(open("$GRAPH_FILE"))
nmap = {n['uuid']: n.get('id','') for n in g['nodes']}
for e in g['edges']:
    p_id = e.get('p',{}).get('id','')
    to_name = nmap.get(e.get('to',''),'')
    from_name = nmap.get(e.get('from',''),'')
    if p_id and 'dropout' not in to_name:
        print(f"{from_name}|{to_name}")
PY
)

  # For each edge, run v3 chart
  FIXTURE_V3="$TMPDIR_CAP/v3_${graph}.json"
  echo "{" > "$FIXTURE_V3"
  FIRST_EDGE=true
  while IFS='|' read -r from_id to_id; do
    [ -z "$from_id" ] && continue
    V3_OUT="$TMPDIR_CAP/v3_${graph}_${from_id}_${to_id}.json"
    bash "$ANALYSE" "$graph" "from(${from_id}).to(${to_id}).${dsl}" \
      --type cohort_maturity --format json 2>/dev/null | sed '1{/^Now using/d}' \
      > "$V3_OUT" || true

    python3 <<PY > "$TMPDIR_CAP/v3_${graph}_${from_id}_${to_id}_norm.json"
import json
try:
    d = json.load(open("$V3_OUT"))
    rows = d.get('result',{}).get('data',[]) or d.get('result',{}).get('maturity_rows',[])
    if rows:
        last = rows[-1]
        out = {
            "tau_days": last.get("tau_days"),
            "midpoint": last.get("midpoint"),
            "fan_upper": last.get("fan_upper"),
            "fan_lower": last.get("fan_lower"),
            "fan_bands": last.get("fan_bands"),
            "model_midpoint": last.get("model_midpoint"),
            "model_bands": last.get("model_bands"),
            "p_infinity_mean": last.get("p_infinity_mean"),
            "p_infinity_sd": last.get("p_infinity_sd"),
            "completeness": last.get("completeness"),
            "completeness_sd": last.get("completeness_sd"),
            "n_rows": len(rows),
        }
    else:
        out = {"error": "no rows returned"}
except Exception as e:
    out = {"error": str(e)}
print(json.dumps(out, indent=2))
PY

    if [ "$FIRST_EDGE" = "true" ]; then
      FIRST_EDGE=false
    else
      echo "," >> "$FIXTURE_V3"
    fi
    echo "    \"${from_id}->${to_id}\":" >> "$FIXTURE_V3"
    cat "$TMPDIR_CAP/v3_${graph}_${from_id}_${to_id}_norm.json" >> "$FIXTURE_V3"
  done <<< "$EDGE_LIST"
  echo "}" >> "$FIXTURE_V3"

  # Merge into combined file
  python3 <<PY
import json
combined = json.load(open("$V3_COMBINED"))
fixture_v3 = json.load(open("$FIXTURE_V3"))
combined["$graph"] = {"dsl": "$dsl", "edges": fixture_v3}
json.dump(combined, open("$V3_COMBINED","w"), indent=2)
PY
  N_EDGES=$(python3 -c "import json; d=json.load(open('$FIXTURE_V3')); print(len(d))")
  echo "    → $N_EDGES edges captured"
done

rm "$V3_COMBINED.init"
echo "  Wrote $V3_COMBINED"

# ─────────────────────────────────────────────────────────────────
# Daily conversions baseline
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── Daily conversions baseline ──"
DC_FILE="$BASELINE_DIR/daily-conversions.json"
DC_RAW="$TMPDIR_CAP/dc_raw.json"

bash "$ANALYSE" "$DC_GRAPH" "$DC_DSL" \
  --type daily_conversions --format json \
  > "$DC_RAW" 2>/dev/null || true
sed -i '1{/^Now using/d}' "$DC_RAW"

python3 <<PY > "$DC_FILE"
import json
try:
    d = json.load(open("$DC_RAW"))
    result = d.get("result", {})
    # daily_conversions returns per-anchor-day rows; store as-is minus
    # any non-deterministic decoration
    rows = result.get("data", []) or result.get("rows", []) or []
    out = {
        "fixture": "$DC_GRAPH",
        "dsl": "$DC_DSL",
        "n_rows": len(rows),
        "rows": rows,
    }
except Exception as e:
    out = {"fixture": "$DC_GRAPH", "dsl": "$DC_DSL", "error": str(e)}
print(json.dumps(out, indent=2))
PY
echo "  Wrote $DC_FILE ($(python3 -c "import json; print(json.load(open('$DC_FILE')).get('n_rows', 'err'))") rows)"

# ─────────────────────────────────────────────────────────────────
# RNG byte-identical gate
# ─────────────────────────────────────────────────────────────────
echo ""
echo "── RNG byte-identical gate ──"
RNG_FILE="$BASELINE_DIR/rng-gate.json"
RNG_STDOUT="$TMPDIR_CAP/rng_stdout.txt"
RNG_STDERR="$TMPDIR_CAP/rng_stderr.txt"

# Run CF in single-edge mode with the named RNG gate DSL
bash "$ANALYSE" "$RNG_GRAPH" "$RNG_DSL" \
  --type conditioned_forecast --format json \
  > "$RNG_STDOUT" 2> "$RNG_STDERR" || true

sed -i '1{/^Now using/d}' "$RNG_STDOUT"

python3 <<PY > "$RNG_FILE"
import json

hashes = []
try:
    with open("$RNG_STDOUT") as f:
        resp = json.load(f)
    for sc in resp.get("scenarios", []) or []:
        for e in sc.get("edges", []) or []:
            fd = e.get("_forensic") or {}
            if isinstance(fd, dict):
                h = fd.get("rate_draws_sha256")
                if h:
                    hashes.append(h)
except Exception as e:
    pass

out = {
    "fixture": "$RNG_GRAPH",
    "dsl": "$RNG_DSL",
    "description": "Byte-identical RNG gate (doc 56 §11.1). Single-edge cohort mode exercising span kernel + build_span_params + XProvider + build_upstream_carrier Tier 2 + compute_forecast_trajectory with full 14-param signature.",
    "n_hashes": len(hashes),
    "rate_draws_sha256": hashes,
}
print(json.dumps(out, indent=2))
PY

RNG_N=$(python3 -c "import json; print(json.load(open('$RNG_FILE'))['n_hashes'])")
echo "  Wrote $RNG_FILE ($RNG_N hash(es) captured)"

# ─────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Baseline capture complete"
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "Written to $BASELINE_DIR:"
ls -la "$BASELINE_DIR"
echo ""
echo "Next: commit these artefacts. Any future re-capture must be"
echo "a standalone commit with explicit before/after deltas."
