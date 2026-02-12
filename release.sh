#!/usr/bin/env bash

# Interactive version bumper for DagNet
# Usage: ./release.sh [--runtests] [--build]
#
# Options:
#   --runtests    Run all tests (npm + pytest) before releasing
#   --build       Run TypeScript check to verify build will succeed (fast, ~10s)

set -e

# Simple color functions (more portable)
print_blue() { printf '\033[0;34m%s\033[0m\n' "$*"; }
print_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
print_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
print_red() { printf '\033[0;31m%s\033[0m\n' "$*"; }

# Show exactly what would be staged by `git add .`, including a line churn summary.
# This is intended as a safety rail against accidental editor/autosave churn.
print_git_add_dot_preview() {
  print_yellow "Preview: git add ."
  echo ""

  # Tracked changes (added/deleted line counts). For binaries, numstat prints '-' '-'.
  local tracked_numstat
  tracked_numstat="$(git diff --numstat)"
  if [[ -n "$tracked_numstat" ]]; then
    echo "$tracked_numstat" | awk '{ printf "  - %s  (+%s / -%s)\n", $3, $1, $2 }'
  else
    echo "  (no tracked file diffs)"
  fi

  # Untracked files: treat all lines as additions.
  local untracked
  untracked="$(git ls-files --others --exclude-standard)"
  if [[ -n "$untracked" ]]; then
    echo ""
    print_yellow "Untracked files (will be added):"
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      local lines="?"
      if [[ -f "$f" ]]; then
        lines="$(wc -l <"$f" 2>/dev/null || echo "?")"
      fi
      printf "  - %s  (+%s / -0)\n" "$f" "$lines"
    done <<< "$untracked"
  fi

  echo ""
}

# Parse command line arguments
RUN_TESTS=false
RUN_BUILD=false
for arg in "$@"; do
  case $arg in
    --runtests)
      RUN_TESTS=true
      shift
      ;;
    --build)
      RUN_BUILD=true
      shift
      ;;
    *)
      print_red "Unknown option: $arg"
      echo "Usage: ./release.sh [--runtests] [--build]"
      exit 1
      ;;
  esac
done

# Navigate to script directory (should be repo root)
cd "$(dirname "$0")"

# Check if there are uncommitted changes and commit them FIRST
if [[ -n $(git status --porcelain) ]]; then
  print_yellow "⚠ You have uncommitted changes."
  print_yellow "These will be committed before proceeding with the release."
  echo ""
  read -p "Press Enter to continue or Ctrl+C to cancel..."
  echo ""
fi

# Read current version from package.json
CURRENT_VERSION=$(node -p "require('./graph-editor/package.json').version")
CURRENT_DISPLAY=$(echo "$CURRENT_VERSION" | sed 's/-beta$/b/')

print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
print_blue "        DagNet Version Release Tool"
print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
printf "Current version: \033[0;32m%s\033[0m (%s)\n" "$CURRENT_DISPLAY" "$CURRENT_VERSION"
echo ""

# Run tests if requested
if [[ "$RUN_TESTS" == true ]]; then
  print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  print_blue "Running tests before release..."
  print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  # Run all npm tests (unit + integration)
  print_yellow "[1/3] Running npm tests..."
  if ! (cd graph-editor && npm run test:all); then
    echo ""
    print_red "✗ npm tests failed!"
    print_red "Release aborted."
    exit 1
  fi
  print_green "✓ npm tests passed"
  echo ""

  # Run Playwright E2E tests
  print_yellow "[2/3] Running Playwright E2E tests..."
  # Keep Playwright output readable during release runs.
  # To re-enable verbose per-test logs: E2E_VERBOSE=1 ./release.sh --runtests
  if ! (cd graph-editor && E2E_VERBOSE=0 npm run e2e); then
    echo ""
    print_red "✗ Playwright tests failed!"
    print_red "Release aborted."
    exit 1
  fi
  print_green "✓ Playwright tests passed"
  echo ""
  
  # Run Python tests
  print_yellow "[3/3] Running Python tests..."
  # Run from graph-editor so pytest picks up graph-editor/pytest.ini (incl pythonpath=lib).
  if ! (cd graph-editor && venv/bin/pytest --tb=short -q); then
    echo ""
    print_red "✗ Python tests failed!"
    print_red "Release aborted."
    exit 1
  fi
  print_green "✓ Python tests passed"
  echo ""
  
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  print_green "✓ All tests passed!"
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
fi

# Run build verification if requested
if [[ "$RUN_BUILD" == true ]]; then
  print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  print_blue "Verifying build will succeed..."
  print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  # TypeScript type-check catches 95% of build failures, much faster than full build
  print_yellow "Running TypeScript type check..."
  
  # Run tsc and capture output + exit code properly
  TSC_OUTPUT=$(cd graph-editor && npx tsc --noEmit 2>&1) || TSC_EXIT=$?
  TSC_EXIT=${TSC_EXIT:-0}
  
  if [[ $TSC_EXIT -ne 0 ]]; then
    echo "$TSC_OUTPUT"
    echo ""
    print_red "✗ TypeScript errors - build would fail!"
    print_red "Release aborted."
    exit 1
  fi
  
  print_green "✓ TypeScript check passed"
  echo ""
  
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  print_green "✓ Build verification complete!"
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
fi

# Parse current version
IFS='.' read -r MAJOR MINOR PATCH_BETA <<< "$CURRENT_VERSION"
PATCH=$(echo "$PATCH_BETA" | sed 's/-beta//')

# Show menu
print_yellow "Select increment type:"
echo ""
printf "  \033[0;32mB\033[0m - Big increment     (major)    → %d.0.0-beta  (e.g., %d.0b)\n" $(($MAJOR + 1)) $(($MAJOR + 1))
printf "  \033[0;32mS\033[0m - Small increment   (minor)    → %s.%d.0-beta  (e.g., %s.%db)\n" "$MAJOR" $(($MINOR + 1)) "$MAJOR" $(($MINOR + 1))
printf "  \033[0;32mM\033[0m - Micro increment   (patch)    → %s.%s.%d-beta  (e.g., %s.%s.%db)\n" "$MAJOR" "$MINOR" $(($PATCH + 1)) "$MAJOR" "$MINOR" $(($PATCH + 1))
printf "  \033[0;31mQ\033[0m - Quit\n"
echo ""
read -p "Choose [B/S/M/Q]: " CHOICE

case "${CHOICE^^}" in
  B)
    NEW_MAJOR=$(($MAJOR + 1))
    NEW_VERSION="${NEW_MAJOR}.0.0-beta"
    INCREMENT_TYPE="major"
    ;;
  S)
    NEW_MINOR=$(($MINOR + 1))
    NEW_VERSION="${MAJOR}.${NEW_MINOR}.0-beta"
    INCREMENT_TYPE="minor"
    ;;
  M)
    NEW_PATCH=$(($PATCH + 1))
    NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}-beta"
    INCREMENT_TYPE="patch"
    ;;
  Q)
    print_yellow "Cancelled."
    exit 0
    ;;
  *)
    print_red "Invalid choice. Exiting."
    exit 1
    ;;
esac

NEW_DISPLAY=$(echo "$NEW_VERSION" | sed 's/-beta$/b/')

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)

echo ""
print_yellow "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "Release \033[0;32m%s\033[0m (%s)?\n" "$NEW_DISPLAY" "$NEW_VERSION"
echo ""
printf "Current branch: \033[0;34m%s\033[0m\n" "$CURRENT_BRANCH"
echo ""
echo "Release scope:"
printf "  \033[0;32mB\033[0m - Branch only (%s)\n" "$CURRENT_BRANCH"
printf "  \033[0;32mM\033[0m - Merge to main (%s → main)\n" "$CURRENT_BRANCH"
printf "  \033[0;31mC\033[0m - Cancel\n"
echo ""
read -p "Choose [B/M/C]: " SCOPE_CHOICE

case "${SCOPE_CHOICE^^}" in
  B)
    MERGE_TO_MAIN=false
    ;;
  M)
    MERGE_TO_MAIN=true
    ;;
  C)
    print_yellow "Cancelled."
    exit 0
    ;;
  *)
    print_red "Invalid choice. Exiting."
    exit 1
    ;;
esac

if [[ "$MERGE_TO_MAIN" == true ]]; then
  # CRITICAL PRE-FLIGHT: Check that origin/main hasn't diverged from this branch.
  # If main has commits we don't have, pushing branch:main would either fail (non-fast-forward)
  # or — worse — silently lose those commits.
  print_blue "Checking origin/main for divergence..."
  git fetch origin main --quiet 2>/dev/null || {
    print_red "✗ Could not fetch origin/main. Check your network/SSH."
    print_red "Release aborted."
    exit 1
  }

  # Is origin/main reachable from our HEAD? (i.e., is it an ancestor?)
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo ""
    print_red "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    print_red "✗ RELEASE BLOCKED: origin/main has commits not on this branch!"
    print_red "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    MERGE_BASE=$(git merge-base origin/main HEAD)
    echo "  Branches diverged at: $(git log --oneline -1 "$MERGE_BASE")"
    echo ""
    echo "  Commits on origin/main that you're missing:"
    git log --oneline "$MERGE_BASE"..origin/main | sed 's/^/    /'
    echo ""
    echo "  Commits on ${CURRENT_BRANCH} since divergence:"
    git log --oneline "$MERGE_BASE"..HEAD | sed 's/^/    /'
    echo ""
    print_yellow "To fix: merge origin/main into your branch first, then re-run release.sh"
    print_yellow "  git fetch origin main"
    print_yellow "  git merge origin/main"
    print_yellow "  # resolve any conflicts, then re-run ./release.sh"
    echo ""
    exit 1
  fi
  print_green "  ✓ origin/main is up-to-date (all its commits are on this branch)"
  echo ""

  print_yellow "⚠ This will:"
  echo "  1. Release ${NEW_DISPLAY} on ${CURRENT_BRANCH}"
  echo "  2. Merge ${CURRENT_BRANCH} → main"
  echo "  3. Push both branches and tags"
  echo ""
fi

read -p "Confirm release [Y/N]: " CONFIRM

if [[ ! "${CONFIRM^^}" == "Y" ]]; then
  print_yellow "Cancelled."
  exit 0
fi

# Prompt for release notes
echo ""
print_yellow "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
print_yellow "Enter release notes (optional, press Ctrl+D when done):"
print_yellow "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Describe what's new in this release:"
echo "(This will be used as your commit message and added to CHANGELOG)"
echo ""

# Read multi-line input
RELEASE_NOTES=""
while IFS= read -r line; do
  RELEASE_NOTES="${RELEASE_NOTES}${line}"$'\n'
done

echo ""

# Commit any uncommitted changes BEFORE proceeding (guarded by preview)
HAS_UNCOMMITTED=$(git status --porcelain)
if [[ -n "$HAS_UNCOMMITTED" ]]; then
  print_blue "Committing current changes..."
  echo ""
  print_git_add_dot_preview
  read -p "Stage and commit ALL of the above changes? [Y/N]: " STAGE_CONFIRM

  if [[ ! "${STAGE_CONFIRM^^}" == "Y" ]]; then
    print_yellow "Cancelled."
    exit 0
  fi

  git add .
  
  # Use release notes as commit message if provided, otherwise use default
  if [[ -n "$RELEASE_NOTES" && "$RELEASE_NOTES" != $'\n' ]]; then
    # Strip trailing newlines for commit message
    COMMIT_MESSAGE=$(echo "$RELEASE_NOTES" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
    git commit -m "$COMMIT_MESSAGE"
  else
    git commit -m "Pre-release commit for v${NEW_VERSION}"
  fi
  echo ""
fi

print_blue "Proceeding with release..."
echo ""

# Ensure shipped docs index is up to date (helps keep Help → Workshop etc. in sync)
# Note: graph-editor/public/docs/index.json is intentionally gitignored and generated at build time.
print_blue "[0/7] Updating docs index (build-time)..."
(
  cd graph-editor
  npm run generate-docs
)

# Update package.json version
print_blue "[1/7] Updating package.json..."
(cd graph-editor && npm version "$NEW_VERSION" --no-git-tag-version)

# Verify the version was updated correctly
UPDATED_VERSION=$(node -p "require('./graph-editor/package.json').version")
if [[ "$UPDATED_VERSION" != "$NEW_VERSION" ]]; then
  print_red "Error: Version mismatch after npm version."
  echo "Expected: $NEW_VERSION"
  echo "Got: $UPDATED_VERSION"
  exit 1
fi

# Update deployed version marker (used by reload-page nudge)
print_blue "[2/7] Updating graph-editor/public/version.json..."
cat > graph-editor/public/version.json << EOF
{
  "version": "${NEW_VERSION}",
  "versionShort": "${NEW_DISPLAY}"
}
EOF

# Update CHANGELOG.md if release notes were provided
print_blue "[3/7] Updating CHANGELOG.md..."
if [[ -n "$RELEASE_NOTES" && "$RELEASE_NOTES" != $'\n' ]]; then
  # DagNet date format: d-MMM-yy (e.g., 1-Dec-25)
  CURRENT_DATE="$(date "+%e-%b-%y" | sed 's/^ //')"
  
  # Create new changelog entry in a temp file
  cat > /tmp/changelog_entry.tmp << EOF
## Version ${NEW_DISPLAY}
**Released:** ${CURRENT_DATE}

${RELEASE_NOTES}
---

EOF
  
  # Insert after the first line (# DagNet Release Notes)
  head -n 1 graph-editor/public/docs/CHANGELOG.md > /tmp/changelog_new.tmp
  cat /tmp/changelog_entry.tmp >> /tmp/changelog_new.tmp
  tail -n +2 graph-editor/public/docs/CHANGELOG.md >> /tmp/changelog_new.tmp
  mv /tmp/changelog_new.tmp graph-editor/public/docs/CHANGELOG.md
  rm /tmp/changelog_entry.tmp
  
  print_green "  ✓ Added release notes to CHANGELOG.md"
else
  print_yellow "  ⊘ Skipped (no release notes provided)"
fi

# Stage changes
# Pre-flight: clean up stale tag from a previous aborted release BEFORE committing
if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
  STALE_TAG_SHA=$(git rev-parse --short "v${NEW_VERSION}")
  print_yellow "  Stale tag v${NEW_VERSION} found at ${STALE_TAG_SHA} (from prior aborted release); removing..."
  git tag -d "v${NEW_VERSION}" >/dev/null 2>&1
fi

print_blue "[4/7] Staging changes..."
if [[ -n "$RELEASE_NOTES" && "$RELEASE_NOTES" != $'\n' ]]; then
  git add graph-editor/package.json graph-editor/package-lock.json graph-editor/public/version.json graph-editor/public/docs/CHANGELOG.md
else
  git add graph-editor/package.json graph-editor/package-lock.json graph-editor/public/version.json
fi

# Commit the version bump
print_blue "[5/7] Committing version bump..."
git commit -m "Bump version to ${NEW_VERSION}"

# Create git tag
print_blue "[6/7] Creating git tag v${NEW_VERSION}..."
git tag "v${NEW_VERSION}"

# Push changes and the new tag (only the new tag, not all local tags)
print_blue "[7/7] Pushing ${CURRENT_BRANCH} to remote..."
git push origin "$CURRENT_BRANCH" "v${NEW_VERSION}"

# Merge to main if requested
if [[ "$MERGE_TO_MAIN" == true ]]; then
  echo ""
  print_blue "[8/8] Pushing to main..."
  
  # Push current branch directly to main without checking it out
  git push origin "${CURRENT_BRANCH}:main"
  
  echo ""
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  print_green "✓ Release ${NEW_DISPLAY} complete!"
  print_green "✓ Pushed to main!"
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  printf "Version: \033[0;32m%s\033[0m\n" "$NEW_DISPLAY"
  echo "Tag: v${NEW_VERSION}"
  printf "Released on: \033[0;34m%s\033[0m and \033[0;34mmain\033[0m\n" "$CURRENT_BRANCH"
else
  echo ""
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  print_green "✓ Release ${NEW_DISPLAY} complete!"
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  printf "Version: \033[0;32m%s\033[0m\n" "$NEW_DISPLAY"
  echo "Tag: v${NEW_VERSION}"
  printf "Branch: \033[0;34m%s\033[0m only\n" "$CURRENT_BRANCH"
fi

echo ""
print_yellow "Next steps:"
printf "  • Run \033[0;34mnpm run build\033[0m to verify the new version displays correctly\n"
echo "  • Check the welcome page shows: v${NEW_DISPLAY}"
echo ""

