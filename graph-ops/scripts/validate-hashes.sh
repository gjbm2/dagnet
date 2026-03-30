#!/usr/bin/env bash
#
# validate-hashes.sh — Validate hash-mappings.json structure.
#
# Checks:
#   - Valid JSON format
#   - All core_hash and equivalent_to values are valid base64url (10-30 chars)
#   - No self-links (core_hash === equivalent_to)
#   - No duplicate mappings (same pair in either direction)
#   - All operation fields are valid values
#
# Usage:
#   graph-ops/scripts/validate-hashes.sh [path/to/hash-mappings.json]
#
# Defaults to hash-mappings.json in the repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_load-conf.sh" 2>/dev/null || true

MAPPINGS_FILE="${1:-hash-mappings.json}"

if [ ! -f "$MAPPINGS_FILE" ]; then
  echo "No hash-mappings.json found at $MAPPINGS_FILE — nothing to validate."
  exit 0
fi

# Check valid JSON
if ! python3 -c "import json; json.load(open('$MAPPINGS_FILE'))" 2>/dev/null; then
  echo "FAIL: $MAPPINGS_FILE is not valid JSON"
  exit 1
fi

# Run validation
python3 -c "
import json, sys, re

with open('$MAPPINGS_FILE') as f:
    data = json.load(f)

errors = []
mappings = data.get('mappings', [])
base64url_re = re.compile(r'^[A-Za-z0-9_-]{10,30}$')
valid_ops = {'equivalent', 'sum', 'average', 'weighted_average', 'first', 'last'}
seen_pairs = set()

for i, m in enumerate(mappings):
    ch = m.get('core_hash', '')
    eq = m.get('equivalent_to', '')
    op = m.get('operation', '')

    # Validate hash format
    if not base64url_re.match(ch):
        errors.append(f'  [{i}] Invalid core_hash: {ch!r}')
    if not base64url_re.match(eq):
        errors.append(f'  [{i}] Invalid equivalent_to: {eq!r}')

    # Self-link check
    if ch == eq:
        errors.append(f'  [{i}] Self-link: {ch} maps to itself')

    # Duplicate check (either direction)
    pair = tuple(sorted([ch, eq]))
    if pair in seen_pairs:
        errors.append(f'  [{i}] Duplicate mapping: {ch} <-> {eq}')
    seen_pairs.add(pair)

    # Operation check
    if op and op not in valid_ops:
        errors.append(f'  [{i}] Invalid operation: {op!r} (expected one of {valid_ops})')

if errors:
    print(f'FAIL: {len(errors)} error(s) in {len(mappings)} mapping(s):')
    for e in errors:
        print(e)
    sys.exit(1)
else:
    print(f'OK: {len(mappings)} mapping(s) validated in $MAPPINGS_FILE')
"
