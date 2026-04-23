#!/usr/bin/env bash
#
# Multi-hop cohort/window metamorphic canary (doc 64 Family D + G).
#
# Two metamorphic claims, stated as collapse and divergence relations
# that together pin down the subject-evidence selection rule:
#
#   Claim 1 — COLLAPSE.  For a multi-hop from(X).to(Y) where the
#   upstream A -> ... -> X segment has NO latency edges, cohort()
#   and window() must produce approximately equal evidence_x,
#   evidence_y, and midpoint at each tau. Both modes observe the
#   same population at the same ages — the evidence basis is
#   identical.
#
#   Fixture: synth-mirror-4step. Subject = m4-delegated -> m4-success.
#   Upstream m4-landing -> m4-created -> m4-delegated is instant.
#
#   Claim 2 — DIVERGE.  For a single-hop from(X).to(Y) where the
#   upstream A -> ... -> X segment HAS latency, cohort() evidence_x
#   must grow with tau (upstream maturity) while window() evidence_x
#   is flat. A pass proves the Claim-1 fix was not applied too
#   broadly.
#
#   Fixture: synth-mirror-4step. Subject = m4-registered -> m4-success.
#   Upstream m4-delegated -> m4-registered has latency.
#
# ── Authoring receipt (doc 64 §3.6) ─────────────────────────────────
#
# Family         D + G. Metamorphic semantics plus outside-in CLI
#                canary — doc 64 §5.4 designates this seam for CLI
#                coverage because the defect class has escaped
#                through public tooling before.
# Invariant      Collapse when upstream is non-latent; diverge when
#                upstream is latent. The two claims form a
#                positive/negative pair that prevents the fix for
#                the collapse claim from silently stomping the
#                divergence claim.
# Oracle type    Blind metamorphic relation. Not legacy parity:
#                the claim is about v3 behaviour under a controlled
#                DSL transformation, not about matching v2.
# Apparatus      CLI canary driving analyse.sh against the live
#                Python BE on localhost:9000. A Python integration
#                test would miss the tooling path where this defect
#                has historically escaped.
# Fixtures       synth-mirror-4step — the designated multi-hop
#                collapse/diverge fixture (doc 64 §6.4). The
#                non-latent upstream and latent-upstream edges are
#                both present in the same graph so one fixture
#                covers both claims.
# Reality        Real Python BE + real snapshot DB. No mocks, no
#                stubs. Data-freshness setup is in Phase A and is
#                deliberately separate from Phase B (semantic
#                claims); re-runs can skip setup with --no-setup.
# False-pass     Either claim could pass vacuously — Claim 1 if
#                both modes return zeros (mitigated by the printed
#                ratio table and a non-zero check); Claim 2 if the
#                fix is too broad (the claim IS the "not too broad"
#                test). Claim 2 passing while Claim 1 fails would
#                mean the broad evidence basis is correct but the
#                collapse-on-non-latent-upstream rule is broken.
# Retires        Supersedes only the "RED test for doc #47" framing.
#                The v2 cross-version signal is retained below as a
#                debugging aid — it distinguishes "v3 regressed" from
#                "defect shared with v2" when Claim 1 fails. It will
#                be removed alongside v2 (doc 64 §8.3, §11) once a
#                v2-free replacement signal exists.
#
# Usage:
#   bash graph-ops/scripts/multihop-evidence-parity-test.sh [graph-name] [--no-setup]
#
# Prerequisites:
#   - Python BE running on localhost:9000
#   - Synth graph present in the snapshot DB (run without --no-setup
#     the first time, then --no-setup on re-runs to skip synth_gen)

set -o pipefail

. "$(dirname "$0")/_load-conf.sh"

SKIP_SETUP=0
_POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --no-setup) SKIP_SETUP=1 ;;
    *) _POSITIONAL+=("$arg") ;;
  esac
done
set -- "${_POSITIONAL[@]}"

GRAPH_NAME="${1:-synth-mirror-4step}"
shift || true

# ═══════════════════════════════════════════════════════════════════
# Phase A — Data freshness (setup, separate from semantic claims)
# ═══════════════════════════════════════════════════════════════════

_ensure_synth_data() {
  local graph_name="$1"
  echo "  Checking synth data freshness for $graph_name..."
  (
    cd "$_DAGNET_ROOT"
    . graph-editor/venv/bin/activate
    PYTHONPATH="$_DAGNET_ROOT" \
    DB_CONNECTION="$(grep DB_CONNECTION graph-editor/.env.local | cut -d= -f2-)" \
      python bayes/synth_gen.py --graph "$graph_name" --write-files --enrich
  ) || { echo "ERROR: synth_gen failed for $graph_name"; exit 1; }
}

if [ "$SKIP_SETUP" = "1" ]; then
  echo "[Phase A] Skipping setup (--no-setup). Using existing snapshot DB state."
else
  echo "[Phase A] Refreshing synth data"
  _ensure_synth_data "$GRAPH_NAME"
fi

PASS=0
FAIL=0
TOTAL=0

_check() {
  local label="$1"
  local result="$2"
  TOTAL=$((TOTAL + 1))
  if [ "$result" = "0" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $label"
  fi
}

# ── Date range for synth data ────────────────────────────────────────
# synth-mirror-4step anchor_days: ~31-Jan-26 to ~21-Mar-26
DATE_RANGE="1-Feb-26:15-Mar-26"

# ── Run analyse.sh and extract JSON ─────────────────────────────────
_run_analyse() {
  local dsl="$1"
  local outfile="$2"
  bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" "$dsl" \
    --type cohort_maturity --topo-pass --no-snapshot-cache --no-cache --format json \
    2>/dev/null | sed '/^Now using/d' > "$outfile" || true
}

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo ""
echo "══════════════════════════════════════════════════════"
echo "[Phase B] Metamorphic claims on $GRAPH_NAME"
echo "          Date range: $DATE_RANGE"
echo "══════════════════════════════════════════════════════"

# ══════════════════════════════════════════════════════════════════════
# Claim 1 — Multi-hop COLLAPSE on non-latent upstream
# ══════════════════════════════════════════════════════════════════════
#
# Subject: from(m4-delegated).to(m4-success) — 2-hop span.
# Upstream: m4-landing → m4-created → m4-delegated — all zero latency.
#
# Because upstream is instant, cohort and window observe the same
# denominator and numerator. evidence_x, evidence_y, and midpoint
# must collapse within tolerance at every tau.

echo ""
echo "Claim 1 — Multi-hop COLLAPSE (non-latent upstream)"

_define_cases_synth_mirror_4step() {
  # Multi-hop subject spanning two latency edges
  MULTIHOP_DSL="from(m4-delegated).to(m4-success)"
}

_define_cases_synth_mirror_4step

W_MH="$TMPDIR/window_multihop.json"
C_MH="$TMPDIR/cohort_multihop.json"

echo "  Running window: ${MULTIHOP_DSL}.window(${DATE_RANGE})"
_run_analyse "${MULTIHOP_DSL}.window(${DATE_RANGE})" "$W_MH"

echo "  Running cohort: ${MULTIHOP_DSL}.cohort(${DATE_RANGE})"
_run_analyse "${MULTIHOP_DSL}.cohort(${DATE_RANGE})" "$C_MH"

# ── Compare evidence_x ──────────────────────────────────────────────
echo ""
echo "  evidence_x comparison:"
EX_RESULT=$(python3 -c "
import json, sys

def load_rows(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        # Strip any nvm output before JSON
        lines = raw.split('\n')
        for i, l in enumerate(lines):
            if l.startswith('{'):
                raw = '\n'.join(lines[i:])
                break
        d = json.loads(raw)
        return d.get('result', {}).get('data', [])
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return []

w_rows = load_rows('$W_MH')
c_rows = load_rows('$C_MH')

if not w_rows or not c_rows:
    print('FAIL:no data returned (window={} cohort={})'.format(len(w_rows), len(c_rows)))
    sys.exit(0)

w_by_tau = {r['tau_days']: r for r in w_rows}
c_by_tau = {r['tau_days']: r for r in c_rows}
shared = sorted(set(w_by_tau) & set(c_by_tau))

# Skip tau < 3: sweep boundary artefact where youngest cohorts
# don't yet have a retrieval row even with window evidence.
# The meaningful invariant starts once sweep coverage is full.
MIN_TAU = 3

failures = []
printed = 0
print(f'  {\"tau\":>4s}  {\"window_x\":>10s}  {\"cohort_x\":>10s}  {\"ratio\":>8s}')
for tau in shared:
    if tau < MIN_TAU:
        continue
    w_x = w_by_tau[tau].get('evidence_x')
    c_x = c_by_tau[tau].get('evidence_x')
    if w_x is None or c_x is None or w_x == 0:
        continue
    ratio = c_x / w_x
    gap = abs(1.0 - ratio)
    if printed < 15 or gap >= 0.05:
        marker = ' ✗' if gap >= 0.05 else ''
        print(f'  {tau:4d}  {w_x:10.0f}  {c_x:10.0f}  {ratio:8.3f}{marker}')
        printed += 1
    if gap >= 0.05:
        failures.append(tau)

if failures:
    print(f'FAIL:evidence_x diverges at {len(failures)} tau values (>5% gap)')
else:
    print(f'PASS:evidence_x matches within 5% at all tau>={MIN_TAU} values')
" 2>&1)

echo "$EX_RESULT"
TOTAL=$((TOTAL + 1))
if echo "$EX_RESULT" | grep -q '^PASS:'; then
  PASS=$((PASS + 1))
  echo "  ✓ evidence_x parity"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ evidence_x parity"
fi

# ── Compare evidence_y ──────────────────────────────────────────────
echo ""
echo "  evidence_y comparison:"
EY_RESULT=$(python3 -c "
import json, sys

def load_rows(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        lines = raw.split('\n')
        for i, l in enumerate(lines):
            if l.startswith('{'):
                raw = '\n'.join(lines[i:])
                break
        d = json.loads(raw)
        return d.get('result', {}).get('data', [])
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return []

w_rows = load_rows('$W_MH')
c_rows = load_rows('$C_MH')

if not w_rows or not c_rows:
    print('FAIL:no data returned')
    sys.exit(0)

w_by_tau = {r['tau_days']: r for r in w_rows}
c_by_tau = {r['tau_days']: r for r in c_rows}
shared = sorted(set(w_by_tau) & set(c_by_tau))

failures = []
printed = 0
print(f'  {\"tau\":>4s}  {\"window_y\":>10s}  {\"cohort_y\":>10s}  {\"ratio\":>8s}')
for tau in shared:
    w_y = w_by_tau[tau].get('evidence_y')
    c_y = c_by_tau[tau].get('evidence_y')
    if w_y is None or c_y is None:
        continue
    if w_y == 0 and c_y == 0:
        continue
    if w_y == 0:
        failures.append(tau)
        continue
    ratio = c_y / w_y
    gap = abs(1.0 - ratio)
    if printed < 15 or gap >= 0.05:
        marker = ' ✗' if gap >= 0.05 else ''
        print(f'  {tau:4d}  {w_y:10.0f}  {c_y:10.0f}  {ratio:8.3f}{marker}')
        printed += 1
    if gap >= 0.05:
        failures.append(tau)

if failures:
    print(f'FAIL:evidence_y diverges at {len(failures)} tau values (>5% gap)')
else:
    print(f'PASS:evidence_y matches within 5% at all {len(shared)} tau values')
" 2>&1)

echo "$EY_RESULT"
TOTAL=$((TOTAL + 1))
if echo "$EY_RESULT" | grep -q '^PASS:'; then
  PASS=$((PASS + 1))
  echo "  ✓ evidence_y parity"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ evidence_y parity"
fi

# ── Compare midpoint ────────────────────────────────────────────────
echo ""
echo "  midpoint comparison:"
MID_RESULT=$(python3 -c "
import json, sys

def load_rows(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        lines = raw.split('\n')
        for i, l in enumerate(lines):
            if l.startswith('{'):
                raw = '\n'.join(lines[i:])
                break
        d = json.loads(raw)
        return d.get('result', {}).get('data', [])
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return []

w_rows = load_rows('$W_MH')
c_rows = load_rows('$C_MH')

if not w_rows or not c_rows:
    print('FAIL:no data returned')
    sys.exit(0)

w_by_tau = {r['tau_days']: r for r in w_rows}
c_by_tau = {r['tau_days']: r for r in c_rows}
shared = sorted(set(w_by_tau) & set(c_by_tau))

failures = []
printed = 0
print(f'  {\"tau\":>4s}  {\"window_mid\":>12s}  {\"cohort_mid\":>12s}  {\"ratio\":>8s}')
for tau in shared:
    w_m = w_by_tau[tau].get('midpoint')
    c_m = c_by_tau[tau].get('midpoint')
    if w_m is None or c_m is None:
        continue
    if w_m < 0.001:
        continue  # skip near-zero where ratio is unstable
    ratio = c_m / w_m
    gap = abs(1.0 - ratio)
    if printed < 15 or gap >= 0.15:
        marker = ' ✗' if gap >= 0.15 else ''
        print(f'  {tau:4d}  {w_m:12.5f}  {c_m:12.5f}  {ratio:8.3f}{marker}')
        printed += 1
    if gap >= 0.15:
        failures.append(tau)

if failures:
    print(f'FAIL:midpoint diverges at {len(failures)} tau values (>15% gap)')
else:
    print(f'PASS:midpoint matches within 15% at all tau values')
" 2>&1)

echo "$MID_RESULT"
TOTAL=$((TOTAL + 1))
if echo "$MID_RESULT" | grep -q '^PASS:'; then
  PASS=$((PASS + 1))
  echo "  ✓ midpoint parity"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ midpoint parity"
fi

# ══════════════════════════════════════════════════════════════════════
# Cross-version signal — v3 regression check against v2
# ══════════════════════════════════════════════════════════════════════
#
# When Claim 1 above fails, it is useful to know whether the defect
# is shared with v2 (broken everywhere) or specific to v3 (v3
# regressed). Running the same multi-hop query under v2 and comparing
# evidence_x under window and cohort modes tells us: v2 passes this
# check while v3 fails, so the defect is v3-specific.
#
# Retained provisionally. Will be removed when v2 is deleted
# (doc 64 §8.3, §11). A v2-free replacement would need a historical
# baseline or an analytic oracle for the multi-hop collapse claim.

echo ""
echo "Cross-version signal — v3 regression check against v2"

W_V2="$TMPDIR/v2_window_multihop.json"
C_V2="$TMPDIR/v2_cohort_multihop.json"

echo "  Running V2 window..."
bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" \
  "${MULTIHOP_DSL}.window(${DATE_RANGE})" \
  --type cohort_maturity_v2 --topo-pass --no-snapshot-cache --no-cache --format json \
  2>/dev/null | sed '/^Now using/d' > "$W_V2" || true

echo "  Running V2 cohort..."
bash "$_DAGNET_ROOT/graph-ops/scripts/analyse.sh" "$GRAPH_NAME" \
  "${MULTIHOP_DSL}.cohort(${DATE_RANGE})" \
  --type cohort_maturity_v2 --topo-pass --no-snapshot-cache --no-cache --format json \
  2>/dev/null | sed '/^Now using/d' > "$C_V2" || true

V2_RESULT=$(python3 -c "
import json, sys

def load_rows(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        lines = raw.split('\n')
        for i, l in enumerate(lines):
            if l.startswith('{'):
                raw = '\n'.join(lines[i:])
                break
        d = json.loads(raw)
        return d.get('result', {}).get('data', [])
    except:
        return []

w_rows = load_rows('$W_V2')
c_rows = load_rows('$C_V2')

if not w_rows or not c_rows:
    print('FAIL:no V2 data returned')
    sys.exit(0)

w_by_tau = {r['tau_days']: r for r in w_rows}
c_by_tau = {r['tau_days']: r for r in c_rows}
shared = sorted(set(w_by_tau) & set(c_by_tau))

failures = []
for tau in shared:
    if tau < 3:
        continue
    w_x = w_by_tau[tau].get('evidence_x')
    c_x = c_by_tau[tau].get('evidence_x')
    if w_x is None or c_x is None or w_x == 0:
        continue
    ratio = c_x / w_x
    gap = abs(1.0 - ratio)
    if gap >= 0.05:
        failures.append(tau)

if failures:
    print(f'FAIL:V2 evidence_x also diverges at {len(failures)} tau values — defect is shared, not v3-specific')
else:
    print(f'PASS:V2 evidence_x matches within 5% — if Claim 1 fails, the v3 path has regressed')
" 2>&1)

echo "$V2_RESULT"
TOTAL=$((TOTAL + 1))
if echo "$V2_RESULT" | grep -q '^PASS:'; then
  PASS=$((PASS + 1))
  echo "  ✓ v2 multi-hop collapse holds (signal: v3-specific regression if Claim 1 red)"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ v2 multi-hop collapse also fails (signal: defect shared with v2)"
fi

# ══════════════════════════════════════════════════════════════════════
# Claim 2 — Single-hop DIVERGE on latent upstream
# ══════════════════════════════════════════════════════════════════════
#
# Subject: from(m4-registered).to(m4-success) — single-hop. Upstream
# traverses m4-delegated → m4-registered which HAS latency.
#
# Cohort evidence_x must grow with tau (upstream maturity) while
# window evidence_x stays flat. They MUST differ. A pass here proves
# the Claim-1 collapse fix was not applied too broadly.

echo ""
echo "Claim 2 — Single-hop DIVERGE (latent upstream)"

SH_DSL="from(m4-registered).to(m4-success)"

W_SH="$TMPDIR/window_singlehop.json"
C_SH="$TMPDIR/cohort_singlehop.json"

echo "  Running single-hop window..."
_run_analyse "${SH_DSL}.window(${DATE_RANGE})" "$W_SH"

echo "  Running single-hop cohort..."
_run_analyse "${SH_DSL}.cohort(${DATE_RANGE})" "$C_SH"

SH_RESULT=$(python3 -c "
import json, sys

def load_rows(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        lines = raw.split('\n')
        for i, l in enumerate(lines):
            if l.startswith('{'):
                raw = '\n'.join(lines[i:])
                break
        d = json.loads(raw)
        return d.get('result', {}).get('data', [])
    except:
        return []

w_rows = load_rows('$W_SH')
c_rows = load_rows('$C_SH')

if not w_rows or not c_rows:
    print('FAIL:no single-hop data returned')
    sys.exit(0)

w_by_tau = {r['tau_days']: r for r in w_rows}
c_by_tau = {r['tau_days']: r for r in c_rows}
shared = sorted(set(w_by_tau) & set(c_by_tau))

divergent = 0
for tau in shared:
    w_x = w_by_tau[tau].get('evidence_x')
    c_x = c_by_tau[tau].get('evidence_x')
    if w_x is not None and c_x is not None and w_x > 0:
        if abs(c_x / w_x - 1.0) > 0.05:
            divergent += 1

if divergent > 0:
    print(f'PASS:single-hop evidence_x diverges at {divergent} taus (expected — upstream has latency)')
else:
    print(f'FAIL:single-hop evidence_x identical — fix may have been applied too broadly')
" 2>&1)

echo "$SH_RESULT"
TOTAL=$((TOTAL + 1))
if echo "$SH_RESULT" | grep -q '^PASS:'; then
  PASS=$((PASS + 1))
  echo "  ✓ single-hop divergence preserved"
else
  FAIL=$((FAIL + 1))
  echo "  ✗ single-hop divergence missing (fix too broad?)"
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "══════════════════════════════════════════════════════"

exit "$FAIL"
