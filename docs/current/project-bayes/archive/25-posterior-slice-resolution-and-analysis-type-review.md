# Doc 25 — Posterior Slice Resolution and Analysis Type Review

**Status**: Design
**Date**: 27-Mar-26
**Purpose**: Fix how Bayes posterior data flows from `posterior.slices` on
parameter files to graph edges and analysis consumers. Currently the cascade
hardcodes `window()` and `cohort()` slices; consumers either read the wrong
slice or implement ad hoc detection. This doc captures the systematic review
findings and the implementation plan.

**Related**: Doc 21 (unified posterior schema), doc 15 (model vars provenance),
doc 14 (Phase C slice pooling), doc 9 (FE posterior consumption)

---

## 1. Context: how observation data already works

The fetch pipeline is fully slice-aware:

1. `parseConstraints(dsl)` extracts context dimensions + temporal mode
2. `extractSliceDimensions(dsl)` produces the `sliceFamily` (context/case only)
3. `sliceFamily + mode()` → full slice key (e.g., `context(channel:google).window()`)
4. `canonicaliseSliceKeyForMatching()` normalises for deterministic lookups
5. Observation data (`values[]`) is isolated by slice during fetch
6. The topo pass computes `p.mean`, `p.forecast.mean` from isolated values
7. Per-scenario analysis graphs carry context-appropriate observation data

The Bayes posterior does **not** follow this pattern. The cascade projects from
`posterior.slices` onto graph edges using hardcoded `slices['window()']` and
`slices['cohort()']`, regardless of the active query context.

---

## 2. The fix: query-driven posterior slice projection

### 2.1 Shared helper

A `resolvePosteriorSlice()` function using existing normalisation primitives:

- **Input**: `posterior.slices` (the full dict from the param file) + effective DSL
- **Process**: build slice key from DSL using `extractSliceDimensions()` + mode
  detection, normalise via `canonicaliseSliceKeyForMatching()`
- **Lookup**: exact match in `posterior.slices`
- **Fallback**: strip context → try aggregate (`window()` or `cohort()`)
- **Output**: the `SlicePosteriorEntry` to project, or undefined

### 2.2 Projection points

**UpdateManager cascade** (`mappingConfigurations.ts`): The two posterior
transforms (probability and latency) currently hardcode
`value.slices['window()']` and `value.slices['cohort()']`. Instead, use
`resolvePosteriorSlice(value.slices, graph.currentQueryDSL)` to select the
appropriate entry. Falls back to `window()` / `cohort()` when
`currentQueryDSL` is absent or the specific slice doesn't exist.

**Analysis graph composition**: Each scenario's graph is built by
`buildGraphForAnalysisLayer()` with its own `effective_query_dsl`. After
composition, the posterior should be re-projected from the param file's
`posterior.slices` using that scenario's effective DSL. This ensures each
scenario graph carries the right posterior for its query context.

### 2.3 What this achieves

After this fix, `p.posterior.alpha/beta` and `p.latency.posterior.*` on the
graph edge always reflect the active query context. All downstream consumers
(surprise gauge, model CDF, topo pass) read these fields and get the right
values without per-type branching.

---

## 3. Per-type fixes identified during review

### 3.1 Surprise gauge — reference entry ignores quality gate

**File**: `localAnalysisComputeService.ts` line 818
**Bug**: Prefers `model_vars.find(source === 'bayesian')` unconditionally
without checking `gate_passed`. Could show misleading comparison against a
failed-gate posterior.
**Fix**: Use `resolveActiveModelVars()` from `modelVarsResolution.ts`, which
checks `gate_passed` and respects the preference hierarchy.

### 3.2 Surprise gauge — fragile cohort detection

**File**: `localAnalysisComputeService.ts` line 814
**Bug**: Reads `(graph as any).currentQueryDSL` and regex-matches for
`cohort(`. This is an ambient graph property, not the analysis item's own
query context.
**Fix after §2**: Once the cascade projects the right slice onto the graph
edge, the gauge no longer needs `isCohortQuery` branching between
`alpha/beta` and `path_alpha/path_beta`. It reads `p.posterior.alpha/beta`
unconditionally — the cascade already selected the right slice.

### 3.3 BE model CDF — uses window p for all queries

**File**: `api_handlers.py` line 649, 1174, 1218
**Bug**: Reads `p.forecast.mean` (always window-promoted) and uses it to scale
the model CDF curve: `model_rate = forecast_mean * CDF(τ)`. For cohort
queries the Bayes posterior p should be used instead.
**Fix after §2**: Read `p.posterior.alpha / (p.posterior.alpha + p.posterior.beta)`
from the graph edge instead of `p.forecast.mean`. After the cascade fix, this
is the right slice's p.
**Fallback**: If `p.posterior` is absent (no Bayes fit), fall back to
`p.forecast.mean` as before.

### 3.4 BE per-source model curves — all use window p

**File**: `api_handlers.py` line 712
**Bug**: Each source's `forecast_mean` comes from
`model_vars[source].probability.mean`, which is always the window probability
for that source.
**Fix**: For the Bayesian source, use `p.posterior.alpha/(alpha+beta)` (which
after §2 is the right slice). For analytic/analytic_be sources, these come
from the analytics pass which uses observation data — already slice-isolated
by the fetch pipeline — so should already be context-appropriate. Verify this
holds.

### 3.5 model_vars bayesian entry — always from window slice

**File**: `bayesPatchService.ts` line 326
**Current**: Builds `model_vars[bayesian].probability.mean` from
`windowSlice.alpha/(alpha+beta)` at fit-receipt time.
**Decision**: The patch service runs when a Bayes fit result arrives, not at
query time. `model_vars` stays as the "Bayesian source, aggregate window"
entry for backward compatibility and for the promoted-scalar topo pass. The
cascade re-projection (§2) handles query-time slice selection. No change
needed here.

### 3.6 Latency params — already handled correctly on BE

`_resolve_completeness_params()` (`api_handlers.py` line 609) already
switches between edge-level (mu, sigma) for window and path-level (path_mu,
path_sigma) for cohort mode. After §2 this should be verified: once the
cascade projects context-specific latency posterior onto the graph edge, the
BE should read from there rather than maintaining its own window/cohort
switching logic.

---

## 4. Implementation plan

### Phase 1: Shared slice resolution helper

- Create `resolvePosteriorSlice()` in a suitable location (e.g.,
  `modelVarsResolution.ts` or a new `posteriorSliceResolution.ts`)
- Uses `extractSliceDimensions()` from `sliceIsolation.ts` and
  `canonicaliseSliceKeyForMatching()` from `sliceKeyNormalisation.ts`
- Fallback: exact match → strip context to aggregate → undefined
- Pure function, no side effects, easily testable

### Phase 2: Cascade projection

- Modify the two transforms in `mappingConfigurations.ts` (probability
  posterior at line 790, latency posterior at line 828) to use
  `resolvePosteriorSlice()` with `graph.currentQueryDSL` as the effective DSL
- Verify that when `currentQueryDSL` is empty/absent, the fallback produces
  the same result as the current hardcoded `window()` / `cohort()` projection
- The graph edge's `p.posterior` and `p.latency.posterior` now carry the
  query-context-appropriate slice

### Phase 3: Analysis graph re-projection

- In the analysis prep pipeline (after `buildGraphForAnalysisLayer` or within
  `analysisComputePreparationService.ts`), re-project posterior for each
  scenario using that scenario's `effective_query_dsl`
- This ensures per-scenario graphs carry the right posterior even when
  scenarios have different DSLs

### Phase 4: Surprise gauge fixes

- Replace raw `modelVars.find(source === 'bayesian')` with
  `resolveActiveModelVars()` to respect quality gate
- Remove `isCohortQuery` branching — read `p.posterior.alpha/beta`
  unconditionally (the cascade already selected the right slice)
- Remove `graph.currentQueryDSL` read — no longer needed

### Phase 5: BE model CDF fix

- In `api_handlers.py` model CDF generation: read posterior p from
  `p.posterior.alpha/(alpha+beta)` on the graph edge instead of
  `p.forecast.mean`
- Fall back to `p.forecast.mean` when `p.posterior` is absent
- Verify `_resolve_completeness_params` latency switching still correct
  after cascade changes (it should be — the graph edge's latency posterior
  is also now from the right slice)

### Phase 6: Per-source curve verification

- Confirm analytic/analytic_be source `forecast_mean` values are already
  context-appropriate (derived from observation data, which IS slice-isolated)
- For Bayesian source curves: use `p.posterior.alpha/(alpha+beta)` instead of
  `model_vars[bayesian].probability.mean`

---

## 5. Testing strategy

### Unit tests for `resolvePosteriorSlice()`

- Exact match: `window()`, `cohort()`, `context(channel:google).window()`
- Fallback to aggregate when contexted slice not present
- DSL with temporal bounds stripped correctly
- Normalisation consistency with fetch planner's key format
- Empty/absent `currentQueryDSL` falls back to `window()`

### Integration tests for cascade projection

- Parameter file with `posterior.slices` containing window, cohort, and
  contexted entries
- Graph with `currentQueryDSL` set to various values
- Verify correct slice projected onto `p.posterior` and `p.latency.posterior`
- Verify backward compatibility when `currentQueryDSL` is absent

### Analysis pipeline tests

- Multi-scenario analysis where scenarios have different effective DSLs
  (one window, one cohort)
- Verify each scenario graph's `p.posterior` carries the right slice
- Surprise gauge computes correct z-score for cohort query
- Model CDF uses cohort p when query is cohort mode
