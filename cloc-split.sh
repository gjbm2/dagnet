#!/usr/bin/env bash
set -euo pipefail

# cloc-split: run cloc on a target, splitting test vs non-test output
# Usage: cloc-split [DIR] [extra cloc args...]
# Default DIR is .

TARGET="${1:-.}"
shift 2>/dev/null || true

# Standard excludes
EXCLUDE_DIRS="node_modules,dist,build,venv,.git,coverage,.next,out,.turbo,.cache"

# Exclude private repo dirs (same logic as loc.sh)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/.private-repos.conf"
if [ -f "$CONF" ]; then
  _data_dir=$(grep '^DATA_REPO_DIR=' "$CONF" | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  _mono_dir=$(grep '^MONOREPO_DIR=' "$CONF" | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  _cwd=$(cd "$TARGET" && pwd)
  _inside_private=false
  [ -n "${_data_dir:-}" ] && [[ "$_cwd" == "$SCRIPT_DIR/$_data_dir"* ]] && _inside_private=true
  [ -n "${_mono_dir:-}" ] && [[ "$_cwd" == "$SCRIPT_DIR/$_mono_dir"* ]] && _inside_private=true
  if [ "$_inside_private" = false ]; then
    [ -n "${_data_dir:-}" ] && EXCLUDE_DIRS="$EXCLUDE_DIRS,$_data_dir"
    [ -n "${_mono_dir:-}" ] && EXCLUDE_DIRS="$EXCLUDE_DIRS,$_mono_dir"
  fi
fi

# Test file patterns: __tests__/, *.test.*, *.spec.*, e2e/
TEST_MATCH='(__tests__/|\.test\.|\.spec\.|/e2e/)'
# Docs file pattern
DOCS_MATCH='\.md$'

# Build file lists
TMP_ALL=$(mktemp)
TMP_TEST=$(mktemp)
TMP_DOCS=$(mktemp)
TMP_SRC=$(mktemp)
trap 'rm -f "$TMP_ALL" "$TMP_TEST" "$TMP_DOCS" "$TMP_SRC"' EXIT

find "$TARGET" \
  -type d \( -name node_modules -o -name dist -o -name build -o -name venv \
             -o -name .git -o -name coverage -o -name .next -o -name out \
             -o -name .turbo -o -name .cache \) -prune \
  -o -type f -print > "$TMP_ALL"

# Also prune private repo dirs from the file list
if [ -f "$CONF" ] && [ "$_inside_private" = false ]; then
  PRUNE_PAT=""
  [ -n "${_data_dir:-}" ] && PRUNE_PAT="$PRUNE_PAT|/$_data_dir/"
  [ -n "${_mono_dir:-}" ] && PRUNE_PAT="$PRUNE_PAT|/$_mono_dir/"
  PRUNE_PAT="${PRUNE_PAT#|}"
  if [ -n "$PRUNE_PAT" ]; then
    grep -vE "$PRUNE_PAT" "$TMP_ALL" > "${TMP_ALL}.filtered" && mv "${TMP_ALL}.filtered" "$TMP_ALL"
  fi
fi

# Split: tests, then docs, then everything else is source
grep -E  "$TEST_MATCH" "$TMP_ALL" > "$TMP_TEST" || true
grep -vE "$TEST_MATCH" "$TMP_ALL" | grep -E  "$DOCS_MATCH" > "$TMP_DOCS" || true
grep -vE "$TEST_MATCH" "$TMP_ALL" | grep -vE "$DOCS_MATCH" > "$TMP_SRC"  || true

TEST_COUNT=$(wc -l < "$TMP_TEST")
DOCS_COUNT=$(wc -l < "$TMP_DOCS")
SRC_COUNT=$(wc -l < "$TMP_SRC")

COMMON_ARGS=(--exclude-dir="$EXCLUDE_DIRS" --exclude-lang=JSON "$@")

# Run cloc with --csv --quiet, parse into compact summary
# Output: "CATEGORY (N files, N code)"  then per-lang lines
run_section() {
  local label="$1" listfile="$2"
  local count
  count=$(wc -l < "$listfile")
  if [ "$count" -eq 0 ]; then
    printf "\n  %s: (none)\n" "$label"
    return
  fi

  local csv
  csv=$(cloc --list-file="$listfile" "${COMMON_ARGS[@]}" --csv --quiet 2>/dev/null)

  # Parse CSV: skip header, collect lang,files,code; compute totals
  local total_files=0 total_code=0
  local lines=()
  while IFS=, read -r _files lang _blank _comment code; do
    # skip header and SUM row
    [[ "$lang" == "language" || "$lang" == "SUM" ]] && continue
    [[ -z "$code" ]] && continue
    total_files=$(( total_files + _files ))
    total_code=$(( total_code + code ))
    lines+=("$(printf "%'10d  %s (%d files)" "$code" "$lang" "$_files")")
  done <<< "$csv"

  printf "\n  %s  (%'d files, %'d code)\n" "$label" "$total_files" "$total_code"
  for line in "${lines[@]}"; do
    printf "    %s\n" "$line"
  done
}

# Grand total
GRAND_CSV=$(cloc --list-file="$TMP_ALL" "${COMMON_ARGS[@]}" --csv --quiet 2>/dev/null)
GRAND_FILES=0 GRAND_CODE=0
while IFS=, read -r _f _l _b _c code; do
  [[ "$_l" == "language" || "$_l" == "SUM" ]] && continue
  [[ -z "$code" ]] && continue
  GRAND_FILES=$(( GRAND_FILES + _f ))
  GRAND_CODE=$(( GRAND_CODE + code ))
done <<< "$GRAND_CSV"

echo "═══════════════════════════════════════════════════"
printf "  TOTAL: %'d files, %'d lines of code\n" "$GRAND_FILES" "$GRAND_CODE"
echo "═══════════════════════════════════════════════════"

run_section "SOURCE" "$TMP_SRC"
run_section "TESTS"  "$TMP_TEST"
run_section "DOCS"   "$TMP_DOCS"
echo
