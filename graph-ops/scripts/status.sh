#!/usr/bin/env bash
# Show a quick status overview of the data repo.
# Usage: bash graph-ops/scripts/status.sh

set -euo pipefail
. "$(dirname "$0")/_load-conf.sh"

cd "$DATA_REPO_PATH"

BRANCH="$(git branch --show-current)"

echo "==> Data repo: $DATA_REPO_PATH"
echo "==> Branch: $BRANCH"
echo ""

# Show local branches
echo "==> Local branches:"
git branch --format="    %(if)%(HEAD)%(then)* %(else)  %(end)%(refname:short)"
echo ""

# Show status
CHANGES=$(git status --short)
if [ -n "$CHANGES" ]; then
  echo "==> Uncommitted changes:"
  echo "$CHANGES"
else
  echo "==> Working tree clean."
fi

# Show relationship to origin
echo ""
git fetch origin --quiet 2>/dev/null || true
UPSTREAM="origin/$BRANCH"
if git rev-parse --verify "$UPSTREAM" >/dev/null 2>&1; then
  BEHIND=$(git rev-list --count HEAD.."$UPSTREAM" 2>/dev/null || echo "0")
  AHEAD=$(git rev-list --count "$UPSTREAM"..HEAD 2>/dev/null || echo "0")
  echo "==> vs origin/$BRANCH: ahead $AHEAD, behind $BEHIND"
else
  echo "==> No upstream for '$BRANCH' (local only)"
fi

echo ""
echo "==> Recent commits:"
git log --oneline -5
