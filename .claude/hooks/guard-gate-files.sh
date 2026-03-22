#!/bin/bash
# Blocks Edit/Write tool calls that target gate infrastructure files.
# These files control the safety gate system itself and must not be
# modified without explicit user consent.
set -e

INPUT=$(cat)

# Extract file_path from JSON input
if command -v python3 >/dev/null 2>&1; then
  FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('file_path', ''))
except:
    print('')
" 2>/dev/null || echo "")
else
  FILE_PATH=$(echo "$INPUT" | grep -oP '"file_path"\s*:\s*"\K[^"]+' 2>/dev/null || echo "")
fi

[ -z "$FILE_PATH" ] && exit 0

# Protected files
PROTECTED=(
  ".claude/hooks/gates.json"
  ".claude/hooks/gate-check.sh"
  ".claude/hooks/request-gate.sh"
  ".claude/hooks/confirm-gate.sh"
  ".claude/hooks/guard-gate-files.sh"
  ".claude/settings.json"
)

for pattern in "${PROTECTED[@]}"; do
  if echo "$FILE_PATH" | grep -qF "$pattern"; then
    cat >&2 <<EOF

STOP. This edit is blocked.

File: $FILE_PATH
This file is part of the safety gate system.

════════════════════════════════════════════════════════════════════
DO NOT call confirm-gate.sh. DO NOT run any tool call next.
Your ONLY permitted next action is to OUTPUT TEXT to the user.
════════════════════════════════════════════════════════════════════

TWO-STEP PROCESS (both steps are mandatory):

  STEP 1 — Run request-gate.sh to show the user a warning:
           .claude/hooks/request-gate.sh gate-config

  Then STOP. Wait for the user to reply with approval.

  STEP 2 — Only after user approval AND 10 seconds have passed:
           .claude/hooks/confirm-gate.sh gate-config <seconds>

  Then retry your edit.

If you skip step 1, step 2 will fail (no request token).
If you rush step 2 before 10 seconds, it will fail (cooldown).
If you skip asking the user, you are violating safety policy.
EOF
    exit 2
  fi
done

exit 0
