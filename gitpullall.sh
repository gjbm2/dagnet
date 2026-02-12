#!/usr/bin/env bash
# Pull latest for all three repos (dagnet + the two private repos).
# Usage: ./gitpullall.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load private-repo directory names
CONF="$SCRIPT_DIR/.private-repos.conf"
if [[ ! -f "$CONF" ]]; then
  echo "ERROR: $CONF not found" >&2
  exit 1
fi
# shellcheck source=.private-repos.conf
source "$CONF"

pull_repo() {
  local dir="$1"
  local label="$2"

  if [[ ! -d "$dir/.git" ]]; then
    echo "  SKIP  $label ($dir) — not a git repo"
    return
  fi

  echo "  PULL  $label ($dir)"
  git -C "$dir" pull --ff-only 2>&1 | sed 's/^/        /'
  echo ""
}

echo ""
echo "=== git pull (all repos) ==="
echo ""

pull_repo "$SCRIPT_DIR"                        "dagnet"
pull_repo "$SCRIPT_DIR/$DATA_REPO_DIR"         "data repo"
pull_repo "$SCRIPT_DIR/$MONOREPO_DIR"          "monorepo"

echo "=== done ==="
