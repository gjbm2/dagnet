#!/usr/bin/env bash
# Set up the dagnet workspace: git-exclude private repos and activate pre-commit hook.
# Reads directory names from .private-repos.conf at the repo root.
#
# Usage (from dagnet root):
#   bash scripts/setup-workspace.sh
#
# This is idempotent — safe to run multiple times.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$REPO_ROOT/.private-repos.conf"
EXCLUDE_FILE="$REPO_ROOT/.git/info/exclude"

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "ERROR: $REPO_ROOT is not a git working directory (missing .git/)"
  exit 1
fi

if [ ! -f "$CONF" ]; then
  echo "ERROR: Missing $CONF"
  exit 1
fi

DATA_REPO_DIR=$(grep '^DATA_REPO_DIR=' "$CONF" | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
MONOREPO_DIR=$(grep '^MONOREPO_DIR=' "$CONF" | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

if [ -z "$DATA_REPO_DIR" ] || [ -z "$MONOREPO_DIR" ]; then
  echo "ERROR: DATA_REPO_DIR and MONOREPO_DIR must be set in $CONF"
  exit 1
fi

echo "==> Setting up dagnet workspace"
echo "    Data repo dir:    $DATA_REPO_DIR"
echo "    Monorepo dir:     $MONOREPO_DIR"
echo ""

# ─── 1. Add private repo dirs to .git/info/exclude ───────────────────────────

mkdir -p "$(dirname "$EXCLUDE_FILE")"

for DIR_NAME in "$DATA_REPO_DIR" "$MONOREPO_DIR"; do
  if ! grep -qF "${DIR_NAME}/" "$EXCLUDE_FILE" 2>/dev/null; then
    echo "${DIR_NAME}/" >> "$EXCLUDE_FILE"
    echo "    Added ${DIR_NAME}/ to .git/info/exclude"
  else
    echo "    ${DIR_NAME}/ already in .git/info/exclude"
  fi
done

# ─── 2. Activate pre-commit hook ─────────────────────────────────────────────

CURRENT_HOOKS=$(git config core.hooksPath 2>/dev/null || true)
if [ "$CURRENT_HOOKS" = ".githooks" ]; then
  echo "    Pre-commit hook already active"
else
  git config core.hooksPath .githooks
  echo "    Activated pre-commit hook (.githooks)"
fi

# ─── 3. Verify ───────────────────────────────────────────────────────────────

echo ""
PASS=true

for DIR_NAME in "$DATA_REPO_DIR" "$MONOREPO_DIR"; do
  if git check-ignore "${DIR_NAME}/" >/dev/null 2>&1; then
    echo "    ✓ ${DIR_NAME}/ is git-excluded"
  else
    echo "    ✗ ${DIR_NAME}/ is NOT git-excluded — check .git/info/exclude"
    PASS=false
  fi
done

if [ "$(git config core.hooksPath 2>/dev/null)" = ".githooks" ]; then
  echo "    ✓ Pre-commit hook is active"
else
  echo "    ✗ Pre-commit hook is NOT active"
  PASS=false
fi

echo ""
if [ "$PASS" = true ]; then
  echo "Workspace setup complete."
else
  echo "WARNING: Some checks failed — review the output above."
  exit 1
fi
