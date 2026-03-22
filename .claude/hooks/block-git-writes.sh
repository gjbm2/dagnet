#!/bin/bash
# Warn on git write and destructive commands. Does NOT block — the user
# decides at the permission prompt. This just ensures the agent sees a
# loud reminder before the prompt fires.
set -e

INPUT=$(cat)
# Extract command without jq — parse the JSON with python if available,
# otherwise fall back to a simple grep.
if command -v python3 >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")
else
  COMMAND=$(echo "$INPUT" | grep -oP '"command"\s*:\s*"\K[^"]+' 2>/dev/null || echo "")
fi

[ -z "$COMMAND" ] && exit 0

# Git write patterns
GIT_WRITE=0
for kw in "git add" "git commit" "git push" "git pull" "git checkout" \
          "git reset" "git rebase" "git merge" "git stash" "git revert" \
          "git tag" "git rm" "git mv" "git clean" "git restore" \
          "git switch" "git cherry-pick" "git apply" "git am" \
          "git filter-branch" "git branch -d" "git branch -D" \
          "git branch -m" "git branch -M"; do
  if echo "$COMMAND" | grep -qF "$kw"; then
    GIT_WRITE=1
    break
  fi
done

if echo "$COMMAND" | grep -qF -- "--force"; then
  GIT_WRITE=1
fi

if [ "$GIT_WRITE" -eq 1 ]; then
  cat >&2 <<EOF
WARNING: Git write command detected.
Command: $COMMAND
Does the user's CURRENT message give EXPLICIT permission for this?
EOF
  exit 0
fi

# Destructive non-git patterns
for kw in "rm " "rm	" "rmdir " "unlink " "truncate " "shred " "sed -i"; do
  if echo "$COMMAND" | grep -qF "$kw"; then
    cat >&2 <<EOF
WARNING: Destructive command detected.
Command: $COMMAND
Does the user's CURRENT message give EXPLICIT permission for this?
EOF
    exit 0
  fi
done

exit 0
