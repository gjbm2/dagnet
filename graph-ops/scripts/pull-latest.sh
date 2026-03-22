#!/usr/bin/env bash
# Pull latest changes from origin for the current branch in the data repo.
# Usage: bash graph-ops/scripts/pull-latest.sh
#
# If on main, does a simple pull. If on a feature branch, fetches and
# shows whether you're behind origin.

set -euo pipefail
. "$(dirname "$0")/_load-conf.sh"

cd "$DATA_REPO_PATH"

BRANCH="$(git branch --show-current)"

echo "==> Data repo: $DATA_REPO_PATH"
echo "==> Branch: $BRANCH"
echo ""

echo "==> Fetching from origin..."
git fetch origin

if [ "$BRANCH" = "main" ]; then
  echo "==> Pulling main..."
  git pull origin main
else
  # On a feature branch — show status relative to origin
  UPSTREAM="origin/$BRANCH"
  if git rev-parse --verify "$UPSTREAM" >/dev/null 2>&1; then
    BEHIND=$(git rev-list --count HEAD.."$UPSTREAM" 2>/dev/null || echo "0")
    AHEAD=$(git rev-list --count "$UPSTREAM"..HEAD 2>/dev/null || echo "0")
    echo "==> Branch '$BRANCH' vs origin:"
    echo "    Ahead: $AHEAD commit(s), Behind: $BEHIND commit(s)"
    if [ "$BEHIND" -gt 0 ]; then
      echo ""
      echo "==> Pulling latest..."
      git pull origin "$BRANCH"
    else
      echo "    Already up to date."
    fi
  else
    echo "    No upstream branch '$UPSTREAM' — this is a local-only branch."
    echo "    Push with: git push -u origin $BRANCH"
  fi
fi

echo ""
echo "==> Current status:"
git status --short
