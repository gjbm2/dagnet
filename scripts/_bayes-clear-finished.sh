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
    rm -f "/tmp/_bayes_tail_${name}.sh" 2>/dev/null
    cleared=$((cleared + 1))
done
echo "Cleared ${cleared} finished log(s)."
