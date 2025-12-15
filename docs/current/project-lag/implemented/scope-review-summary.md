# Project LAG: Implementation Review Scope Summary

**Created:** 9-Dec-25  
**Purpose:** Document which portions of the project-lag design.md have been deeply reviewed and confirmed vs areas not yet inspected.

---

## Executive Summary

This thread systematically reviewed the **fetch, cache, and merge infrastructure** for window() and cohort() slices. The focus was on ensuring:

1. **Maturity-aware refetch policy** (`shouldRefetch`) correctly uses t95 vs legacy maturity field
2. **Canonical merge** policy for window() and cohort() slices
3. **Evidence and forecast scalar transformation** matches design semantics
4. **Test coverage** for the above is comprehensive and exercises real production code

**Overall coverage estimate:** ~40% of Phase C3 (Data Storage & Aggregation) and ~20% of Phase C4 (Edge Rendering) logic has been deeply reviewed. Core DSL parsing, Amplitude adapter, and UI rendering have NOT been reviewed.

---

## Detailed Breakdown by Design Section

### Section 3: Data Model Changes

| Subsection | Status | Notes |
|------------|--------|-------|
| §3.1 LatencyConfig schema | ⚠️ REFERENCED | Tests use `legacy maturity field`, `anchor_node_id`, `t95` fields but we didn't verify TypeScript/Python type definitions |
| §3.2 Parameter file additions (cohort) | ✅ CONFIRMED | `mergeTimeSeriesInvariants.test.ts` verifies cohort_from/to, dates[], n_daily[], k_daily[], median_lag_days[], mean_lag_days[] |
| §3.2.1 Window slice additions | ✅ CONFIRMED | Tests verify window_from/to, forecast, latency.t95 population |
| §3.3 Canonical sliceDSL format | ✅ CONFIRMED | `mergeTimeSeriesIntoParameter` now generates `window(<abs>:<abs>)` and `cohort(<anchor>,<abs>:<abs>)` canonical formats |
| §3.4 Date format (d-MMM-yy) | ✅ CONFIRMED | All test fixtures and merge code use UK date format |
| §3.5 cost_time → labour_cost rename | ❌ NOT REVIEWED | Not in scope of this thread |

### Section 4: Query Architecture Changes

| Subsection | Status | Notes |
|------------|--------|-------|
| §4.0 DSL Field Glossary | ❌ NOT REVIEWED | We didn't verify store vs persisted DSL field usage |
| §4.1 window() syntax | ✅ CONFIRMED | Tests parse and use window() constraints |
| §4.2 cohort() syntax | ✅ CONFIRMED | Tests parse cohort() with anchor, date ranges |
| §4.3 Maturity is edge-level | ✅ CONFIRMED | `legacy maturity field` on latencyConfig, not DSL |
| §4.4 Amplitude data extraction | ❌ NOT REVIEWED | dayMedianTransTimes, dayFunnels extraction not tested |
| §4.5 Mature vs immature cohort examples | ✅ CONFIRMED | `fetchRefetchPolicy.branches.test.ts` table-driven boundary tests |
| §4.6 Dual-slice retrieval | ⚠️ PARTIALLY | Merge logic handles both; actual dual-fetch from source not tested |
| §4.7.1 Canonical sliceDSL | ✅ CONFIRMED | `mergeTimeSeriesIntoParameter` generates canonical format with anchor + absolute dates |
| §4.7.2 Total maturity (path_t95) | ❌ NOT REVIEWED | DP algorithm for path_t95 not tested |
| §4.7.3 Cache and merge policy | ✅ CONFIRMED | `shouldRefetch` implements gaps_only/partial/replace_slice/use_cache decisions; `mergeTimeSeriesIntoParameter` implements canonical merge |
| §4.8 Query-time vs retrieval-time | ⚠️ PARTIALLY | `addEvidenceAndForecastScalars` tested; but we don't verify full query-time Formula A |

### Section 5: Inference Engine

| Subsection | Status | Notes |
|------------|--------|-------|
| §5.1 Problem statement | ✅ UNDERSTOOD | Context for why forecasting is needed |
| §5.2 Survival analysis framework | ❌ NOT REVIEWED | We reference F(t), S(t) but didn't verify CDF implementation |
| §5.3 Formula A (forecasting) | ⚠️ REFERENCED | `computeEdgeLatencyStats` is called but formula correctness not verified in tests |
| §5.4 Lag distribution fitting | ⚠️ REFERENCED | Log-normal fitting used but μ/σ derivation not directly tested |
| §5.5 Completeness measure | ⚠️ REFERENCED | Completeness computed via `computeEdgeLatencyStats`; formula not directly verified |
| §5.6 Asymptotic p_∞ | ✅ CONFIRMED | `p.forecast` computed and stored; mature cohort filtering tested |
| §5.7 Data flow diagrams | ⚠️ PARTIALLY | Retrieval-time storage confirmed; query-time flow not fully traced |

---

## Files Created and Changes Made

### New Test Files (5 files, ~3,900 lines)

| File | Lines | Coverage Focus |
|------|-------|----------------|
| `fetchRefetchPolicy.branches.test.ts` | ~705 | Branch coverage for t95/legacy maturity field selection, cohort decision tree, window decision tree |
| `fetchPolicyIntegration.test.ts` | ~705 | Integration of shouldRefetch + calculateIncrementalFetch + analyzeSliceCoverage |
| `mergeTimeSeriesInvariants.test.ts` | ~991 | Structural invariants for mergeTimeSeriesIntoParameter: canonical entry, union semantics, sliceDSL format |
| `addEvidenceAndForecastScalars.test.ts` | ~708 | Evidence/forecast scalar transformation via __test_only__ harness |
| `fetchMergeEndToEnd.test.ts` | ~749 | End-to-end toy flows for progressive maturity, cohort replacement, t95 evolution |

### Production Code Changes

| File | Change | Status |
|------|--------|--------|
| `fetchRefetchPolicy.ts` | New module implementing `shouldRefetch`, `analyzeSliceCoverage`, `computeFetchWindow` | ✅ CREATED |
| `windowAggregationService.ts` | Canonical merge for window() and cohort() slices; forecast/latency recomputation on merge | ✅ MODIFIED |
| `dataOperationsService.ts` | Integration of `shouldRefetch`; `addEvidenceAndForecastScalars` fixes; `__test_only__` harness | ✅ MODIFIED |

---

## What Was Deeply Reviewed and Confirmed

### 1. Maturity-Aware Refetch Policy (§4.7.3)

**Location:** `fetchRefetchPolicy.ts`

| Aspect | Confirmed Behaviour |
|--------|---------------------|
| t95 preference | Uses `t95` when available and positive; falls back to `legacy maturity field` |
| t95 rounding | `ceil(t95)` for conservative maturity |
| Cohort: no existing slice | Returns `replace_slice` with reason `no_existing_slice` |
| Cohort: empty dates | Returns `replace_slice` with reason `no_cohort_dates` |
| Cohort: immature cohorts | Returns `replace_slice` with reason `immature_cohorts` |
| Cohort: stale data | Returns `replace_slice` with reason `stale_data` |
| Cohort: all mature + fresh | Returns `use_cache` |
| Window: entirely mature | Returns `gaps_only` |
| Window: includes immature | Returns `partial` with `refetchWindow` |
| Non-latency edge | Returns `gaps_only` (standard incremental) |

### 2. Canonical Merge Policy (§4.7.3)

**Location:** `windowAggregationService.ts` → `mergeTimeSeriesIntoParameter`

| Aspect | Confirmed Behaviour |
|--------|---------------------|
| Window: single canonical entry | Multiple existing window values merged into ONE per context/case family |
| Window: union with new-wins | Overlapping dates use newest fetch data |
| Window: window_from/to update | Span earliest to latest dates in merged data |
| Window: sliceDSL canonical | Format: `window(<abs>:<abs>)[.context(...)]` |
| Cohort: full replacement | All existing cohort values for family replaced by new single value |
| Cohort: anchor in sliceDSL | Format: `cohort(<anchor>,<abs>:<abs>)[.context(...)]` |
| Forecast recomputation | When `recomputeForecast: true`, calls `computeEdgeLatencyStats` |
| Latency recomputation | Updates `latency.median_lag_days`, `latency.t95`, `latency.completeness` |

### 3. Evidence and Forecast Scalars (§4.8)

**Location:** `dataOperationsService.ts` → `addEvidenceAndForecastScalars`

| Aspect | Confirmed Behaviour |
|--------|---------------------|
| Exact slice match | Uses header n/k for evidence (most authoritative) |
| Cohort evidence | Filtered to cohort() window in query DSL |
| Window super-range | Uses full base window totals when query contains stored window |
| Default evidence | Falls back to value's own n/k |
| Forecast from window | Copies forecast from matching window slice for cohort queries |
| Forecast context match | Only uses window slices with matching context dimensions |
| Forecast fallback | Computes from cohort data + `computeEdgeLatencyStats` when no window exists |
| Non-probability passthrough | Returns unchanged for cost/other parameter types |

### 4. Aggregate Totals Consistency

| Invariant | Test Coverage |
|-----------|---------------|
| `n = Σn_daily` | ✅ Single merge and multi-merge cases |
| `k = Σk_daily` | ✅ Single merge and multi-merge cases |
| `mean = round(k/n, 3)` | ✅ Verified after merges |
| `window_from = dates[0]` | ✅ After gap-filling merges |
| `window_to = dates[-1]` | ✅ After gap-filling merges |
| Dates sorted chronologically | ✅ Full loop assertion |

---

## What Was NOT Reviewed

### High Priority (Core Functionality)

| Area | Design Section | Why Important |
|------|----------------|---------------|
| DSL parsing (`cohort()` clause) | §4.1, §4.2 | Core query architecture |
| Amplitude adapter (pre_request for cohort mode) | §4.4 | Data source integration |
| `buildDslFromEdge.ts` cohort mode | Phase C2 | Edge → DSL generation |
| Path maturity DP (`compute_path_t95_for_all_edges`) | §4.7.2 | Total maturity for cache policy |
| Formula A implementation (`statisticalEnhancementService`) | §5.3 | Forecasting correctness |
| Log-normal CDF fitting (μ, σ derivation) | §5.4 | Lag distribution accuracy |
| Completeness formula | §5.5 | Progress measure |
| Implicit baseline window construction | §5.2.1 | Cohort-only query support |

### Medium Priority (UI/Rendering)

| Area | Design Section | Why Important |
|------|----------------|---------------|
| Per-scenario visibility state (F+E/F/E/hidden) | Phase C4 | User experience |
| Two-layer edge rendering | Phase C4 | Visual distinction |
| Properties panel latency settings | Phase C4 | Configuration UI |
| Tooltip data provenance | Phase C4 | Traceability |
| CI bands on striped portion | Phase C4 | Uncertainty visualisation |

### Lower Priority (Extensions)

| Area | Design Section | Why Important |
|------|----------------|---------------|
| Recency weighting for p_∞ | §5.6 | Optional enhancement |
| Effective sample size guard | §5.6 | Quality protection |
| Analysis schema extensions | Phase A1 | Analytics features |
| Bayesian hierarchical model | Phase B2 | Future uncertainty |

---

## Recommended Next Steps

### Immediate (High Value)

1. **Test Formula A implementation** in `statisticalEnhancementService`:
   - Verify `k̂_i = k_i + (n_i - k_i) × [p_∞·S(a_i)] / [1 - p_∞·F(a_i)]`
   - Test edge cases: fully mature, fully immature, k=0, p_∞=0/1

2. **Test log-normal fitting**:
   - Verify μ = ln(median), σ = √(2·ln(mean/median))
   - Verify t95 = median × e^(1.645σ)
   - Test quality gates (k ≥ 30, mean/median in [1.0, 3.0])

3. **Test path_t95 DP algorithm**:
   - Simple path A→X→Y with known t95 per edge
   - Scenario with disabled edges
   - Unreachable nodes

### Medium Term

4. **DSL parsing tests** for `cohort()` clause in `queryDSL.test.ts`

5. **Amplitude adapter tests** for cohort mode in `amplitude_adapter.test.py`

6. **Implicit baseline window tests** per §5.2.1 and §11.2.K

### Lower Priority

7. **UI/rendering tests** (manual verification may be sufficient initially)

8. **Cross-language parity** (TS ↔ Python) for lag maths

---

## Test Metrics Summary

| Metric | Value |
|--------|-------|
| New test files created | 5 |
| Total new test lines | ~3,900 |
| Tests passing | 125/125 |
| Production files modified | 3 |
| Design sections deeply confirmed | ~15 |
| Design sections partially reviewed | ~8 |
| Design sections not reviewed | ~20+ |

---

## Conclusion

The thread achieved **solid coverage of the fetch/cache/merge infrastructure**, which is foundational for the project. The canonical merge policy, maturity-aware refetch, and evidence/forecast scalar transformation are now well-tested.

However, **significant portions of the design remain unverified**:
- The statistical inference engine (Formula A, lag fitting, completeness)
- DSL parsing and Amplitude adapter changes
- UI/rendering changes
- Path maturity computation

These should be prioritised in subsequent review sessions.
