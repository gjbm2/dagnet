#!/usr/bin/env bash
# Hunt for Phase 2 pathological region on synth-skip-context.
# Runs repeatedly until Phase 2 takes >120s (normal is ~40s).
# Phase 1 dump is saved automatically by the worker at
# /tmp/bayes_debug-graph-{graph}/ before Phase 2 starts.
# On detection, the dump is preserved and the script exits.
#
# Usage:
#   scripts/hunt-phase2-pathology.sh [graph-name]
#   scripts/hunt-phase2-pathology.sh synth-diamond-context
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
eval ". ${REPO_ROOT}/graph-editor/venv/bin/activate"
cd "$REPO_ROOT"

GRAPH="${1:-synth-skip-context}"
SAMPLING="--tune 2000 --draws 2000 --chains 2"
FEATURES="--feature centred_latency_slices=true"
PHASE2_TIMEOUT=300
HARD_TIMEOUT=1200
MAX_ATTEMPTS=10
DUMP_DIR="/tmp/bayes_debug-graph-${GRAPH}"
PRESERVED_DIR="/tmp/bayes_phase2_pathology_dump"

echo "=== Phase 2 Pathology Hunt ==="
echo "Graph:        ${GRAPH}"
echo "P2 threshold: ${PHASE2_TIMEOUT}s"
echo "Hard timeout: ${HARD_TIMEOUT}s per attempt"
echo "Max attempts: ${MAX_ATTEMPTS}"
echo "Dump dir:     ${DUMP_DIR}"
echo ""

detect_and_preserve() {
    local attempt="$1"
    local log="$2"
    local reason="$3"

    echo ""
    echo "  *** PATHOLOGY DETECTED (attempt ${attempt}): ${reason} ***"

    # Preserve the dump before next attempt overwrites it
    if [[ -d "$DUMP_DIR" ]]; then
        cp -r "$DUMP_DIR" "$PRESERVED_DIR"
        echo "  Dump preserved: ${PRESERVED_DIR}/"
        echo "  Contents:"
        ls -la "$PRESERVED_DIR"/ 2>/dev/null | grep -v "^total" | sed 's/^/    /'
    else
        echo "  WARNING: dump dir not found at ${DUMP_DIR}"
    fi

    # Also preserve the harness log (has model diagnostics via tee)
    local harness_log="/tmp/bayes_harness-hunt-${attempt}.log"
    if [[ -f "$harness_log" && -s "$harness_log" ]]; then
        cp "$harness_log" "${PRESERVED_DIR}/harness.log"
        echo "  Harness log: ${PRESERVED_DIR}/harness.log"
    fi
    cp "$log" "${PRESERVED_DIR}/hunt.log"

    echo ""
    echo "  Replay Phase 2 only:"
    echo "    . graph-editor/venv/bin/activate"
    echo "    python bayes/test_harness.py --graph ${GRAPH} --fe-payload \\"
    echo "      ${SAMPLING} ${FEATURES} \\"
    echo "      --phase2-from-dump ${PRESERVED_DIR}"
    echo ""
}

for i in $(seq 1 "$MAX_ATTEMPTS"); do
    echo -n "  Attempt ${i}/${MAX_ATTEMPTS}: "

    LOG="/tmp/bayes_hunt_${i}.log"

    # shellcheck disable=SC2086
    timeout "$HARD_TIMEOUT" python bayes/test_harness.py \
        --graph "$GRAPH" \
        --fe-payload \
        $SAMPLING \
        $FEATURES \
        --timeout 0 \
        --job-label "hunt-${i}" \
        > "$LOG" 2>&1

    EXIT=$?

    # Clean up any orphaned processes from this attempt
    pkill -f "job-label hunt-${i}" 2>/dev/null || true

    # Extract Phase 2 timing from structured output (sampling_phase2_ms)
    P2_MS=$(grep "sampling_phase2_ms" "$LOG" 2>/dev/null \
        | grep -oP '\d+(?=ms)' | tail -1 || true)
    P2_LAST=$(( P2_MS / 1000 )) 2>/dev/null || P2_LAST=""
    STATUS=$(grep "^Status:" "$LOG" 2>/dev/null \
        | tail -1 | awk '{print $2}')
    STATUS="${STATUS:-unknown}"

    if [[ $EXIT -eq 124 ]]; then
        echo "TIMEOUT (>${HARD_TIMEOUT}s)"
        detect_and_preserve "$i" "$LOG" "hard timeout after ${HARD_TIMEOUT}s"
        exit 0
    elif [[ -n "$P2_LAST" && "$P2_LAST" -gt "$PHASE2_TIMEOUT" ]]; then
        echo "SLOW (p2=${P2_LAST}s, status=${STATUS})"
        detect_and_preserve "$i" "$LOG" "Phase 2 took ${P2_LAST}s (threshold ${PHASE2_TIMEOUT}s)"
        exit 0
    else
        echo "OK (status=${STATUS}, exit=${EXIT}, p2=${P2_LAST:-n/a}s)"
    fi
done

echo ""
echo "No pathology in ${MAX_ATTEMPTS} attempts."
echo "Phase 2 completed within ${PHASE2_TIMEOUT}s every time."
