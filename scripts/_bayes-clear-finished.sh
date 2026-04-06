#!/usr/bin/env bash
cleared=0
for f in /tmp/bayes_harness-*.log; do
    [[ -f "$f" ]] || continue
    name=$(basename "$f" .log)
    name="${name#bayes_harness-}"
    lock="/tmp/bayes-harness-${name}.lock"
    # Skip if process is still running
    if [[ -f "$lock" ]]; then
        pid=$(cat "$lock" 2>/dev/null)
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            continue
        fi
        rm -f "$lock" 2>/dev/null
    fi
    rm -f "$f" 2>/dev/null
    cleared=$((cleared + 1))
done
# Also clean up the initial graphs list so status loop stops showing them
: > /tmp/_bayes_monitor_initial_graphs 2>/dev/null
echo "Cleared ${cleared} finished log(s)."
