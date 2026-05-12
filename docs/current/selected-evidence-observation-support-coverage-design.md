# Selected Evidence Coverage Needs A Longer Observation Horizon

**Status**: proposal for review  
**Date**: 11-May-26  
**Scope**: `cohort_maturity` selected-evidence coverage and fetch/refetch policy

## Testing Plan

The test plan is the review gate for this work. The defect is subtle enough
that implementation discussion without a red outside-in test is not useful.

### Policy Regression

Add focused policy coverage in `graph-editor/src/services/__tests__/fetchRefetchPolicy.test.ts`:

- `window()` latency edge with `t95 = 7` must keep refreshing through an observation horizon of `2 × t95`, not stop at `t95`;
- `cohort()` path-latency case must prefer `path_t95 × 1.5` where `path_t95` exists;
- fallback to edge-local `t95 × 2` when `path_t95` is absent;
- existing low-level tests without injected forecasting settings can keep the historical arithmetic, but production callers must pass settings.

This is the correct red test layer because the root cause is the fetch
planner/refetch policy: it stopped fetching mature-by-`t95` cohort dates, so
the snapshot DB never received later retrieval rows for those anchors.

### Synthetic Fixtures

Keep or add synthetic fixtures that can expose non-lognormal latency
pathologies, but do not use a fixture that bypasses the fetch planner as the
primary proof for this defect. A generated snapshot DB fixture already has
whatever rows the generator wrote; it does not exercise the production
planner's decision to fetch or not fetch.

Useful fixture properties:

- no fetch failures: `failure_rate: 0.0`;
- no sparsity toggles or random frame drops;
- full snapshot window: `snapshot_start_offset: 0`;
- non-lognormal generated latency, e.g. `latency_shape: stepped`, `uniform`, or `capped_lognormal`;
- public outside-in chart tests can then prove the selected-evidence read path handles the resulting data.

This fixture exists because current lognormal synths tend to keep cumulative
values moving for long enough that several defects are hidden. Real production
data and non-lognormal latency shapes do not guarantee that.

### Generator Support

Extend `bayes/synth_gen.py` so truth files can specify non-lognormal latency
shapes without adding new graph-specific branches:

- `latency_shape: lognormal` (default, existing behaviour);
- `latency_shape: stepped`;
- `latency_shape: uniform`;
- `latency_shape: capped_lognormal`.

The generator extension is test infrastructure, not a runtime semantics change.
It lets tests create pathologies that a lognormal-only data-generating process
hides. It is separate from the fetch-policy fix.

### Acceptance

Before the runtime fix:

- the policy test must fail under `t95`-only observation horizon;
- the marked production diagnostic should show DB rows ending at roughly `anchor_day + t95`.

After the fetch-policy fix:

- window fetch/refetch uses `SNAPSHOT_OBSERVATION_T95_MULTIPLIER = 2.0`;
- cohort path fetch/refetch uses `SNAPSHOT_OBSERVATION_PATH_T95_MULTIPLIER = 1.5` when `path_t95` is present;
- the active-cohort coverage regression remains green;
- no chart-specific or selected-evidence-specific branch is added to compensate for missing DB rows.

## Final Status

This note is retained as an investigation record, not as an open selected-evidence
implementation plan.

Final finding: the `window()` coverage collapse was **not** a read-path failure
to carry observation support through `SelectedAClockEvidence`. Direct DB
inspection showed the later retrieval rows were genuinely absent. The root
cause was fetch policy: file header coverage plus `t95`-based maturity caused
the planner to stop fetching older window cohorts too early, so the snapshot DB
never received later observation rows.

Implemented fix: extend snapshot observation refresh horizons through
forecasting settings:

- `SNAPSHOT_OBSERVATION_T95_MULTIPLIER = 2.0`
- `SNAPSHOT_OBSERVATION_PATH_T95_MULTIPLIER = 1.5`

The active `cohort(A!=X)` X-coverage pairing defect remains a separate,
valid selected-evidence fix and regression test.

## Context

The cohort maturity chart now uses one selected-evidence substrate for `window()`, `cohort(A=X)`, and active `cohort(A, X→end)` queries. That substrate is meant to preserve the semantic split documented in:

- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
- `docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md`
- `docs/current/codebase/FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md`
- `docs/current/cohort-maturity-evidence-coverage-design.md`

The displayed rate remains `Y / X`. `X` is the denominator-side selected prefix; `Y` is the subject-end selected prefix. Coverage is not the value itself. Coverage asks whether the selected row had observation support at that chart age.

## Defect

The fetch planner used the model maturity horizon as an observation-complete
horizon. That conflates two different facts:

- **mostly mature by model**: by `t95`, about 95% of eventual conversions are expected to have arrived;
- **observed by data**: a retrieval row exists in the snapshot DB for this selected cohort and retrieval date.

The marked investigation `windowbroken` reproduced the issue on a production-shaped chart with two scenarios:

- active `cohort(15-Apr-26:20-Apr-26)`;
- `window(15-Apr-26:20-Apr-26)`.

After the active-cohort pairing fix, the active cohort scenario fades correctly.
The `window()` scenario did not. Direct DB verification for the target window
hash showed:

- the planner classified the parameter as file-covered and did not fetch;
- the snapshot DB had rows for `15-Apr-26` only through `3-May-26`;
- `16-Apr-26` only through `4-May-26`;
- and so on through `20-Apr-26` only through `9-May-26`.

This is consistent with stopping observation around the edge-local `t95`.
Coverage then collapsed because the DB genuinely lacked later retrieval rows.

## Why It Happens

The normal snapshot write path is dense over the dates it actually fetches:

- `getFromSourceDirect` calls `buildDenseSnapshotRowsForDbWrite`;
- `buildDenseSnapshotRowsForDbWrite` emits one row for every date in the actual fetched window, filling absent adapter rows with `X=0`, `Y=0`;
- `appendSnapshots` writes those rows keyed by `(param_id, core_hash, slice_key, anchor_day, retrieved_at)`.

So the missing rows are not caused by sparse DB writes after a fetch. They are
caused by not fetching the older selected cohorts again once the planner deems
them mature.

Relevant source:

- `graph-editor/src/services/fetchRefetchPolicy.ts`
  - `shouldRefetch`
  - `computeEffectiveMaturity`
  - `computeEffectiveCohortMaturity`
- `graph-editor/src/services/fetchPlanBuilderService.ts`
  - `buildFetchPlan`
  - `computeStaleDates`
- `graph-editor/src/services/dataOperations/getFromSourceDirect.ts`
  - direct execution refetch policy
- `graph-editor/src/services/dataOperations/asatQuerySupport.ts`
  - `buildDenseSnapshotRowsForDbWrite`
- `graph-editor/src/services/snapshotWriteService.ts`
  - `appendSnapshots`

`window()` exposes the bug clearly because the placement map is identity:

`observed_date = selected cohort day`, `τ = retrieved_at - observed_date`

There is no carrier backmap or latency smoothing to distribute support across
other anchors. If the DB row was never written, coverage is exactly zero for
that selected cohort at that `τ`.

## Required Invariants

The fix must preserve these invariants:

1. No mode-specific branches. No `if window`, no `if cohort`, no `if multi-hop`.
2. Query shapes specialise only through data:
   - identity placement map for `window()` and `cohort(A=X)`;
   - non-identity placement map for active `cohort(A!=X)`;
   - one-edge topology for single-hop;
   - N-edge topology for multi-hop.
3. `t95` and `path_t95` are model maturity horizons, not observation-stop horizons.
4. Snapshot observation horizons must be configurable forecasting settings.
5. Dense DB writes only happen for fetched windows; planner coverage must not infer DB retrieval support from parameter-file header coverage alone.

## Proposed Implementation

Add two forecasting settings:

- `SNAPSHOT_OBSERVATION_T95_MULTIPLIER`, default `2.0`;
- `SNAPSHOT_OBSERVATION_PATH_T95_MULTIPLIER`, default `1.5`.

Use these only for fetch/refetch observation horizon decisions. Do not change
the model completeness calculation, displayed `t95`, fitted latency, or
Bayesian settings.

Policy:

- `window()` with edge-local `t95`: refresh until `t95 × 2`;
- `cohort()` with `path_t95`: refresh until `path_t95 × 1.5`;
- `cohort()` without `path_t95`: fall back to edge-local `t95 × 2`.

## Test Requirements

Tests should prove the support/value separation directly:

1. Plateau with continued retrievals:
   - values stop changing;
   - retrievals continue;
   - coverage remains `1` through epoch A.
2. Epoch B decay:
   - selected cohorts age out one at a time;
   - coverage fades approximately `1 → 5/6 → 4/6 → ... → 0`.
3. Negative support:
   - values forward-fill;
   - no retrieval/support event at `τ`;
   - coverage remains `0`.
4. Topology degeneracy:
   - `window()` and `cohort(A=X)` use the same support pipeline;
   - single-hop and multi-hop use the same support pipeline;
   - no test should rely on mode-specific branches.

Existing relevant tests:

- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`
  - outside-in active-cohort coverage regression;
  - clean coverage invariant tests;
- `graph-editor/lib/tests/test_active_cohort_display_invariants.py`
  - direct coverage and covered-zero tests;
- `graph-editor/lib/tests/test_selected_evidence_natural_degeneracy.py`
  - identity-carrier selected-evidence builder tests.

## Review Questions

Review should focus on:

1. Where should observation-support events live: inside `WeightedPrimitiveEvidenceView`, as a sibling view, or as a separate selected-evidence input?
2. Should `merge_evidence_candidates` own preservation of plateau retrievals, or should support events be built before value-oriented merge/dedupe?
3. What is the correct topology composition operator for support in multi-hop paths?
4. How do we expose diagnostics so future marks show support events separately from value rows?

The core principle for review is simple:

> Coverage is an observation-support stream, placed and composed by the same generic selected-evidence algebra as values, but never inferred from value movement.
