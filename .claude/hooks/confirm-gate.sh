#!/bin/bash
# Step 2 of 2: Confirm a gate lift after user approval.
#
# Checks that a request token exists (from request-gate.sh) and is at
# least 10 seconds old. If valid, creates the consent file that
# gate-check.sh reads. Gate auto-closes after TTL seconds.
#
# Usage:  .claude/hooks/confirm-gate.sh <gate-class> <seconds>
set -e

GATE="${1:?Usage: confirm-gate.sh <gate-class> <seconds>}"
MAX_TTL=30
REQUESTED="${2:?Usage: confirm-gate.sh <gate-class> <seconds>}"
TTL=$(( REQUESTED > MAX_TTL ? MAX_TTL : REQUESTED ))
COOLDOWN=10

REQUEST_FILE="/tmp/dagnet-gate-request-${GATE}"
CONSENT_FILE="/tmp/dagnet-gate-${GATE}"

# Check request token exists
if [ ! -f "$REQUEST_FILE" ]; then
  echo "" >&2
  echo "DENIED: No request token found for gate '$GATE'." >&2
  echo "You must run request-gate.sh first." >&2
  echo "" >&2
  exit 1
fi

# Check cooldown
CREATED=$(stat -c %Y "$REQUEST_FILE" 2>/dev/null || echo "0")
NOW=$(date +%s)
AGE=$(( NOW - CREATED ))

if [ "$AGE" -lt "$COOLDOWN" ]; then
  REMAINING=$(( COOLDOWN - AGE ))
  echo "" >&2
  echo "DENIED: Cooldown not elapsed. ${REMAINING}s remaining." >&2
  echo "The request token must be at least ${COOLDOWN}s old." >&2
  echo "Wait and retry." >&2
  echo "" >&2
  exit 1
fi

# Cooldown passed — create consent file
if [ "$TTL" -ne "$REQUESTED" ]; then
  echo "  TTL capped: requested ${REQUESTED}s, using ${TTL}s (max ${MAX_TTL}s)."
fi

echo "$TTL" > "$CONSENT_FILE"

# Clean up request token
rm -f "$REQUEST_FILE"

# Schedule auto-cleanup of consent
(sleep "$TTL" && rm -f "$CONSENT_FILE" 2>/dev/null) &

CLOSES_AT=$(date -d "+${TTL} seconds" '+%H:%M:%S' 2>/dev/null || echo "${TTL}s from now")
echo ""
echo "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴"
echo "🔴🔴🔴  GATE OPEN: $GATE  (${TTL}s)  🔴🔴🔴"
echo "🔴🔴🔴  closes: $CLOSES_AT              🔴🔴🔴"
echo "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴"
echo ""
