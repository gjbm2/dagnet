#!/usr/bin/env bash
# dev-server-check.sh — Verify dev servers have picked up code changes.
#
# Usage:
#   scripts/dev-server-check.sh [file ...]
#
#   With file args:  checks whether each file's mtime is older than the
#                    relevant server's boot time (i.e. the server reloaded
#                    AFTER the file was saved). Retries up to 5s for Python
#                    (uvicorn reload takes 1-2s).
#
#   Without args:    just reports both servers' boot times and PIDs.
#
# Exit codes:
#   0  All servers are fresh (or no files to check)
#   1  At least one server is stale after retries
#   2  A server is unreachable (not running)
#
# Designed for agent use: parse the FRESH / STALE / UNREACHABLE lines.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Read ports from .env.local (same source as dev-start.sh)
ENV_LOCAL="$REPO_ROOT/graph-editor/.env.local"
VITE_PORT=5173
PYTHON_PORT=9000
if [[ -f "$ENV_LOCAL" ]]; then
  val=$(grep -E '^VITE_PORT=' "$ENV_LOCAL" 2>/dev/null | tail -1 | cut -d= -f2)
  [[ -n "$val" ]] && VITE_PORT="$val"
  val=$(grep -E '^PYTHON_API_PORT=' "$ENV_LOCAL" 2>/dev/null | tail -1 | cut -d= -f2)
  [[ -n "$val" ]] && PYTHON_PORT="$val"
fi

VITE_URL="http://localhost:${VITE_PORT}/__dagnet/server-info"
PYTHON_URL="http://localhost:${PYTHON_PORT}/__dagnet/server-info"

# Fetch server info. Returns JSON or empty string on failure.
fetch_info() {
  curl -s --max-time 2 "$1" 2>/dev/null || echo ""
}

# Extract boot_epoch from JSON (lightweight — no jq dependency).
parse_epoch() {
  echo "$1" | grep -oP '"boot_epoch"\s*:\s*\K[0-9]+(\.[0-9]+)?' || echo ""
}

parse_pid() {
  echo "$1" | grep -oP '"pid"\s*:\s*\K[0-9]+' || echo ""
}

# Get file mtime as epoch (GNU stat).
file_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || echo ""
}

# Human-readable epoch delta.
fmt_delta() {
  local delta
  delta=$(echo "$1" | awk '{printf "%.1f", $1}')
  echo "${delta}s"
}

# ── Report mode (no args) ────────────────────────────────────────────

if [[ $# -eq 0 ]]; then
  echo "=== Dev Server Status ==="
  echo ""

  vite_json=$(fetch_info "$VITE_URL")
  if [[ -n "$vite_json" ]]; then
    vite_boot=$(parse_epoch "$vite_json")
    vite_pid=$(parse_pid "$vite_json")
    vite_age=$(awk "BEGIN {printf \"%.0f\", $(date +%s) - $vite_boot}")
    echo "Vite:   PID=$vite_pid  boot=${vite_boot}  age=${vite_age}s  (port $VITE_PORT)"
  else
    echo "Vite:   UNREACHABLE on port $VITE_PORT"
  fi

  py_json=$(fetch_info "$PYTHON_URL")
  if [[ -n "$py_json" ]]; then
    py_boot=$(parse_epoch "$py_json")
    py_pid=$(parse_pid "$py_json")
    py_age=$(awk "BEGIN {printf \"%.0f\", $(date +%s) - $py_boot}")
    echo "Python: PID=$py_pid  boot=${py_boot}  age=${py_age}s  (port $PYTHON_PORT)"
  else
    echo "Python: UNREACHABLE on port $PYTHON_PORT"
  fi

  exit 0
fi

# ── File check mode ──────────────────────────────────────────────────

overall_exit=0

for filepath in "$@"; do
  # Resolve relative paths from repo root
  if [[ ! "$filepath" = /* ]]; then
    filepath="$REPO_ROOT/$filepath"
  fi

  if [[ ! -f "$filepath" ]]; then
    echo "SKIP: $filepath (file not found)"
    continue
  fi

  mtime=$(file_mtime "$filepath")
  if [[ -z "$mtime" ]]; then
    echo "SKIP: $filepath (cannot read mtime)"
    continue
  fi

  # Determine which server to check based on file extension.
  ext="${filepath##*.}"
  case "$ext" in
    py)   server="python"; url="$PYTHON_URL"; port="$PYTHON_PORT" ;;
    ts|tsx|js|jsx|css|json)
          server="vite";   url="$VITE_URL";   port="$VITE_PORT" ;;
    *)    server="python";  url="$PYTHON_URL"; port="$PYTHON_PORT" ;;
  esac

  # For Python, retry up to 5s (uvicorn reload takes 1-2s).
  # For Vite, HMR is near-instant — single check suffices.
  max_attempts=1
  delay=0.5
  if [[ "$server" == "python" ]]; then
    max_attempts=10
  fi

  fresh=false
  for (( attempt=1; attempt<=max_attempts; attempt++ )); do
    info_json=$(fetch_info "$url")
    if [[ -z "$info_json" ]]; then
      echo "UNREACHABLE: $server server on port $port — is it running?"
      overall_exit=2
      break 2  # Can't check further files on this server
    fi

    boot=$(parse_epoch "$info_json")
    if [[ -z "$boot" ]]; then
      echo "ERROR: Could not parse boot_epoch from $server server"
      overall_exit=1
      break
    fi

    # Compare: boot_epoch >= mtime means server reloaded after file was saved.
    is_fresh=$(awk "BEGIN {print ($boot >= $mtime) ? 1 : 0}")
    if [[ "$is_fresh" == "1" ]]; then
      fresh=true
      delta=$(awk "BEGIN {print $boot - $mtime}")
      rel_path="${filepath#$REPO_ROOT/}"
      echo "FRESH: $rel_path — $server server reloaded $(fmt_delta "$delta") after save"
      break
    fi

    if (( attempt < max_attempts )); then
      sleep "$delay"
    fi
  done

  if [[ "$fresh" == false && "$overall_exit" -lt 2 ]]; then
    boot=$(parse_epoch "$(fetch_info "$url")")
    delta=$(awk "BEGIN {print $mtime - $boot}")
    rel_path="${filepath#$REPO_ROOT/}"
    echo "STALE: $rel_path — $server server boot is $(fmt_delta "$delta") BEFORE file save"
    echo "       Server has not reloaded. Check for syntax errors in the $server terminal pane."
    overall_exit=1
  fi
done

if [[ "$overall_exit" -eq 0 ]]; then
  echo ""
  echo "All checked files are live. If the bug persists, it is in your code."
fi

exit "$overall_exit"
