#!/bin/bash
# General-purpose command gate for Claude Code.
#
# Reads gate definitions from gates.json. Each gate has a name, patterns,
# and a CLAUDE.md section reference. Commands matching any gate are blocked
# (exit 2) unless a valid timed consent exists for that gate class.
#
# Also has a hardcoded check for Bash commands that WRITE to protected
# gate infrastructure files (the Edit/Write tool guard covers those tools,
# but this catches Bash-based bypasses like python3 file writes).
#
# Consent files: /tmp/dagnet-gate-<class>  (contain TTL in seconds)
# Two-step consent:
#   Step 1: .claude/hooks/request-gate.sh <class>       (shows warning, creates token)
#   Step 2: .claude/hooks/confirm-gate.sh <class> <sec> (opens gate after 10s cooldown)
set -e

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GATES_FILE="$HOOKS_DIR/gates.json"
CONSENT_PREFIX="/tmp/dagnet-gate-"

# ── Read command from JSON input ──────────────────────────────────

INPUT=$(cat)

if command -v python3 >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except:
    print('')
" 2>/dev/null || echo "")
else
  COMMAND=$(echo "$INPUT" | grep -oP '"command"\s*:\s*"\K[^"]+' 2>/dev/null || echo "")
fi

[ -z "$COMMAND" ] && exit 0

# ── Normalise: strip path prefixes from git binary ────────────────
# Catches /usr/bin/git, /usr/local/bin/git, $(which git), etc.
COMMAND=$(echo "$COMMAND" | sed -E 's|[^ ]*/git |git |g')

# ── /photocopy canonical-sequence carve-out ───────────────────────
# The /photocopy skill is a user-pre-approved, non-destructive snapshot
# of the working tree via git stash. It runs an exact sequence:
#   status > pre  &&  add -A  &&  stash push -m "<name>"
#   &&  stash apply --index  &&  reset
#   &&  status > post  &&  diff pre post
#
# When the entire command line matches this canonical sequence — and
# nothing else — allow it without consent. Any deviation (extra
# commands, different paths, command-substitution in the name, shell
# metacharacters outside the quoted name) falls through to the normal
# gate logic.
#
# Audited and intended for /photocopy invocations only. Maintaining the
# narrowness of this regex is what keeps the carve-out safe; do not
# loosen it without re-auditing.
PHOTOCOPY_MATCH=$(GATE_COMMAND="$COMMAND" python3 <<'PYEOF'
import os, re
cmd = os.environ.get('GATE_COMMAND', '')
pattern = (
    r'^\s*'
    r'git\s+status\s+--short\s+>\s+/tmp/photocopy-pre\.txt'
    r'\s*&&\s*git\s+add\s+-A'
    r'\s*&&\s*git\s+stash\s+push\s+-m\s+(?:"[^"$`\\]+"|\'[^\'$`\\]+\')'
    r'\s*&&\s*git\s+stash\s+apply\s+--index'
    r'\s*&&\s*git\s+reset'
    r'\s*&&\s*git\s+status\s+--short\s+>\s+/tmp/photocopy-post\.txt'
    r'\s*&&\s*diff\s+/tmp/photocopy-pre\.txt\s+/tmp/photocopy-post\.txt'
    r'\s*$'
)
print('YES' if re.match(pattern, cmd) else 'NO')
PYEOF
)
if [ "$PHOTOCOPY_MATCH" = "YES" ]; then
  echo "GATE-CHECK: /photocopy canonical sequence — pre-approved by user; allowed." >&2
  exit 0
fi

# ── Read-only `git stash` carve-out ───────────────────────────────
# `git stash list` and `git stash show [...]` never modify stash
# state, the index, or the working tree. They are pure reads and the
# git-write substring match on "git stash" catches them spuriously.
# Allow them without consent when the entire command line is just
# the read-only invocation with no shell metacharacters (no redirects,
# no compound commands, no command substitution, no quoting). Any
# deviation falls through to the normal gate logic.
#
# Maintaining the narrowness of this regex is what keeps the carve-out
# safe; do not loosen it without re-auditing. In particular, do NOT
# extend to `apply`, `pop`, `push`, `save`, `drop`, `clear`, `branch`,
# `store`, or `create` — those modify state.
STASH_READ_MATCH=$(GATE_COMMAND="$COMMAND" python3 <<'PYEOF'
import os, re
cmd = os.environ.get('GATE_COMMAND', '')
# Whole line must be: git stash (list|show) [args]. Each arg must
# contain no shell metacharacters that could escape the command.
pattern = r"""^\s*git\s+stash\s+(list|show)(\s+[^\s|&;<>$`'"\\()*?]+)*\s*$"""
print('YES' if re.match(pattern, cmd) else 'NO')
PYEOF
)
if [ "$STASH_READ_MATCH" = "YES" ]; then
  echo "GATE-CHECK: read-only git stash command — pre-approved; allowed." >&2
  exit 0
fi

# ── Hardcoded: protect gate infrastructure from Bash writes ───────

PROTECTED_FILES=(
  ".claude/hooks/gates.json"
  ".claude/hooks/gate-check.sh"
  ".claude/hooks/request-gate.sh"
  ".claude/hooks/confirm-gate.sh"
  ".claude/hooks/guard-gate-files.sh"
  ".claude/settings.json"
)

WRITE_INDICATORS=(
  "tee "
  "cp "
  "mv "
  "write_text"
  "write("
  ".write("
  "dd of="
)

for pfile in "${PROTECTED_FILES[@]}"; do
  if echo "$COMMAND" | grep -qF "$pfile"; then
    for wind in "${WRITE_INDICATORS[@]}"; do
      if echo "$COMMAND" | grep -qF "$wind"; then
        # Check for valid consent
        CONSENT_FILE="${CONSENT_PREFIX}gate-config"
        if [ -f "$CONSENT_FILE" ]; then
          TTL=$(head -1 "$CONSENT_FILE" 2>/dev/null || echo "0")
          CREATED=$(stat -c %Y "$CONSENT_FILE" 2>/dev/null || echo "0")
          NOW=$(date +%s)
          AGE=$(( NOW - CREATED ))
          if [ "$AGE" -le "$TTL" ]; then
            echo "GATE 'gate-config' OPEN (${AGE}s of ${TTL}s used). Allowing: $COMMAND" >&2
            exit 0
          else
            rm -f "$CONSENT_FILE"
          fi
        fi

        cat >&2 <<EOF

STOP. This command is blocked.

Command:  $COMMAND
Gate:     gate-config — Write to safety gate infrastructure

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

  Then retry your command.

If you skip step 1, step 2 will fail (no request token).
If you rush step 2 before 10 seconds, it will fail (cooldown).
If you skip asking the user, you are violating safety policy.
EOF
        exit 2
      fi
    done
  fi
done

# ── Load gate definitions and classify ────────────────────────────

if [ ! -f "$GATES_FILE" ]; then
  echo "WARNING: gates.json not found at $GATES_FILE — allowing all commands" >&2
  exit 0
fi

# Use python3 to match command against gate patterns and check consent
RESULT=$(GATE_COMMAND="$COMMAND" GATE_GATES_FILE="$GATES_FILE" GATE_CONSENT_PREFIX="$CONSENT_PREFIX" python3 -c "
import json, sys, os, time

command = os.environ['GATE_COMMAND']
gates_file = os.environ['GATE_GATES_FILE']
consent_prefix = os.environ['GATE_CONSENT_PREFIX']

with open(gates_file) as f:
    gates = json.load(f)['gates']

matched_gate = None
matched_desc = None
matched_section = None

for gate_name, gate_def in gates.items():
    for pattern in gate_def['patterns']:
        if pattern in command:
            matched_gate = gate_name
            matched_desc = gate_def['description']
            matched_section = gate_def.get('claude_md_section', 'unknown')
            break
    if matched_gate:
        break

if not matched_gate:
    print('ALLOW')
    sys.exit(0)

# Check for valid consent
consent_file = consent_prefix + matched_gate
if os.path.exists(consent_file):
    try:
        with open(consent_file) as f:
            ttl = int(f.read().strip())
        age = time.time() - os.path.getmtime(consent_file)
        if age <= ttl:
            print(f'CONSENT_VALID|{matched_gate}|{int(age)}|{ttl}')
            sys.exit(0)
        else:
            os.remove(consent_file)
    except:
        pass

print(f'BLOCKED|{matched_gate}|{matched_desc}|{matched_section}')
" 2>/dev/null)

# ── Act on result ─────────────────────────────────────────────────

case "$RESULT" in
  ALLOW)
    exit 0
    ;;
  CONSENT_VALID*)
    IFS='|' read -r _ GATE AGE TTL <<< "$RESULT"
    echo "GATE '$GATE' OPEN (${AGE}s of ${TTL}s used). Allowing: $COMMAND" >&2
    exit 0
    ;;
  BLOCKED*)
    IFS='|' read -r _ GATE DESC SECTION <<< "$RESULT"
    cat >&2 <<EOF

STOP. This command is blocked.

Command:  $COMMAND
Gate:     $GATE — $DESC
Policy:   CLAUDE.md § $SECTION

════════════════════════════════════════════════════════════════════
DO NOT call confirm-gate.sh. DO NOT run any tool call next.
Your ONLY permitted next action is to OUTPUT TEXT to the user.
════════════════════════════════════════════════════════════════════

TWO-STEP PROCESS (both steps are mandatory):

  STEP 1 — Run request-gate.sh to show the user a warning:
           .claude/hooks/request-gate.sh $GATE

  Then STOP. Wait for the user to reply with approval.

  STEP 2 — Only after user approval AND 10 seconds have passed:
           .claude/hooks/confirm-gate.sh $GATE <seconds>

  Then retry your command.

If you skip step 1, step 2 will fail (no request token).
If you rush step 2 before 10 seconds, it will fail (cooldown).
If you skip asking the user, you are violating safety policy.
EOF
    exit 2
    ;;
  *)
    # Fallback — BLOCK if classification failed (fail-closed)
    cat >&2 <<EOF

STOP. Gate classification failed — command blocked (fail-closed).

Command:  $COMMAND

Gate check could not classify this command. This is a safety
measure: if the gate system crashes, commands are denied, not allowed.

If this is a legitimate command, report the issue to the user.
EOF
    exit 2
    ;;
esac
