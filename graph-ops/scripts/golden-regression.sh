#!/usr/bin/env bash
# Golden regression test for analysis request contract.
#
# Runs CLI analyse for each analysis type, compares response against
# golden files captured before the refactor. Reports PASS/FAIL per type.
#
# Usage:
#   bash graph-ops/scripts/golden-regression.sh
#   bash graph-ops/scripts/golden-regression.sh --update   # re-capture golden files
#
# Prerequisites:
#   - Python BE running (localhost:9000)
#   - Data repo available
#   - Node via nvm

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

GOLDEN_DIR="$_DAGNET_ROOT/graph-editor/src/cli/__tests__/golden"
ACTUAL_DIR="$_DAGNET_ROOT/graph-editor/src/cli/__tests__/golden/.actual"
GRAPH_NAME="conversion-flow-v2-recs-collapsed"

# Set up Node
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi
cd "$_DAGNET_ROOT/graph-editor"
if [ -f .nvmrc ]; then
  nvm use "$(cat .nvmrc)" 2>/dev/null || true
fi

UPDATE_MODE=false
if [ "${1:-}" = "--update" ]; then
  UPDATE_MODE=true
fi

mkdir -p "$ACTUAL_DIR"

# Define test cases: name | cli args
declare -a TESTS=(
  "graph_overview|--query window(-30d:) --type graph_overview"
  "to_node_reach|--query to(switch-success).window(-30d:) --type to_node_reach"
  "from_node_outcomes|--query from(household-delegated).window(-30d:) --type from_node_outcomes"
  "path_between|--query from(household-delegated).to(switch-success).window(-30d:) --type path_between"
  "bridge_view|--scenario window(-90d:-30d) --scenario window(-30d:) --subject to(switch-success) --type bridge_view"
  "cohort_maturity|--query from(household-delegated).to(switch-registered).cohort(-90d:) --type cohort_maturity"
  "surprise_gauge|--query from(household-delegated).to(switch-registered).window(-30d:) --type surprise_gauge"
)

PASS=0
FAIL=0
SKIP=0

for entry in "${TESTS[@]}"; do
  NAME="${entry%%|*}"
  ARGS="${entry#*|}"
  GOLDEN_FILE="$GOLDEN_DIR/$NAME.json"
  ACTUAL_FILE="$ACTUAL_DIR/$NAME.json"

  # Run CLI
  # shellcheck disable=SC2086
  if ! npx tsx src/cli/analyse.ts \
    --graph "$DATA_REPO_PATH" \
    --name "$GRAPH_NAME" \
    $ARGS \
    --format json 2>/dev/null > "$ACTUAL_FILE"; then
    echo "FAIL  $NAME  (CLI error)"
    FAIL=$((FAIL + 1))
    continue
  fi

  if $UPDATE_MODE; then
    cp "$ACTUAL_FILE" "$GOLDEN_FILE"
    echo "UPDATE  $NAME"
    continue
  fi

  if [ ! -f "$GOLDEN_FILE" ]; then
    echo "SKIP  $NAME  (no golden file — run with --update to create)"
    SKIP=$((SKIP + 1))
    continue
  fi

  # Compare: success flag, analysis_type, data row count, and key values
  RESULT=$(python3 -c "
import json, sys

def load(path):
    with open(path) as f:
        return json.load(f)

golden = load('$GOLDEN_FILE')
actual = load('$ACTUAL_FILE')

errors = []

# Check success
if golden.get('success') != actual.get('success'):
    errors.append(f'success: golden={golden.get(\"success\")} actual={actual.get(\"success\")}')

gr = golden.get('result', {})
ar = actual.get('result', {})

# Check analysis_type
if gr.get('analysis_type') != ar.get('analysis_type'):
    errors.append(f'analysis_type: golden={gr.get(\"analysis_type\")} actual={ar.get(\"analysis_type\")}')

# Check data row count
def row_count(r):
    for key in ('data', 'frames', 'maturity_rows'):
        if key in r and isinstance(r[key], list):
            return len(r[key])
    return 0

gc = row_count(gr)
ac = row_count(ar)
if gc != ac:
    errors.append(f'row_count: golden={gc} actual={ac}')

# For types with numeric data, check key values within tolerance
gdata = gr.get('data', [])
adata = ar.get('data', [])
if gdata and adata and len(gdata) == len(adata):
    for i, (gd, ad) in enumerate(zip(gdata, adata)):
        for key in ('probability', 'total', 'reach_a', 'reach_b', 'delta'):
            gv = gd.get(key)
            av = ad.get(key)
            if gv is None and av is None:
                continue
            if gv is None or av is None:
                errors.append(f'data[{i}].{key}: golden={gv} actual={av}')
                continue
            if isinstance(gv, (int, float)) and isinstance(av, (int, float)):
                if abs(gv - av) > 1e-6:
                    errors.append(f'data[{i}].{key}: golden={gv:.8f} actual={av:.8f}')

# Check metadata key values
gm = gr.get('metadata', {})
am = ar.get('metadata', {})
for key in ('reach_a', 'reach_b', 'delta'):
    gv = gm.get(key)
    av = am.get(key)
    if gv is None and av is None:
        continue
    if isinstance(gv, (int, float)) and isinstance(av, (int, float)):
        if abs(gv - av) > 1e-6:
            errors.append(f'metadata.{key}: golden={gv:.8f} actual={av:.8f}')

if errors:
    print('FAIL|' + '; '.join(errors))
else:
    print('PASS')
" 2>&1)

  if [[ "$RESULT" == PASS ]]; then
    echo "PASS  $NAME"
    PASS=$((PASS + 1))
  else
    REASON="${RESULT#FAIL|}"
    echo "FAIL  $NAME  ($REASON)"
    FAIL=$((FAIL + 1))
  fi
done

# Clean up actuals on success
if [ $FAIL -eq 0 ] && [ $SKIP -eq 0 ] && ! $UPDATE_MODE; then
  rm -rf "$ACTUAL_DIR"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="

if [ $FAIL -gt 0 ]; then
  exit 1
fi
