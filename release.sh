#!/usr/bin/env bash

# Interactive version bumper for DagNet
# Usage: ./release.sh [--runtests]
#
# Options:
#   --runtests    Run all tests (npm + pytest) before releasing

set -e

# Simple color functions (more portable)
print_blue() { printf '\033[0;34m%s\033[0m\n' "$*"; }
print_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
print_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
print_red() { printf '\033[0;31m%s\033[0m\n' "$*"; }

# Parse command line arguments
RUN_TESTS=false
for arg in "$@"; do
  case $arg in
    --runtests)
      RUN_TESTS=true
      shift
      ;;
    *)
      print_red "Unknown option: $arg"
      echo "Usage: ./release.sh [--runtests]"
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
CURRENT_DISPLAY=$(echo "$CURRENT_VERSION" | sed 's/\.0-beta$/b/')

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
  
  # Run npm tests
  print_yellow "[1/2] Running npm tests..."
  if ! npm test -- --run; then
    echo ""
    print_red "✗ npm tests failed!"
    print_red "Release aborted."
    exit 1
  fi
  print_green "✓ npm tests passed"
  echo ""
  
  # Run Python tests
  print_yellow "[2/2] Running Python tests..."
  if ! source venv/bin/activate && pytest tests/ -v; then
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

NEW_DISPLAY=$(echo "$NEW_VERSION" | sed 's/\.0-beta$/b/')

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

# Commit any uncommitted changes BEFORE proceeding
HAS_UNCOMMITTED=$(git status --porcelain)
if [[ -n "$HAS_UNCOMMITTED" ]]; then
  print_blue "Committing current changes..."
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

# Update package.json version
print_blue "[1/6] Updating package.json..."
(cd graph-editor && npm version "$NEW_VERSION" --no-git-tag-version)

# Verify the version was updated correctly
UPDATED_VERSION=$(node -p "require('./graph-editor/package.json').version")
if [[ "$UPDATED_VERSION" != "$NEW_VERSION" ]]; then
  print_red "Error: Version mismatch after npm version."
  echo "Expected: $NEW_VERSION"
  echo "Got: $UPDATED_VERSION"
  exit 1
fi

# Update CHANGELOG.md if release notes were provided
print_blue "[2/6] Updating CHANGELOG.md..."
if [[ -n "$RELEASE_NOTES" && "$RELEASE_NOTES" != $'\n' ]]; then
  CURRENT_DATE=$(date +"%B %d, %Y")
  
  # Create new changelog entry in a temp file
  cat > /tmp/changelog_entry.tmp << EOF
## Version ${NEW_DISPLAY}
**Released:** ${CURRENT_DATE}

${RELEASE_NOTES}
---

EOF
  
  # Insert after the first line (# DagNet Release Notes)
  head -n 1 graph-editor/CHANGELOG.md > /tmp/changelog_new.tmp
  cat /tmp/changelog_entry.tmp >> /tmp/changelog_new.tmp
  tail -n +2 graph-editor/CHANGELOG.md >> /tmp/changelog_new.tmp
  mv /tmp/changelog_new.tmp graph-editor/CHANGELOG.md
  rm /tmp/changelog_entry.tmp
  
  print_green "  ✓ Added release notes to CHANGELOG.md"
else
  print_yellow "  ⊘ Skipped (no release notes provided)"
fi

# Stage changes
print_blue "[3/6] Staging changes..."
if [[ -n "$RELEASE_NOTES" && "$RELEASE_NOTES" != $'\n' ]]; then
  git add graph-editor/package.json graph-editor/CHANGELOG.md
else
  git add graph-editor/package.json
fi

# Commit the version bump
print_blue "[4/6] Committing version bump..."
git commit -m "Bump version to ${NEW_VERSION}"

# Create git tag
print_blue "[5/6] Creating git tag v${NEW_VERSION}..."
git tag "v${NEW_VERSION}"

# Push changes and tags
print_blue "[6/6] Pushing ${CURRENT_BRANCH} to remote..."
git push origin "$CURRENT_BRANCH" --tags

# Merge to main if requested
if [[ "$MERGE_TO_MAIN" == true ]]; then
  echo ""
  print_blue "[7/7] Merging to main..."
  
  # Fetch latest main
  git fetch origin main
  
  # Checkout main
  git checkout main
  
  # Pull latest changes
  git pull origin main
  
  # Merge the release branch
  echo "Merging ${CURRENT_BRANCH} into main..."
  git merge "$CURRENT_BRANCH" --no-ff -m "Merge ${CURRENT_BRANCH} for release v${NEW_VERSION}"
  
  # Push main
  echo "Pushing main to remote..."
  git push origin main
  
  # Return to original branch
  git checkout "$CURRENT_BRANCH"
  
  echo ""
  print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  print_green "✓ Release ${NEW_DISPLAY} complete!"
  print_green "✓ Merged to main!"
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

