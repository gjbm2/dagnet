#!/usr/bin/env bash
# Stage all changes, commit, and push the current branch in <private-repo>.
# Usage: bash graph-ops/scripts/commit-and-push.sh "<commit message>"
#
# Safety: refuses to commit directly to main.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../../<private-repo>" && pwd)"

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"<commit message>\""
  exit 1
fi

MESSAGE="$1"

cd "$REPO_DIR"

# Safety: refuse to commit to main
BRANCH="$(git branch --show-current)"
if [ "$BRANCH" = "main" ]; then
  echo "ERROR: Refusing to commit directly to main."
  echo "Create a feature branch first: bash graph-ops/scripts/new-branch.sh <name>"
  exit 1
fi

echo "==> Working in: $REPO_DIR"
echo "==> Branch: $BRANCH"
echo ""

# Show what will be committed
echo "==> Changes to be committed:"
git status --short
echo ""

# Stage everything
git add -A

# Check there is something to commit
if git diff --cached --quiet; then
  echo "Nothing to commit (working tree clean)."
  exit 0
fi

# Commit
git commit -m "$MESSAGE"

# Push (set upstream if first push)
echo ""
echo "==> Pushing to origin/$BRANCH..."
git push -u origin "$BRANCH"

echo ""
echo "Done. Branch '$BRANCH' pushed to origin."
echo "Create a PR at: https://github.com/gjbm2/<private-repo>/compare/$BRANCH?expand=1"
