#!/usr/bin/env bash
# Clear finished graphs from the bayes-monitor DISPLAY.
# Does NOT touch log files — they are primary diagnostic data.
# Writes hidden graph names to /tmp/_bayes_monitor_hidden so the
# monitor status loop skips them.
hidden=0
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
    # Hide from monitor display (log file untouched)
    echo "$name" >> /tmp/_bayes_monitor_hidden
    # Clean up tail scripts (display artefacts, not data)
    rm -f "/tmp/_bayes_tail_${name}.sh" 2>/dev/null
    hidden=$((hidden + 1))
done
echo "Hidden ${hidden} finished graph(s) from monitor display. Log files preserved."
