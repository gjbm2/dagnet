#!/usr/bin/env bash
for lock in /tmp/bayes-harness-*.lock; do
    [[ -f "$lock" ]] || continue
    pid=$(cat "$lock" 2>/dev/null)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
    rm -f "$lock" 2>/dev/null
done
if [[ -f /tmp/bayes_recovery_pids ]]; then
    while read -r pid; do
        kill "$pid" 2>/dev/null || true
    done < /tmp/bayes_recovery_pids
    rm -f /tmp/bayes_recovery_pids
fi
