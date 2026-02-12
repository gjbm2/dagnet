#!/usr/bin/env bash
# extract-mark-logs.sh — Extract log windows around a DagNet debug mark,
#                         or trim log files to a manageable size.
#
# EXTRACT MODE (default):
#   scripts/extract-mark-logs.sh <mark-label> [--all] [--console-only | --session-only]
#
#   <mark-label>    Substring to match against mark labels (case-insensitive).
#                   If multiple marks match, the LAST one is used (unless --all).
#   --all           Show every matching mark window, not just the last.
#   --console-only  Only extract from the browser-console stream.
#   --session-only  Only extract from the session-log stream.
#
# TRIM MODE:
#   scripts/extract-mark-logs.sh --trim [N]
#
#   Trims each log file to the last N lines (default: 20000).
#   Cuts on a mark boundary when possible so partial windows aren't left behind.
#   Reports before/after line counts.
#
# The script is designed to be called by the Cursor agent when the user says
# "inspect mark '<label>'".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONSOLE_LOG="$REPO_ROOT/debug/tmp.browser-console.jsonl"
SESSION_LOG="$REPO_ROOT/debug/tmp.session-log.jsonl"
SNAPSHOTS_DIR="$REPO_ROOT/debug/graph-snapshots"

# ── Argument parsing ────────────────────────────────────────────────
LABEL=""
ALL=false
CONSOLE_ONLY=false
SESSION_ONLY=false
TRIM_MODE=false
TRIM_KEEP=20000

for arg in "$@"; do
  case "$arg" in
    --all)          ALL=true ;;
    --console-only) CONSOLE_ONLY=true ;;
    --session-only) SESSION_ONLY=true ;;
    --trim)         TRIM_MODE=true ;;
    -*)             echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)
      # If --trim was the previous flag and this is a number, treat as keep count
      if [[ "$TRIM_MODE" == "true" && "$arg" =~ ^[0-9]+$ && -z "$LABEL" ]]; then
        TRIM_KEEP="$arg"
      else
        LABEL="$arg"
      fi
      ;;
  esac
done

if [[ "$TRIM_MODE" != "true" && -z "$LABEL" ]]; then
  echo "Usage:" >&2
  echo "  scripts/extract-mark-logs.sh <mark-label> [--all] [--console-only | --session-only]" >&2
  echo "  scripts/extract-mark-logs.sh --trim [N]   (default N=20000)" >&2
  exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────

# extract_window FILE MARK_PATTERN
#   Finds all marks matching the pattern, then for the chosen mark(s)
#   prints from that line to (but not including) the next mark.
extract_window() {
  local file="$1"
  local pattern="$2"
  local stream_name="$3"

  if [[ ! -f "$file" ]]; then
    echo "  ⚠  $stream_name file not found: $file"
    return
  fi

  # Collect all matching mark line numbers + labels
  local mark_lines
  mark_lines=$(grep -n -i "$pattern" "$file" || true)

  if [[ -z "$mark_lines" ]]; then
    echo "  (no marks matching '$LABEL' in $stream_name)"
    return
  fi

  # Collect ALL mark line numbers in the file (for windowing)
  local all_mark_lines
  all_mark_lines=$(grep -n "$4" "$file" | cut -d: -f1)

  # Decide which matching marks to show
  local chosen_lines
  if [[ "$ALL" == "true" ]]; then
    chosen_lines=$(echo "$mark_lines" | cut -d: -f1)
  else
    chosen_lines=$(echo "$mark_lines" | tail -n1 | cut -d: -f1)
  fi

  local total_lines
  total_lines=$(wc -l < "$file")

  for start_line in $chosen_lines; do
    # Find the next mark AFTER this one
    local end_line=""
    for ml in $all_mark_lines; do
      if (( ml > start_line )); then
        end_line=$ml
        break
      fi
    done

    # Print the mark header line
    local mark_meta
    mark_meta=$(sed -n "${start_line}p" "$file")
    local mark_label mark_ts
    # Extract label/message from JSON (portable: no jq dependency)
    mark_label=$(echo "$mark_meta" | grep -oP '"(label|message)"\s*:\s*"[^"]*"' | head -1 | grep -oP ':\s*"\K[^"]+')
    mark_ts=$(echo "$mark_meta" | grep -oP '"ts_ms"\s*:\s*\K[0-9]+')

    echo ""
    echo "─── $stream_name: mark '$mark_label' (ts=$mark_ts) ───"
    echo "    lines $start_line → ${end_line:-$total_lines} of $total_lines"
    echo ""

    if [[ -n "$end_line" ]]; then
      # Exclude the next mark line itself
      local last=$(( end_line - 1 ))
      sed -n "${start_line},${last}p" "$file"
    else
      sed -n "${start_line},\$p" "$file"
    fi
  done
}

# ── Trim helper ─────────────────────────────────────────────────────

# trim_file FILE KEEP MARK_PATTERN
#   Keeps the last KEEP lines of FILE, snapping the cut point forward to the
#   nearest mark boundary so we don't leave a partial window at the top.
trim_file() {
  local file="$1"
  local keep="$2"
  local mark_pattern="$3"
  local name
  name="$(basename "$file")"

  if [[ ! -f "$file" ]]; then
    echo "  ⚠  $name: not found, skipping"
    return
  fi

  local total
  total=$(wc -l < "$file")

  if (( total <= keep )); then
    echo "  $name: ${total} lines — already within limit ($keep), nothing to do"
    return
  fi

  # Naive cut point: line number where the kept tail begins
  local naive_cut=$(( total - keep + 1 ))

  # Try to snap forward to the first mark at or after naive_cut so the file
  # starts cleanly on a mark boundary.
  local snap_cut="$naive_cut"
  local first_mark_after
  first_mark_after=$(tail -n +"$naive_cut" "$file" \
    | grep -n "$mark_pattern" \
    | head -n 1 \
    | cut -d: -f1 || true)

  if [[ -n "$first_mark_after" ]]; then
    # grep -n line numbers are 1-based relative to the tail output
    snap_cut=$(( naive_cut + first_mark_after - 1 ))
  fi

  local kept=$(( total - snap_cut + 1 ))
  local removed=$(( snap_cut - 1 ))

  # Atomic replace via temp file
  local tmp="${file}.trim-tmp"
  tail -n +"$snap_cut" "$file" > "$tmp"
  mv "$tmp" "$file"

  echo "  $name: ${total} → ${kept} lines (removed ${removed}, snapped to mark boundary)"
}

# ── Trim mode ───────────────────────────────────────────────────────

if [[ "$TRIM_MODE" == "true" ]]; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  extract-mark-logs --trim: keeping last $TRIM_KEEP lines"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  trim_file "$CONSOLE_LOG" "$TRIM_KEEP" '"kind":"mark"'
  trim_file "$SESSION_LOG" "$TRIM_KEEP" '"operation":"DEV_MARK"'
  echo ""
  echo "Done."
  exit 0
fi

# ── Main (extract mode) ────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  extract-mark-logs: searching for mark '$LABEL'"
echo "╚══════════════════════════════════════════════════════════════╝"

# Console stream
if [[ "$SESSION_ONLY" != "true" ]]; then
  echo ""
  echo "━━━ CONSOLE STREAM ━━━"
  extract_window "$CONSOLE_LOG" "\"kind\":\"mark\".*$LABEL" "console" '"kind":"mark"'
fi

# Session stream
if [[ "$CONSOLE_ONLY" != "true" ]]; then
  echo ""
  echo "━━━ SESSION STREAM ━━━"
  extract_window "$SESSION_LOG" "\"operation\":\"DEV_MARK\".*$LABEL" "session" '"operation":"DEV_MARK"'
fi

# Graph snapshots
echo ""
echo "━━━ GRAPH SNAPSHOTS ━━━"
if [[ -d "$SNAPSHOTS_DIR" ]]; then
  # Slugify the label for matching: lowercase, spaces/special → dashes
  SLUG=$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  MATCHES=$(find "$SNAPSHOTS_DIR" -name "*${SLUG}*" -type f 2>/dev/null | sort || true)
  if [[ -n "$MATCHES" ]]; then
    echo "$MATCHES" | while read -r f; do
      echo "  $(basename "$f")"
    done
  else
    echo "  (no snapshots matching slug '$SLUG')"
  fi
else
  echo "  ⚠  Snapshots directory not found: $SNAPSHOTS_DIR"
fi

echo ""
echo "Done."
