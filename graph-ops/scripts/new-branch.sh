#!/usr/bin/env bash
# Create a new feature branch in <private-repo>.
# Usage: bash graph-ops/scripts/new-branch.sh <branch-name>
#   e.g. bash graph-ops/scripts/new-branch.sh add-broadband-funnel
#
# The branch will be prefixed with feature/ automatically if not already.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../../<private-repo>" && pwd)"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <branch-name>"
  echo "  e.g. $0 add-broadband-funnel"
  exit 1
fi

BRANCH="$1"

# Auto-prefix with feature/ if not already prefixed
if [[ "$BRANCH" != feature/* ]]; then
  BRANCH="feature/$BRANCH"
fi

echo "==> Working in: $REPO_DIR"
cd "$REPO_DIR"

echo "==> Fetching latest from origin..."
git fetch origin

echo "==> Checking out main and pulling..."
git checkout main
git pull origin main

echo "==> Creating branch: $BRANCH"
git checkout -b "$BRANCH"

echo ""
echo "Done. You are now on branch '$BRANCH' in <private-repo>."
echo "When ready, push with: git push -u origin $BRANCH"
