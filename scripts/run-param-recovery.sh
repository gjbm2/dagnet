#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Run param recovery on synth graphs in parallel.
#
# Launches param_recovery.py as background processes — one per graph,
# each using --chains/--cores to control CPU budget. Output goes to
# /tmp/bayes_recovery-{graph}.log per graph; the harness also writes
# its own log to /tmp/bayes_harness-{graph}.log.
#
# Use scripts/bayes-monitor.sh to watch progress and tail logs.
#
# Usage:
#   scripts/run-param-recovery.sh                          # all synth graphs
#   scripts/run-param-recovery.sh synth-simple-abc         # one graph
#   scripts/run-param-recovery.sh synth-simple-abc synth-mirror-4step
#   scripts/run-param-recovery.sh --list                   # list available
#
# Options:
#   --chains N    Chains per graph (default: 3)
#   --draws N     MCMC draws per chain (default: 1000)
#   --tune N      Warmup steps per chain (default: 500)
#   --timeout N   Hard timeout in seconds (default: 600)
#   --list        List available synth graphs and exit
#
# Core budget: chains × num_graphs. Default 3 chains × 3 graphs = 9 cores.
# Adjust --chains based on how many graphs you're running vs available cores.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV_ACTIVATE=". ${REPO_ROOT}/graph-editor/venv/bin/activate"

# Read data repo path
DATA_REPO_DIR=""
if [[ -f "${REPO_ROOT}/.private-repos.conf" ]]; then
    DATA_REPO_DIR=$(grep '^DATA_REPO_DIR=' "${REPO_ROOT}/.private-repos.conf" | cut -d= -f2 | tr -d '"')
fi
GRAPHS_DIR="${REPO_ROOT}/${DATA_REPO_DIR}/graphs"

if [[ ! -d "$GRAPHS_DIR" ]]; then
    echo "ERROR: Data repo graphs dir not found: ${GRAPHS_DIR}"
    exit 1
fi

# Discover synth graphs with both .json and .truth.yaml
discover_graphs() {
    for f in "${GRAPHS_DIR}"/synth-*.truth.yaml; do
        [[ -f "$f" ]] || continue
        local name
        name=$(basename "$f" .truth.yaml)
        [[ -f "${GRAPHS_DIR}/${name}.json" ]] && echo "$name"
    done
}

AVAILABLE=()
while IFS= read -r g; do AVAILABLE+=("$g"); done < <(discover_graphs)

# Parse arguments
CHAINS=3
DRAWS=1000
TUNE=500
TIMEOUT=600
SELECTED=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --list)
            echo "Available synth graphs:"
            for g in "${AVAILABLE[@]}"; do echo "  $g"; done
            exit 0 ;;
        --chains)  CHAINS="$2"; shift 2 ;;
        --draws)   DRAWS="$2"; shift 2 ;;
        --tune)    TUNE="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        -*)        echo "Unknown option: $1"; exit 1 ;;
        *)         SELECTED+=("$1"); shift ;;
    esac
done

[[ ${#SELECTED[@]} -eq 0 ]] && SELECTED=("${AVAILABLE[@]}")

# Validate
for graph in "${SELECTED[@]}"; do
    found=0
    for a in "${AVAILABLE[@]}"; do [[ "$a" == "$graph" ]] && found=1 && break; done
    if [[ $found -eq 0 ]]; then
        echo "ERROR: Unknown synth graph: $graph"
        echo "Available:"; for g in "${AVAILABLE[@]}"; do echo "  $g"; done
        exit 1
    fi
done

CORES=$CHAINS
TOTAL_CORES=$(( CORES * ${#SELECTED[@]} ))

echo "=== Param Recovery ==="
echo "Graphs:  ${#SELECTED[@]}"
for g in "${SELECTED[@]}"; do echo "  - $g"; done
echo "Config:  ${CHAINS} chains, ${DRAWS} draws, ${TUNE} tune, ${TIMEOUT}s timeout"
echo "Cores:   ${CORES}/graph × ${#SELECTED[@]} = ${TOTAL_CORES} total"
echo ""

# Launch each graph as a background process
PIDS=()
for graph in "${SELECTED[@]}"; do
    LOG="/tmp/bayes_recovery-${graph}.log"
    # Truncate logs (pre-create harness log so monitor can find it immediately)
    > "$LOG"
    > "/tmp/bayes_harness-${graph}.log"

    (
        eval "$VENV_ACTIVATE"
        cd "$REPO_ROOT"
        python bayes/param_recovery.py \
            --graph "$graph" \
            --chains "$CHAINS" \
            --cores "$CORES" \
            --draws "$DRAWS" \
            --tune "$TUNE" \
            --timeout "$TIMEOUT" \
            >> "$LOG" 2>&1
        echo "" >> "$LOG"
        echo "=== FINISHED: $graph (exit $?) ===" >> "$LOG"
    ) &
    PIDS+=($!)
    echo "  Started ${graph} (PID $!, log: ${LOG})"
done

echo ""
echo "${#PIDS[@]} processes launched."
echo ""
echo "Monitor:  scripts/bayes-monitor.sh"
echo "Kill all: kill ${PIDS[*]}"
echo ""

# Write PID file and graph list so the monitor can find active runs
PID_FILE="/tmp/bayes_recovery_pids"
GRAPH_LIST="/tmp/bayes_recovery_graphs"
printf "%s\n" "${PIDS[@]}" > "$PID_FILE"
printf "%s\n" "${SELECTED[@]}" > "$GRAPH_LIST"

# Wait for all to finish
FAILURES=0
for i in "${!PIDS[@]}"; do
    if wait "${PIDS[$i]}"; then
        echo "  DONE: ${SELECTED[$i]} — PASS"
    else
        echo "  DONE: ${SELECTED[$i]} — FAIL (exit $?)"
        FAILURES=$((FAILURES + 1))
    fi
done

rm -f "$PID_FILE" "$GRAPH_LIST"

echo ""
if [[ $FAILURES -eq 0 ]]; then
    echo "=== ALL PASSED ==="
else
    echo "=== ${FAILURES}/${#SELECTED[@]} FAILED ==="
    exit 1
fi
