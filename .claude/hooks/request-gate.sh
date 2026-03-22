#!/bin/bash
# Step 1 of 2: Request a gate lift.
#
# Outputs a loud red warning (user sees this in chat) and creates a
# request token. Does NOT open the gate. The agent must then WAIT for
# user approval and run confirm-gate.sh (step 2).
#
# The request token must be at least 10 seconds old before confirm-gate.sh
# will accept it. This gives the user time to see the warning and intervene.
#
# Usage:  .claude/hooks/request-gate.sh <gate-class>
set -e

GATE="${1:?Usage: request-gate.sh <gate-class>}"
REQUEST_FILE="/tmp/dagnet-gate-request-${GATE}"

# Hardcoded gates (not in gates.json but enforced by gate-check.sh)
HARDCODED_GATES="gate-config"

# Validate gate class
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GATES_FILE="$HOOKS_DIR/gates.json"

VALID=0
if echo "$HARDCODED_GATES" | grep -qwF "$GATE"; then
  VALID=1
elif [ -f "$GATES_FILE" ] && python3 -c "
import json, sys
with open('$GATES_FILE') as f:
    gates = json.load(f)['gates']
if '$GATE' not in gates:
    sys.exit(1)
" 2>/dev/null; then
  VALID=1
fi

if [ "$VALID" -eq 0 ]; then
  echo "Unknown gate class: $GATE" >&2
  exit 1
fi

# Create request token
date +%s > "$REQUEST_FILE"

# Output the red warning — this is what the user sees in chat
echo ""
echo "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴"
echo "🔴🔴🔴  GATE REQUEST: $GATE  🔴🔴🔴"
echo "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴"
echo ""
echo "  Agent is requesting permission to run a gated command."
echo "  Gate will NOT open until you approve AND 10 seconds elapse."
echo ""
echo "  Reply to approve, or interrupt the agent to deny."
echo ""
