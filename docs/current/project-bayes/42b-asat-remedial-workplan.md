# Doc 42b — asat() Remedial Workplan

**Date**: 16-Apr-26
**Status**: Active — R1 complete, D1/D3/D5/D7/D8 resolved. D2 blocked.
**Depends on**: Doc 42 (asat contract)

---

## 1. Blind Test Results (current — after R1)

Tests: `graph-ops/scripts/asat-blind-test.sh`

| Test | Graph | Result | Finding |
|------|-------|--------|---------|
| T1a | synth-simple-abc | PASS | Baseline evidence.k = 346497 |
| T1b | synth-simple-abc | PASS | asat evidence.k = 77875 (tier 1 snapshot reconstruction) |
| T1c | synth-simple-abc | PASS | p.mean differs: 0.743 (asat) vs 0.708 (baseline) |
| T2 | synth-simple-abc | PASS | asat before first retrieval returns k=0 |
| T3 | synth-simple-abc | PASS | Signature hash identical with/without asat |
| T3b | synth-simple-abc | PASS | evidence.n differs: 170483 (asat) vs 495905 (baseline) |
| T4 | synth-simple-abc | PASS | projected_rate differs at tau=10 |
| T5 | synth-simple-abc | PASS | Param files unchanged after asat query |
| T6 | synth-context-solo-mixed | PASS | Bare-epoch asat: k=5571 < baseline 14775 |
| T7 | synth-context-solo-mixed | PASS | Later asat: k=7485 > k_epoch1 5571 |
| T8 | synth-context-solo-mixed | PASS | Context-qualified asat: k=1301 (tier 2 fallback) |

---

## 2. Root Cause: Wrong Architecture

The original asat implementation treated asat as a **fork** — a
separate code path that retrieved data from the snapshot DB, did a bare
n/k sum, wrote directly to the graph edge, and returned early. This
bypassed the entire normal pipeline (aggregation, evidence scalars,
topo pass, blended rate).

**asat is not a fork. It is a filter on the data source.** The correct
model:

### Three-tier data source model

1. **Tier 1 — snapshot DB available**: reconstruct daily arrays from
   the snapshot DB as-of the asat date. Correct maturity values.
2. **Tier 2 — no snapshots, file data available**: truncate file-cached
   daily arrays by anchor date. Approximation (cohorts look too mature).
3. **Tier 3 — no data**: parameter wasn't fetched before asat date.

All three tiers feed into the **same pipeline** — aggregation, evidence
scalars, topo pass, blended rate.

---

## 3. Completed Work

### R1: Evidence reconstruction in `fileToGraphSync.ts`

Rewrote the asat section in `getParameterFromFile` (the `from-file`
path used by the CLI and browser). Instead of a fork that bypassed the
pipeline, the asat path now:

1. Queries snapshot DB via `querySnapshotsVirtual` (tier 1)
2. Converts rows to daily arrays via `convertVirtualSnapshotToTimeSeries`
3. Replaces the parameter file's in-memory daily arrays
4. Falls through to the normal pipeline (aggregation, evidence scalars,
   topo pass, blended rate)
5. Falls back to tier 2 (file truncation) if no snapshot rows found

**Slice key fix**: the `targetSliceKey` for uncontexted queries must be
the mode clause (`window()` or `cohort()`), not empty string. Empty
string caused `convertVirtualSnapshotToTimeSeries` to return zero rows,
silently falling through to tier 2.

**Test gate**: T1b, T1c, T3b confirm tier 1 works. k=77875 matches
the snapshot DB ground truth (34 rows, sum_y=77875).

### R2 Investigation: Analysis pipeline

The analysis pipeline's cohort_maturity handler passes `sweep_to`
(derived from asat) to the BE's `query_snapshots_for_sweep`. The BE
filters `retrieved_at` by the sweep range. The `projected_rate` column
differs with asat (T4 passes). The observed `rate` is identical at
low tau values because early cohorts are already mature by any
retrieval date — this is correct behaviour, not a bug.

---

## 4. Remaining Defects

### D1: Duplicate asat fork in `getFromSourceDirect.ts` — RESOLVED

The `direct` mode path had a separate broken asat fork (bare n/k sum,
no evidence scalars, no pipeline).

**Fixed**: replaced the 200-line fork with a 15-line delegation to
`getParameterFromFile`, which already handles asat correctly (R1).
No duplicate code path. Unused imports removed.

### D5: Cohort maturity analysis ignores asat — RESOLVED

**Symptom**: `cohort_maturity` analysis with `asat(20-Mar-26)` on
`synth-simple-abc` returns `tau_solid_max=26` and
`boundary_date=2026-04-16` (today). The evidence values (evidence_x,
evidence_y) are the FULL dataset, not asat-filtered. Expected:
`boundary_date` = asat date, `tau_solid_max` ≈ 0 for youngest cohort,
evidence reflecting historical maturity.

**Confirmed independently**: concurrent worker reports same issue
on a different graph — `tau_solid_max=32` when expected ~1.

**Root cause**: the v3 handler's `sweep_to_final` (line 1821 of
`api_handlers.py`) reads `subjects[0].get('sweep_to')`. The FE's
`snapshotDependencyPlanService` sets `sweepTo` from the asat date
(line 1067). But the epoch pre-fetch path (lines 2892–2924) queries
snapshot rows using `sweep_to` as the `retrieved_at` filter — this
correctly limits which retrievals are included. However, the
**frames derived from those rows** still contain data that represents
the full observation history, because `derive_cohort_maturity` builds
virtual snapshots from all raw rows in the sweep window, and the
latest retrieval within the sweep may still show mature data.

The `boundary_date` output being today (not the asat date) confirms
that `sweep_to_final` is either not set or not being used correctly
as the chart boundary. The v3 row builder receives `sweep_to` but
uses it only for the `last_frame_date` filter (line 105), which
correctly bounds `snapshot_date <= sweep_to`. The issue may be that
the frames themselves have `snapshot_date` values that are after the
asat date because the epoch pre-fetch uses `query_snapshots_for_sweep`
(which filters `retrieved_at`) but the derived frames' `snapshot_date`
is set from a different field.

**Fix direction**: trace the `snapshot_date` field on frames produced
by `derive_cohort_maturity`. If `snapshot_date` is the `retrieved_at`
from the raw row (which is filtered by `sweep_to`), the v3 filter
at line 105 should work. If `snapshot_date` is set from something
else (e.g. the `anchor_day`), then it won't be bounded by the sweep.

**Files**: `cohort_maturity_derivation.py` (frame construction),
`cohort_forecast_v3.py` lines 100–110 (last_frame_date filter),
`api_handlers.py` lines 1821, 2892–2924

**Reported by**: concurrent worker session, 16-Apr-26

**Resolution (16-Apr-26)**: two changes:
1. `query_dsl.py`: added `asat` field to `ParsedQuery` and extraction
   of `asat()`/`at()` clauses in `parse_query()`
2. `analysis_subject_resolution.py`: `_resolve_funnel_path` now reads
   `parsed.asat` and sets `sweep_to` to the parsed asat date instead
   of today. Also added missing `import re` (anti-pattern 42).

Test gate: D5a, D5b, D5c all pass in `asat-blind-test.sh` (14/14).

### D2: Posterior not resolved from fit_history

**Blocked** on Bayes worker writing to `fit_history` (doc 27).
`resolveAsatPosterior()` is implemented and wired. No code changes
needed — the data source is missing.

### D3: Completeness not evaluated at historical age — RESOLVED

Forecast engine generalisation (doc 29) now evaluates completeness at
`age = evaluation_date - anchor_day`. Blind tests confirm: completeness
monotonically decreases with earlier asat (0.6525 at Jan vs 0.8896
baseline), p.stdev increases (more uncertainty at lower completeness),
and no completeness is returned for asat before any data. 4/4 D3 tests
pass in `asat-blind-test.sh`.

### D8: Context hash parity (doc 43b) — RESOLVED

`computeQuerySignature` was producing the same `core_hash` for bare
and contexted queries. Fixed via `explode_dsl` changes (see doc 43b).
Mixed-epoch synth graphs can now be regenerated correctly.

---

## 5. Tier 2 Approximation: Truncation

When snapshot data doesn't exist for the asat date, truncate the
file-cached daily arrays to anchor days <= asat date. The Y values
reflect the latest retrieval (too-mature approximation) but the date
range is correct.

---

## 6. Hash Correctness

Uses the stored `query_signature` from the parameter file (via
`selectQuerySignatureForAsat`). Does NOT recompute — avoids
normalisation drift (AP 28) and context-key mismatches (AP 11).

**Known limitations**:
- Multi-epoch signatures: picks most recent; may miss earlier epoch
  data under a different hash
- No equivalence expansion: `equivalent_hashes` not passed
- Context hash parity (doc 43b): bare and contexted queries produce
  the same hash, so tier 1 can't distinguish them
