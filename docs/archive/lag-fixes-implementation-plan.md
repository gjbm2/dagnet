# LAG Stats & Convolution — Implementation Plan

**Created:** 10-Dec-25  
**Status:** ✅ Complete (all phases done 10-Dec-25)  
**Reference:** `stats-convolution-schematic.md` (now at `graph-editor/public/docs/lag-statistics-reference.md`)

---

## Overview

This document details the fixes required to align LAG (Latency-Aware Graph) statistics with the canonical design in `stats-convolution-schematic.md`. Issues are grouped into phases by priority.

**Key insight:** Existing tests (`lagStatsFlow.integration.test.ts`) all pass because they test the **current (buggy) behaviour**, not the correct design. We must:
1. Write new tests encoding the **correct** design from the schematic
2. Run them — they should **FAIL** against current code
3. Fix the code to make them pass

---

## Phase 0: Design-Driven Tests (TDD)

### Test File
`graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`

The goal of Phase 0 is to create a **high‑fidelity, design‑driven test harness** that encodes the canonical behaviour from `stats-convolution-schematic.md`. These tests should:

- Describe scenarios in terms of **graph shape**, **cohort ages**, **lag parameters**, and **expected qualitative outcomes**.
- Be written so that they **FAIL against the current implementation** where that implementation diverges from the design.
- Become the **non‑negotiable benchmark** for all subsequent refactors to LAG.

Below, “expected behaviour” always means “what the schematic says should happen”, not “what the code currently does”.

---

### T1. Completeness uses `anchor_median_lag`, not `path_t95`

**Intent:** Prove that effective age for downstream edges is based on **anchor‑to‑source median lag** (`anchor_median_lag_days`), not the cumulative 95th‑percentile bound (`path_t95`).

**Scenario (downstream edge X→Y):**
- Anchor A; first latency edge C→X; downstream latency edge X→Y.
- Cohorts at the anchor are **20–24 days old** at the analysis date.
- C→X has `anchor_median_lag_days ≈ 5` days (A→X median lag), so a typical user spends ~5 days upstream before reaching X.
- X→Y has its own lag distribution with a modest t95 (e.g. ≈ 10 days) so that ages in the **15–19 day** range (20–24 minus 5) lie well into the mature regime.
- A separate computation of `path_t95` along A→…→X→Y could easily be **25+ days** if we sum conservative t95s.

**What the test should exercise:**
- Construct cohorts such that:
  - The **raw anchor age** distribution is centred around 22 days.
  - The **anchor_median_lag_days** for A→X is small (≈ 5) compared to that age.
  - A hypothetical `path_t95` is significantly larger than the typical anchor ages (e.g. 25–30 days).
- Feed these cohorts through the latency stats pipeline in a way that:
  - The **effective age used for completeness** is clearly closer to “raw anchor age minus 5 days” than to 0.

**Expected behaviour (design):**
- Effective ages at X→Y cluster in the mid‑teens (e.g. 15–19 days).
- The log‑normal CDF at those ages is **very close to 1**, so **completeness is high** (for example, at least 0.9).
- Changing the hypothetical `path_t95` should **not materially change** completeness, because completeness does **not** use `path_t95`.

**Current implementation (known bug):**
- Uses `path_t95` to adjust cohort ages such that effective age is the raw age minus `path_t95`, clamped at zero.
- In a configuration where `path_t95` exceeds typical raw ages:
  - All effective ages clamp to 0.
  - The CDF at 0 is near 0, so completeness is reported near 0.

**Test outcome:** The test should assert (first in words, then in concrete numeric checks in code) that completeness is high and **does not collapse towards 0** when `path_t95` is large but `anchor_median_lag_days` is small. It should fail until we switch the implementation to use anchor lag.

---

### T2. Cohort ages relative to TODAY, not DSL window end

**Intent:** Ensure cohort age is measured relative to the **analysis date** (“today”), not the DSL cohort window end. A cohort that entered 4 weeks ago must be treated as 4 weeks old, regardless of how narrow the cohort window in the DSL is.

**Scenario:**
- Single latency edge from anchor A to X.
- Parameter file contains cohorts for early November.
- DSL query uses a short cohort window (for example, `cohort(1-Nov-25:7-Nov-25)`).
- The user analyses the graph on **1‑Dec‑25**.

**What the test should exercise:**
- Run the cohort aggregation and latency enhancement with:
  - `queryDate = 1‑Dec‑25`.
  - `cohortWindow` matching the DSL window (for example, 1‑Nov‑25 to 7‑Nov‑25).
- Inspect the resulting cohort ages and the completeness on a short‑lag edge (for example, median lag around 3 days, legacy maturity field around 7 days).

**Expected behaviour (design):**
- Cohort ages are **approximately 24–30 days** (1‑Dec minus early‑November).
- For a 7‑day maturity edge:
  - Those cohorts are extremely mature.
  - Completeness on that edge is **very close to 1** (for example, at least 0.95).

**Current implementation (known bug):**
- Derives “now” for lag as “cohort window end or today”.
- If the cohort window end is used (for example, 7‑Nov‑25):
  - Cohorts are treated as **0–6 days old**, no matter when analysis occurs.
  - Completeness remains artificially low, even months later.

**Test outcome:** The test should enforce that the age calculation uses the real analysis date and that completeness reflects true time since cohort entry. It should fail while ages are still capped by the DSL window end.

---

### T3. Completeness formula matches n‑weighted CDF average

**Intent:** Lock in the exact mathematical definition of completeness as the **n‑weighted mean of per‑cohort lag CDF values**, using the log‑normal CDF as the oracle for per‑cohort completeness.

**Scenario:**
- A small synthetic cohort set (for example, 4–6 cohorts) with:
  - Explicit ages (for example, 1, 2, 3, 4, 5 days).
  - Chosen n values (deliberately varied to make the weighting obvious).
- Fixed μ and σ (derived from a simple median and dispersion).

**What the test should exercise:**
- Independently compute, in the test:
  - For each cohort: a per‑cohort completeness value from the log‑normal CDF at that age.
  - An “expected completeness” as the sum of n times per‑cohort completeness, divided by the total n.
- Call the completeness helper with the same cohorts and the same μ and σ.

**Expected behaviour (design):**
- The completeness helper returns a value **numerically indistinguishable** from the n‑weighted average (within a small tolerance due to floating‑point error).
- The function:
  - Ignores cohorts with n = 0 in the denominator.
  - Handles empty cohort arrays by returning 0 (already partially tested as an edge case).

**Current implementation:** We believe the helper already follows this formula, but this test locks the definition down and guards against regressions as we refactor effective age.

**Test outcome:** Should pass if the formula is correct; if it fails, we have a direct, localised indication of a structural bug in the completeness implementation.

---

### T4. Mature cohort with short‑lag edge has ~100% completeness

**Intent:** Provide a **high‑level behavioural invariant**: for an edge whose lag distribution is short compared to cohort age, completeness should be essentially 100%. This encodes the registration‑to‑success complaint in an abstracted, repeatable way.

**Scenario:**
- Single latency edge with:
  - Median lag around 3 days.
  - Maturity_days = 7 days.
- Single cohort (or a few similar cohorts) with:
  - Age around 28 days (4 weeks).
  - Reasonable k/n (for example, around 50%, but the exact value is not critical).

**What the test should exercise:**
- Call the edge‑level latency stats computation with this cohort set and no upstream adjustment (first latency edge, so no anchor subtraction).
- Examine the returned completeness.

**Expected behaviour (design):**
- With ages much greater than legacy maturity field, the log‑normal CDF should be essentially saturated.
- Completeness should be **very close to 1** (for example, at least 0.99).
- This should hold regardless of the exact evidence mean or long‑run forecast; it is purely a timing property.

**Current behaviour (known bug):**
- Real data has shown edges like registration→success reporting **around 30–40%** completeness despite 4‑week‑old cohorts on short‑lag edges.
- This indicates either:
  - Wrong effective ages,
  - Wrong μ/σ or t95,
  - Or incorrect aggregation.

**Test outcome:** The test should explicitly assert that completeness for a 4‑week‑old cohort on a 7‑day edge is near 1.0. It should fail until the age and aggregation bugs are resolved.

---

### T5. `p_infinity` fallback when no window() slice

**Intent:** Ensure that edges **without any window() slice** still benefit from a forecast baseline by using LAG’s `p_infinity` as `p.forecast.mean`, rather than silently dropping into pure‑evidence mode.

**Scenario:**
- A latency edge where:
  - Parameter data contains **only cohort() slices** (no window slices at all).
  - Cohorts are mature enough for the latency engine to estimate a reliable `p_infinity`.
- Graph / edge configuration:
  - The edge’s forecast field is initially absent in the graph (because no window slice exists).
  - The edge’s evidence mean is known from the query window.

**What the test should exercise:**
- Run the graph‑level latency enhancement for this edge with the above data, then inspect the resulting per‑edge LAG values:
  - Confirm that a **forecast baseline** is available in the output, even in the absence of window slices.
  - Confirm that a **blended probability** is computed, not just pure evidence.

**Expected behaviour (design):**
- The latency engine estimates `p_infinity` from its mature cohorts.
- That `p_infinity` is adopted as the edge’s effective `p.forecast.mean` for blending.
- The baseline sample size for the blend comes from the n of those mature cohorts.
- The blended probability lies **between** the evidence mean and `p_infinity`, weighted by completeness and n as per the design blend formula.

**Current implementation (gap):**
- Blend logic depends solely on an explicit `p.forecast.mean` already stored on the edge.
- If no window slice has populated this, the blend step is skipped and **no blended mean is produced**, leaving the edge’s probability anchored to evidence only.

**Test outcome:** The test should treat “no blended mean when cohorts are mature and p_infinity is available” as a failure. It should only pass once cohort‑only edges get a proper forecast baseline via p_infinity.

---

### T6. Scenario‑aware active edges (conditional / case‑weighted)

**Intent:** Guarantee that the **active edge set** used for both inbound‑n and path_t95 reflects scenario choices (conditional probabilities, case allocations, switches), rather than always using base probabilities.

**Scenario:**
- Small graph with:
  - A split node X with two outbound edges:
    - X→Y_treatment (case “treatment”).
    - X→Y_control (case “control”).
  - Case allocation or conditional probability such that, in a given scenario S:
    - Treatment weight = 100%.
    - Control weight = 0%.
- Under this scenario, only treatment should be considered “active”.

**What the test should exercise:**
- Use the same scenario DSL / what‑if machinery as production to:
  - Compute effective probabilities for edges under scenario S.
  - Call inbound‑n with a scenario‑aware probability getter.
  - Call the active‑edge helper (once refactored) with scenario context.
- Inspect both:
  - The active edge set.
  - The resulting forecast populations and expected converters along each branch.

**Expected behaviour (design):**
- Under scenario S:
  - X→Y_treatment is in the active set; X→Y_control is not.
  - All forecast population flows down the treatment edge.
  - The control edge sees zero (or effectively zero) population and forecast converters.
- If a different scenario S' splits traffic (for example, 50/50):
  - Both edges appear active.
  - Forecast population is split appropriately.

**Current implementation (gap):**
- The active‑edge helper currently considers only base probabilities and ignores scenario DSL / conditional probabilities.
- Inbound‑n **does** use scenario‑aware probabilities for the convolution itself, but the active set is still scenario‑agnostic, and path_t95 is computed without regard to scenario.

**Test outcome:** The test should require that, given a scenario where a branch’s weight is 0%, that branch **does not appear in the active set** and does not receive any forecast population. It should fail until the active‑edge and path_t95 pipelines are scenario‑aware.

---

### (Optional) Additional Design‑Driven Tests

Depending on how much guard‑rail we want before refactoring, we can also add:

- **T7. Graph‑level downstream completeness sanity check**  
  A two‑edge chain A→X→Y where:
  - Cumulative **anchor_median_lag** is modest compared to cohort ages.
  - The first edge is almost fully mature; the second is moderately mature.  
  The test would assert that:
  - Completeness at the first edge is very high.
  - Completeness at the second edge is lower but still substantial (for example, between roughly 0.6 and 0.9), **not** near zero.

- **T8. Recency weighting qualitative check**  
  Two groups of mature cohorts:
  - An older group (high n, older ages).
  - A newer group (moderate n, more recent ages) with a meaningfully different conversion rate.  
  The test would verify that:
  - The estimated long‑run probability p_infinity is **closer** to the newer group’s rate than a simple n‑weighted average would be, reflecting the exponential recency weighting (without hard‑coding exact constants).

These can be added once T1–T6 are in place, to strengthen confidence in end‑to‑end behaviour.

---

### How to Run Tests

```bash
cd graph-editor
npm test -- --run src/services/__tests__/lagStatsFlow.integration.test.ts
```

After adding new tests, we **expect failures** against the current implementation. Only once T1–T6 are passing should we consider Phase 1 fixes complete.

---

## Phase 1: Critical Calculation Fixes

### A1. Completeness uses `path_t95` instead of `anchor_median_lag`

**Problem:** Effective age for completeness is computed by subtracting `path_t95` (95th percentile upper bound) from cohort age. This is far too conservative — a downstream edge with path_t95 of 30 days will show 0% completeness for any cohort younger than 30 days, even if conversions are happening.

**Correct behaviour:** Use `anchor_median_lag_days` (the observed median lag from anchor A to the source of this edge) to compute effective age. This reflects the central tendency of how long it takes users to reach this edge.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/statisticalEnhancementService.ts` | In `computeEdgeLatencyStats()`: replace `pathT95` parameter with `anchorMedianLag`. Adjust cohort ages using `anchor_median_lag_days` instead of `path_t95`. |
| `graph-editor/src/services/statisticalEnhancementService.ts` | In `enhanceGraphLatencies()`: pass `anchorMedianLag` (from param file or aggregated cohort data) instead of `pathT95ToNode` to `computeEdgeLatencyStats()`. |
| `graph-editor/src/services/windowAggregationService.ts` | Ensure `aggregateCohortData()` extracts and returns `anchor_median_lag_days` from param values. |
| `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts` | Add/update tests verifying completeness uses anchor_median_lag, not path_t95. |

**Signature change:**
```
// BEFORE
computeEdgeLatencyStats(cohorts, aggregateMedianLag, aggregateMeanLag, legacy maturity threshold, pathT95)

// AFTER
computeEdgeLatencyStats(cohorts, aggregateMedianLag, aggregateMeanLag, legacy maturity threshold, anchorMedianLag)
```

---

### A2. `queryDateForLAG` capped to cohort window end

**Problem:** Cohort ages are calculated relative to the DSL cohort window end date, not today (the analysis date). This means a cohort that is actually 4 weeks old is treated as only 0–7 days old if the DSL window is 7 days, causing completeness to be artificially low.

**Correct behaviour:** Cohort ages should be calculated as `TODAY - cohort_entry_date`, where TODAY is the analysis date (when the user is viewing the graph), not the DSL window end.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/fetchDataService.ts` | Find `queryDateForLAG` assignment. Change from `cohortEnd ?? new Date()` to `new Date()`. |
| `graph-editor/src/services/windowAggregationService.ts` | Verify `aggregateCohortData()` receives the correct `queryDate` and computes ages correctly. |
| `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts` | Add test: a 4-week-old cohort with 7-day maturity edge should have ~100% completeness, not ~20%. |

---

### A3. Completeness aggregation formula

**Problem:** Logged completeness values are far below expected n-weighted CDF averages. A cohort 4 weeks old on a 7-day maturity edge should show ~100% completeness but shows ~36%.

**Correct behaviour:** Completeness = Σ(n_i × CDF(effective_age_i)) / Σ(n_i), where CDF is the log-normal CDF at the cohort's effective age.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/statisticalEnhancementService.ts` | Review `calculateCompleteness()`. Verify it implements n-weighted average of per-cohort CDFs. Check for off-by-one errors, wrong subset selection, or incorrect weighting. |
| `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts` | Add unit test: given known cohorts with known ages and a known lag distribution, verify completeness matches expected n-weighted CDF average. |

---

## Phase 2: Design Alignment

### B2. No `p_infinity` → `p.forecast.mean` fallback

**Problem:** If an edge has no window() slice providing `p.forecast.mean`, the blend formula is skipped entirely. LAG computes `p_infinity` from mature cohorts but this is never promoted to become the forecast baseline.

**Correct behaviour:** If `edge.p.forecast.mean` is undefined but `latencyStats.p_infinity` is available (and `forecast_available` is true), use `p_infinity` as the forecast baseline and the sum of mature-cohort n as `n_baseline`.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/statisticalEnhancementService.ts` | In `enhanceGraphLatencies()` blend block: if `forecastMean` is undefined but `latencyStats.p_infinity` is defined and `latencyStats.forecast_available`, use `p_infinity` as fallback forecast. |
| `graph-editor/src/services/statisticalEnhancementService.ts` | When using p_infinity fallback, set `n_baseline` from the mature cohorts that produced p_infinity (already partially implemented). |
| `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts` | Add test: edge with cohort data only (no window slice) should still produce blended p.mean using p_infinity. |

---

### C1. Wire `anchor_median_lag_days` through param files

**Problem:** Completeness calculation needs `anchor_median_lag_days` per cohort (the observed median lag from A to this edge's source). This data comes from Amplitude but may not be flowing through correctly.

**Correct behaviour:** Param files should store `anchor_median_lag_days[]` alongside `median_lag_days[]`. The aggregation pipeline should extract and use this for effective age calculation.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/windowAggregationService.ts` | In `aggregateCohortData()`: extract `anchor_median_lag_days` from param values and attach to CohortData. |
| `graph-editor/src/services/statisticalEnhancementService.ts` | Update `CohortData` interface to include `anchor_median_lag_days?: number`. |
| `graph-editor/src/services/statisticalEnhancementService.ts` | In `computeEdgeLatencyStats()`: use per-cohort `anchor_median_lag_days` for age adjustment if available, otherwise use aggregate `anchorMedianLag` parameter. |
| `graph-editor/src/types/index.ts` | If `CohortData` is defined here, add `anchor_median_lag_days` field. |

---

## Phase 3: Scenario Correctness

### B3. Active edges not scenario-aware for LAG/path_t95

**Problem:** `getActiveEdges()` only checks `edge.p.mean > epsilon`; it ignores `whatIfDSL`, `conditional_p`, and case allocations. This means disabled edges (via case weights or conditional branches) are still included in LAG calculations.

**Correct behaviour:** `getActiveEdges()` should use `computeEffectiveEdgeProbability()` to determine if an edge is active under the current scenario.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/statisticalEnhancementService.ts` | Update `getActiveEdges()` to accept `whatIfDSL` and optionally `graph` (full graph for case resolution). Use `computeEffectiveEdgeProbability()` instead of raw `edge.p.mean`. |
| `graph-editor/src/services/statisticalEnhancementService.ts` | Update all call sites of `getActiveEdges()` in `enhanceGraphLatencies()` and elsewhere to pass scenario context. |
| `graph-editor/src/services/fetchDataService.ts` | Update `computeAndApplyPathT95()` to pass `whatIfDSL` to `getActiveEdges()`. |
| `graph-editor/src/lib/whatIf.ts` | Ensure `computeEffectiveEdgeProbability()` is exported and handles all scenario edge cases. |

---

### B4. path_t95 not scenario-specific

**Problem:** `computeAndApplyPathT95()` is called once with base graph; result is shared across scenarios. But scenarios can disable edges (e.g. case variants with weight 0), which should affect path_t95.

**Correct behaviour:** path_t95 should be recomputed per scenario using the scenario-specific active edge set.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/fetchDataService.ts` | `computeAndApplyPathT95()` should accept `whatIfDSL` and pass it to `getActiveEdges()` / `computePathT95()`. |
| `graph-editor/src/services/statisticalEnhancementService.ts` | `computePathT95()` should accept scenario context and filter edges accordingly. |
| `graph-editor/src/services/fetchDataService.ts` | Ensure `computeAndApplyPathT95()` is called per-scenario if scenario-specific path_t95 is needed, or document that path_t95 uses baseline topology. |

---

## Phase 4: Recency Weighting

### C2. Recency weighting in p.forecast

**Problem:** Recency weighting (`RECENCY_HALF_LIFE_DAYS`) is implemented but may not be applied in the forecast/blend calculation. The schematic should document this.

**Correct behaviour:** When computing `p.forecast.mean` from window() data or when blending evidence with forecast, recent cohorts should be weighted more heavily using exponential decay with half-life = `RECENCY_HALF_LIFE_DAYS`.

**Files to update:**

| File | Changes |
|------|---------|
| `graph-editor/src/services/statisticalEnhancementService.ts` | Verify recency weighting is applied in `estimatePInfinity()` or wherever p.forecast.mean is derived from cohort data. |
| `graph-editor/src/services/windowAggregationService.ts` | Verify recency weighting is applied when aggregating window() data to produce forecast scalars. |
| `graph-editor/src/constants/statisticalConstants.ts` | Confirm `RECENCY_HALF_LIFE_DAYS` is defined and documented. |
| `docs/current/project-lag/stats-convolution-schematic.md` | Add section or note about recency weighting: formula, where applied, constant name. |
| `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts` | Add test: given cohorts with different ages, verify older cohorts are weighted less in p_infinity estimation. |

---

## Phase 5: Documentation Cleanup

### B1. μ fallback when k is low

**Problem:** Schematic says use `μ = ln(legacy maturity field / 2)` when k is low. Code uses `μ = ln(median_lag)` if median is valid.

**Resolution:** Update schematic to match code — using available median is more accurate.

**Files to update:**

| File | Changes |
|------|---------|
| `docs/current/project-lag/stats-convolution-schematic.md` | Section 3.2: change fallback description to match code behaviour. |

---

### B5. Schematic wording on scenario re-computation

**Problem:** §11.2 says "re-run path_t95 per scenario" but §11.3 says latency stats are scenario-independent. Inconsistent.

**Resolution:** After B4 fix, update §11.2 to be accurate about what is scenario-specific (path_t95, active edges) vs what is not (fit parameters, t95 per edge).

**Files to update:**

| File | Changes |
|------|---------|
| `docs/current/project-lag/stats-convolution-schematic.md` | Reconcile §11.2 and §11.3. Clarify that: (a) per-edge t95, median_lag, mean_lag are scenario-independent; (b) path_t95 and active edge set are scenario-dependent; (c) completeness uses scenario-independent per-edge lag but may vary if effective ages change with scenario. |

---

## Implementation Order

1. **Phase 1 (A1, A2, A3)** — Critical fixes. Do these first via TDD.
2. **Phase 2 (B2, C1)** — Enable forecast blending for all edges.
3. **Phase 3 (B3, B4)** — Scenario correctness.
4. **Phase 4 (C2)** — Verify and document recency weighting.
5. **Phase 5 (B1, B5)** — Doc cleanup.

---

## Test Strategy

For each fix:
1. Write failing test that encodes correct behaviour from schematic.
2. Run test to confirm it fails against current code.
3. Implement fix.
4. Run test to confirm it passes.
5. Run related tests to check for regressions.

Key test files:
- `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`
- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
- `graph-editor/src/services/__tests__/pathT95Computation.test.ts`

---

## Checklist

### Phase 0: Design-Driven Tests (ALL DONE 10-Dec-25)
- [x] T1: Test — completeness uses anchor_median_lag, not path_t95 — DONE
- [x] T2: Test — cohort ages relative to TODAY, not DSL window end — DONE
- [x] T3: Test — verify calculateCompleteness() formula (Scenario 6) — DONE
- [x] T4: Test — mature cohort with short-lag edge has ~100% completeness — DONE
- [x] T5: Test — p_infinity fallback when no window() slice — DONE
- [x] T6: Test — scenario-aware active edges — DONE

### Phase 1: Critical Fixes (ALL DONE 10-Dec-25)
- [x] A1: Completeness uses anchor_median_lag, not path_t95 — DONE
- [x] A2: queryDateForLAG = new Date() (analysis date) — DONE
- [x] A3: calculateCompleteness() formula verified (correct) — DONE

### Phase 2: Design Alignment (ALL DONE 10-Dec-25)
- [x] B2: p_infinity fallback for p.forecast.mean implemented — DONE
- [x] C1: anchor_median_lag_days wired through param files — DONE
- [x] C1b: Amplitude adapter extracts anchor lag at correct indices — DONE
- [x] C1c: E2E test: anchor lag flows from param file to stats output — DONE
- [x] C1d: Session logging for anchor lag in LAG_CALC_DETAIL — DONE

### Phase 3: Scenario Correctness (ALL DONE 10-Dec-25)
- [x] B3: getActiveEdges() scenario-aware — DONE
- [x] B4: path_t95 scenario-specific (via active edges) — DONE

### Phase 4: Recency Weighting (DONE 10-Dec-25)
- [x] C2: Recency weighting verified in code — DONE (already implemented correctly)

### Phase 5: Documentation (DONE 10-Dec-25)
- [x] B1: Schematic §3.2 updated (μ fallback) — DONE
- [x] B5: Schematic §11.2/11.3/11.8 reconciled — DONE
- [x] C2 (doc): Recency weighting section 7.1 added to schematic — DONE

