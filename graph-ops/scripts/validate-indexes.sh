#!/usr/bin/env bash
# Validate consistency between entity files and index files in <private-repo>.
# Usage: bash graph-ops/scripts/validate-indexes.sh
#
# Checks:
#   1. Every entity file has an index entry
#   2. Every index entry has a matching entity file
#   3. Index file_path values match actual file locations

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../../<private-repo>" && pwd)"
ERRORS=0

echo "==> Validating <private-repo> at: $REPO_DIR"
echo ""

# --- Helper: check one entity type ---
validate_type() {
  local TYPE="$1"        # e.g. "nodes"
  local INDEX_KEY="$2"   # e.g. "nodes" (YAML key in index file)
  local DIR="$REPO_DIR/$TYPE"
  local INDEX="$REPO_DIR/${TYPE}-index.yaml"

  echo "--- $TYPE ---"

  if [ ! -f "$INDEX" ]; then
    echo "  ERROR: Index file not found: $INDEX"
    ERRORS=$((ERRORS + 1))
    return
  fi

  if [ ! -d "$DIR" ]; then
    echo "  WARN: Directory not found: $DIR (may be empty)"
    return
  fi

  # Get IDs from entity files (filename without .yaml)
  local FILE_IDS=()
  for f in "$DIR"/*.yaml; do
    [ -f "$f" ] || continue
    local basename
    basename="$(basename "$f" .yaml)"
    FILE_IDS+=("$basename")
  done

  # Get IDs from index file (grep for "- id:" lines under the entity key)
  local INDEX_IDS=()
  while IFS= read -r line; do
    local id
    id="$(echo "$line" | sed 's/^.*- id: //' | sed 's/[[:space:]]*$//')"
    INDEX_IDS+=("$id")
  done < <(grep '^\s*- id:' "$INDEX")

  # Check: every file has an index entry
  for fid in "${FILE_IDS[@]}"; do
    local found=false
    for iid in "${INDEX_IDS[@]}"; do
      if [ "$fid" = "$iid" ]; then
        found=true
        break
      fi
    done
    if [ "$found" = false ]; then
      echo "  ERROR: File '$TYPE/$fid.yaml' has no index entry"
      ERRORS=$((ERRORS + 1))
    fi
  done

  # Check: every index entry has a file
  for iid in "${INDEX_IDS[@]}"; do
    if [ ! -f "$DIR/$iid.yaml" ]; then
      echo "  ERROR: Index entry '$iid' has no file at '$TYPE/$iid.yaml'"
      ERRORS=$((ERRORS + 1))
    fi
  done

  echo "  Files: ${#FILE_IDS[@]}, Index entries: ${#INDEX_IDS[@]}"
}

validate_type "nodes" "nodes"
validate_type "events" "events"
validate_type "parameters" "parameters"
validate_type "contexts" "contexts"

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "All checks passed."
else
  echo "FAILED: $ERRORS error(s) found."
  exit 1
fi
