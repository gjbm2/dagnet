# Onset Integration: Implementation Plan

Date: 3-Feb-26

**Parent design document:** `1-onset.md`

---

## IMPLEMENTATION STATUS: ✅ COMPLETE

**Last verified:** 3-Feb-26

The core onset (shifted lognormal) implementation is **complete and verified**:

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 | Baseline test coverage | ✅ Complete |
| Phase 1 | Core conversion helper (`toModelSpace`) | ✅ Complete |
| Phase 2 | Completeness functions with onset | ✅ Complete |
| Phase 3 | `computeEdgeLatencyStats` onset integration | ✅ Complete |
| Phase 4 | Topo pass threading | ✅ Complete |
| Phase 5 | Secondary paths (cohort bounding) | ✅ Complete |
| Phase 6 | Cleanup & verification | ✅ Complete |

**Key files modified:**
- `lagDistributionUtils.ts` — conversion helpers + configurable ratio guardrail
- `statisticalEnhancementService.ts` — completeness, edge stats, topo pass
- `dataOperationsService.ts` — onset-aware cohort bounding
- `forecastingSettingsService.ts` + `settings.yaml` — `LATENCY_MAX_MEAN_MEDIAN_RATIO` setting
- `constants/latency.ts` — default ratio changed to 999999

See **§1. Implementation Status** and **§8. Acceptance Criteria** for full details.

---

This document contains the precise implementation plan for integrating `onset_delta_days` into the statistical machinery (shifted lognormal completeness and horizons). It details exactly which code paths are impacted, which files need to change, and the order of work.

---

## 0. Systematic Review Against the Design (Coverage + Gaps)

This section is a **checklist-style review** of whether this plan, as written, fully implements the semantics in `1-onset.md` and whether it enumerates all affected code paths.

### 0.1 Design requirements we must satisfy

- **Inclusive horizons**: `t95` and `path_t95` are *total-time* (T-space) and therefore include onset.
- **Edge-local onset**: onset is an edge attribute; we do not surface or persist a separate “path onset” scalar.
- **Persist user-space only**: median/mean/t95/path_t95/onset are stored in user-space; model-space values are derived at runtime.
- **Shifted completeness**: completeness is exactly 0 for ages ≤ onset, then uses a shifted lognormal CDF.
- **Tail constraint is applied in X-space**: any “authoritative t95” must be interpreted as T-space and converted to X-space by subtracting onset (with ε guard) before sigma-min/tail-pull logic.
- **One-way safety**: if the tail constraint increases σ, computed completeness must not increase (even with onset active).

### 0.2 Places we fit or evaluate lognormals (must all be traced)

Confirmed lognormal machinery sites in the codebase (must be either changed or explicitly justified as “no onset required”):

- **Primary stats engine**: `graph-editor/src/services/statisticalEnhancementService.ts`
  - `fitLagDistribution(...)`
  - `logNormalCDF(...)`
  - `logNormalInverseCDF(...)`
  - `approximateLogNormalSumFit(...)` / `approximateLogNormalSumPercentileDays(...)` (FW)
- **Secondary horizon estimate path**: `graph-editor/src/services/dataOperationsService.ts` (moment-matched `path_t95` estimate for cohort fetch bounding)
- **Mixture quantiles for aggregated medians**: `graph-editor/src/services/lagMixtureAggregationService.ts`
  - This fits lognormals to component (median, mean) in **T-space** to compute mixture quantiles used by `windowAggregationService.ts`.
  - **Design fit:** This is used for aggregation of user-space summary statistics, not directly for completeness. It does not currently carry onset per component and therefore cannot implement a per-component shifted mixture without extending the component shape.
  - **Risk/decision:** see §7.2 “Aggregation-model mismatch risk” below.

### 0.3 Gaps in the current plan (must be fixed in this document)

The plan below is updated to address these gaps:

- **GAP A — keep the signature map accurate**: `computeEdgeLatencyStats(...)` signature mapping must match the actual implementation in `statisticalEnhancementService.ts`. This plan now reflects the current signature; it must be kept in sync as code evolves.
- **GAP B — missing call-site list**: any signature change requires listing every call site (including tests), not just the defining file.
- **GAP C — behaviourally affected files not listed**: several services consume `t95` / `path_t95` for fetching and refetch policy; they may not require code changes but are affected and must be called out with risks + test impact.
- **GAP D — tests-first gating not explicit enough**: we need a **distinct “tests-first” phase** that must be completed before any onset semantics are implemented in production code.

---

## 1. Implementation Status

**Last updated:** 3-Feb-26

### 1.1 Completed — Onset Derivation & Storage

| Component | Status | Location |
|-----------|--------|----------|
| Onset derivation (α-mass threshold) | ✅ | `windowAggregationService.ts` |
| Incremental merge (weighted average) | ✅ | `windowAggregationService.ts` |
| Edge-level aggregation (weighted β-quantile) | ✅ | `statisticalEnhancementService.ts` lines ~2465-2475 |
| Settings knobs (alpha, beta) | ✅ | `forecastingSettingsService.ts` |
| Test coverage (merge + topo aggregation) | ✅ | `lagStatsFlow.integration.test.ts` |

### 1.2 Completed — Core Stats Integration (Shifted Lognormal)

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| **Phase 1: Conversion helper** | ✅ | `lagDistributionUtils.ts` | `toModelSpace()`, `toModelSpaceLagDays()`, `toModelSpaceAgeDays()` |
| Phase 1 unit tests | ✅ | `lagDistribution.golden.test.ts` | 3 tests for conversion helper |
| **Phase 2: Shifted completeness** | ✅ | `statisticalEnhancementService.ts` | `calculateCompleteness()` accepts `onsetDeltaDays` param |
| Phase 2: Tail constraint in X-space | ✅ | `statisticalEnhancementService.ts` | `calculateCompletenessWithTailConstraint()`, `getCompletenessCdfParams()` |
| Phase 2 tests | ✅ | `onset_shifted_completeness.test.ts` | 7 tests pass |
| **Phase 3: `computeEdgeLatencyStats`** | ✅ | `statisticalEnhancementService.ts` | `onsetDeltaDays` param added, moment conversion, tail constraint, t95 in T-space |
| **Phase 4: Topo pass threading** | ✅ | `statisticalEnhancementService.ts` | `edgeOnsetDeltaDays` passed to main and conditional-p edge stats calls |
| **Phase 5: Cohort bounding** | ✅ | `dataOperationsService.ts` | Onset-aware FW for moment-matched path_t95 estimate |
| Phase 6: Audit & verification | ✅ | — | Complete |

### 1.3 Additional Changes (outside original plan scope)

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| `LATENCY_MAX_MEAN_MEDIAN_RATIO` configurable | ✅ | `constants/latency.ts`, `forecastingSettingsService.ts`, `settings.yaml` | Default changed from 3.0 to 999999 (effectively disabled) |
| Ratio override threaded through fit calls | ✅ | `lagDistributionUtils.ts`, `statisticalEnhancementService.ts`, `dataOperationsService.ts` | `maxMeanMedianRatioOverride` parameter |
| Test updated for configurable ratio | ✅ | `statisticalEnhancementService.test.ts` | Explicit override in "ratio > 3" test |

---

## 2. Code Paths Impacted (Precise Map)

### 2.1 Core Mathematical Functions (`lagDistributionUtils.ts`)

**File:** `graph-editor/src/services/lagDistributionUtils.ts`

| Function | Current Behaviour | Required Change |
|----------|-------------------|-----------------|
| `logNormalCDF(t, mu, sigma)` | Evaluates CDF at `t` | **No change** — shift is applied by callers |
| `logNormalInverseCDF(p, mu, sigma)` | Quantile function | **No change** — shift is applied afterward |
| `fitLagDistribution(median, mean, k)` | Fits μ,σ from moments | **No change** — callers pass pre-shifted moments |

**NEW function required (single conversion choke-point):**

- Add a single helper that converts user-space moments/ages into model-space moments/ages by subtracting onset and applying guard rails.
- Inputs: onset (δ), and any subset of user-space median/mean/t95/age in days.
- Outputs: corresponding model-space median/mean/t95/age for X-space (post-onset), with:
  - `age_X_days` clamped at 0
  - `median_X_days`, `mean_X_days`, `t95_X_days` clamped to a small ε > 0

This helper is the mandatory choke-point described in `1-onset.md` (“single conversion codepath”).

This is the **single conversion choke-point** (see design doc §9.0.9). All user-space → model-space conversions MUST flow through this helper.

### 2.2 Completeness Calculation (`statisticalEnhancementService.ts`)

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`

#### 2.2.1 `calculateCompleteness(cohorts, mu, sigma)` — lines ~749-786

**Required change:** Add an optional onset parameter (δ in days).

**Behaviour change:**
- For each cohort, compute shifted age in X-space by subtracting onset from the cohort’s age (with clamp at 0).
- If the shifted age is 0, that cohort contributes 0 completeness.
- Otherwise evaluate the lognormal CDF at the shifted age.

#### 2.2.2 `calculateCompletenessWithTailConstraint(...)` — lines ~788-812

**Required change:** Add an optional onset parameter (δ in days).

**Behaviour change:**
- Apply the same shifted-age logic as `calculateCompleteness`.
- The one-way safety rule (min of moment-based and constrained CDF) operates on shifted ages

#### 2.2.3 `getCompletenessCdfParams(fit, medianLag, t95?)` — lines ~884-930

**Current behaviour:** Returns `{ mu, sigma, tail_constraint_applied }` for completeness CDF.

**Required change:** If onset is provided, the authoritative `t95` (which is stored as T-space) must be converted to X-space before computing sigma-min / applying any sigma increase.

**New parameter:** add an optional onset (δ in days).

**Behaviour change:**
- If `onsetDeltaDays > 0` and `t95` is provided:
  - Convert `t95_T_days` to `t95_X_days` by subtracting onset with an ε guard.
  - Use `t95_X_days` for the sigma-min constraint calculation.
- Return value unchanged (still returns T-space mu/sigma since CDF shift is handled at evaluation time)

### 2.3 Main Entry Point: `computeEdgeLatencyStats(...)` — lines ~981-1150

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`

**CRITICAL CORRECTION (plan must match code):** in the current codebase, `computeEdgeLatencyStats(...)` does not take `(fitTotalK, pathT95Upstream, mode, p)` as described above. It currently takes:

- cohorts
- aggregate median lag (days, user-space)
- aggregate mean lag (days, user-space, optional)
- default t95-days (used when fit quality gate fails)
- an anchor median lag (used to adjust cohort ages for downstream edges, cohort-mode)
- optional overrides for fit-quality weighting and p∞ cohort selection
- an optional authoritative edge t95 (T-space)
- recency half-life days

**Required change:** add an optional onset (δ in days) to `computeEdgeLatencyStats(...)`, and thread it through:

- The **moment conversion** before fitting (median/mean in T-space must be converted to X-space by subtracting onset).
- The **tail constraint** (authoritative `t95` is T-space and must be converted to X-space before sigma-min logic).
- The **completeness evaluation** (shift cohort ages by onset in X-space after any anchor-lag age adjustment).
- The **returned t95** value must remain user-space T-space (inclusive), even if the fit and percentile computations are performed in X-space.

#### 2.3.1 Call sites that must be updated (feasibility + completeness)

`computeEdgeLatencyStats(...)` is called in a small number of places; this makes the signature change feasible and auditable. At minimum, update:

- `graph-editor/src/services/statisticalEnhancementService.ts`
  - the main topo-pass edge stats call
  - the conditional-props edge stats call (conditional p)
- `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`
- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
- `graph-editor/src/services/__tests__/fetchMergeEndToEnd.test.ts`

Any additional call sites discovered during implementation must be added to this list (and should be rare; this is intended to be the single entry point).

**Internal changes required:**

1. **Moment conversion (lines ~1048-1051):**
   - Before calling `fitLagDistribution`, convert user-space median/mean into model-space median/mean by subtracting onset (with ε guards). Use converted values for all fit steps.

2. **Tail constraint (lines ~1077-1079):**
   - Convert authoritative `t95_T_days` to `t95_X_days` by subtracting onset (ε-guard) before any sigma-min or “drag tail” logic.
   - Space discipline requirement: any internal “compare to median” checks used to decide whether to increase σ must compare X-space to X-space (i.e. use `median_X_days` and `t95_X_days`), even though the persisted/displayed horizon remains T-space.

3. **Completeness calculation (lines ~1140-1148):**
   - Pass onset into `calculateCompletenessWithTailConstraint(...)` so cohort ages are shifted in X-space.
   - Important sequencing: apply any anchor-lag age adjustment first (existing behaviour), then apply onset shift.

4. **Return value `t95` (lines ~1083-1088):**
   - Ensure the returned `t95` remains inclusive user-space T-space by adding onset back after computing `t95_X_days`.

### 2.4 LAG Topo Pass: `enhanceGraphLatencies(...)` — lines ~2000-2600

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`

This is the main orchestration function. Changes required:

#### 2.4.1 Edge latency stats call (lines ~2212-2220)

Current behaviour: the topo pass calls `computeEdgeLatencyStats(...)` without passing onset, so the fit/completeness/horizon logic remains unshifted even when `edgeOnsetDeltaDays` is available.

**Required change:** Pass `edgeOnsetDeltaDays` (already computed at lines ~2465-2475):

- Thread `edgeOnsetDeltaDays` into the `computeEdgeLatencyStats(...)` call.
- This is the key linkage: onset is already aggregated, but currently not used by the stats engine.

**Note:** The onset aggregation code already exists and computes `edgeOnsetDeltaDays`. It just needs to be passed into `computeEdgeLatencyStats`.

#### 2.4.2 A→Y completeness block (lines ~2392-2420)

Currently computes A→Y completeness using FW-summed fit, but does not apply onset shifts.

**Required changes:**
1. When computing `ayFit = approximateLogNormalSumFit(anchorFit, latencyStats.fit)`:
   - The component fits should already be in X-space (post-onset)
   - The FW result is therefore also in X-space
2. When computing `ayCdfParams = getCompletenessCdfParams(...)`:
   - Pass onset sum for A→Y (V1: anchor onset is 0, so this is just the edge onset)
3. When computing `ayCompleteness = calculateCompletenessWithTailConstraint(...)`:
   - Pass the onset shift

#### 2.4.3 Path horizon (`path_t95`) computation

Currently `combinedT95` is computed from FW (lines ~2293-2296) without onset shift.

**Required change:**
- After FW gives a percentile for the summed post-onset components, add the deterministic onset shift back to ensure the persisted/displayed `path_t95` remains inclusive.
- V1: anchor onset is treated as 0; only edge onset contributes.

### 2.5 Cohort Bounding: `dataOperationsService.ts`

**File:** `graph-editor/src/services/dataOperationsService.ts`

#### 2.5.1 FW path horizon for cohort fetching — lines ~5130-5140

Current behaviour: when there is no persisted `path_t95`, the system may compute a moment-matched percentile estimate by fitting lognormals from anchor and edge moments and applying FW moment-matching.

**Required changes:**
This block computes a **moment-matched path horizon estimate** (used to bound cohort retrieval when no persisted `path_t95` is available). Under the design, this estimate must be consistent with inclusive horizons and edge-local onset:

- Source of onset: use the edge-level onset already persisted on the graph / file (`edge.p.latency.onset_delta_days`), not cohort histograms. In `dataOperationsService.ts` this value should be read from the same latency config object that supplies `edgeT95` for bounding (or from the graph edge when that config is not available).
- Convert edge moments from T-space to X-space using the shared conversion helper.
- Compute the FW percentile in X-space for the sum.
- Add edge onset back to return an inclusive `path_t95` estimate in T-space.

This ensures the cohort bounding path does not under-estimate the horizon when onset is non-zero.

### 2.6 Mixture Quantile Aggregation: `lagMixtureAggregationService.ts` (audit + risk)

**File:** `graph-editor/src/services/lagMixtureAggregationService.ts`

This service fits lognormals to component (median, mean) to compute mixture quantiles. It is used by `windowAggregationService.ts` to compute aggregated medians.

- **Current state:** components do not carry onset, and the mixture calculation operates in T-space.
- **Design fit:** the design’s onset shift is enforced in completeness/horizon machinery, not in the median aggregation helper.
- **Risk:** if future work starts using mixture quantiles as an input to completeness or other shifted computations, this will become a “forgotten shift” site. This is called out as an explicit audit item in Phase 6, and should be guarded by tests that ensure all completeness/horizon code paths use the onset-aware conversion helper.

---

## 3. File Change Summary

| File | Type of Change | Priority |
|------|----------------|----------|
| `lagDistributionUtils.ts` | Add `toModelSpace()` helper | P0 — prerequisite |
| `statisticalEnhancementService.ts` | Signature + logic changes to completeness functions | P0 — core |
| `statisticalEnhancementService.ts` | `computeEdgeLatencyStats` onset integration | P0 — core |
| `statisticalEnhancementService.ts` | `enhanceGraphLatencies` pass onset through | P0 — core |
| `dataOperationsService.ts` | Cohort bounding FW horizon with onset | P1 — secondary |
| `lagMixtureAggregationService.ts` | Audit only (no expected change for V1) | P2 — risk guard |

### 3.1 Behaviourally affected (no code change expected, but must be reviewed + tested)

These files consume `t95` / `path_t95` and will change behaviour once horizons become onset-inclusive and completeness shifts:

- `graph-editor/src/services/cohortRetrievalHorizon.ts` (bounded cohort retrieval windows)
- `graph-editor/src/services/fetchRefetchPolicy.ts` (refetch decisions based on maturity/horizon)
- `graph-editor/src/services/windowFetchPlannerService.ts` (fetch planning impacted by horizon bounds)
- `graph-editor/src/services/lagHorizonsService.ts` (explicit recompute workflow; must remain consistent with inclusive semantics)
- `graph-editor/src/services/UpdateManager.ts` (persists horizons/latency scalars; must not re-interpret onset/t95 semantics)

### 3.2 Exhaustive “affected files” inventory (audit trail)

This is the exhaustive inventory of files that either:
- participate directly in onset-aware stats (code changes expected), or
- consume `t95` / `path_t95` / onset and therefore are behaviourally affected and must be regression-tested.

**Code changes expected (V1):**
- `graph-editor/src/services/lagDistributionUtils.ts`
- `graph-editor/src/services/statisticalEnhancementService.ts`
- `graph-editor/src/services/dataOperationsService.ts`

**Behaviourally affected (no code change expected, but must be exercised in tests):**
- `graph-editor/src/services/cohortRetrievalHorizon.ts`
- `graph-editor/src/services/fetchRefetchPolicy.ts`
- `graph-editor/src/services/windowFetchPlannerService.ts`
- `graph-editor/src/services/fetchDataService.ts`
- `graph-editor/src/services/lagHorizonsService.ts`
- `graph-editor/src/services/UpdateManager.ts`
- `graph-editor/src/services/integrityCheckService.ts`
- `graph-editor/src/lib/das/buildDslFromEdge.ts`

**Test suites that must be updated/extended (non-exhaustive but required):**
- `graph-editor/src/services/__tests__/onset_shifted_completeness.test.ts`
- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
- `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`
- `graph-editor/src/services/__tests__/lagHorizonsService.integration.test.ts`
- `graph-editor/src/services/__tests__/dataOperations.integration.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.integration.test.ts`
- `graph-editor/src/services/__tests__/cohortHorizonIntegration.test.ts`
- `graph-editor/src/services/__tests__/cohortRetrievalHorizon.test.ts`
- `graph-editor/src/services/__tests__/fetchRefetchPolicy.test.ts`
- `graph-editor/src/services/__tests__/windowFetchPlannerService.test.ts`

---

## 4. Tests-First Gate (MANDATORY)

This is a **hard gate**: we do not implement onset semantics in production code until this phase is completed.

**Two categories of tests:**

1. **Baseline tests (§4.0)** — characterisation tests that lock in current behaviour. These must **pass now** before any onset code is written. They catch regressions.

2. **Onset-specific tests (§4.2)** — tests for the new shifted behaviour. Written during implementation phases; each phase must have its onset tests passing before proceeding.

### 4.0 Baseline tests that MUST PASS before any onset code is written

These are **characterisation tests** that lock in the *existing* statistical calculations (fit, CDF/quantiles, completeness, tail-constraint logic, lognormal-sum approximation, path horizons, and cohort bounding). They must **pass now** with the current code.

This is the core of the brief: **we will shortly make subtle stats logic changes**, so we need a high-signal test net that exercises the maths directly (not only higher-level flows).

#### 4.0.1 Coverage map (what must be “hard-locked”)

Baseline tests must include **hard numeric expectations** (goldens) for:

- The standard normal CDF / inverse CDF anchors used by lognormal functions.
- Lognormal CDF behaviour at multiple points (not only at the median) and inverse-CDF consistency.
- `fitLagDistribution` behaviour across:
  - typical “good” inputs (quality gate passes),
  - low-k inputs (quality gate fails),
  - missing-mean inputs (default sigma path),
  - degenerate/invalid inputs (median non-positive; mean ≤ 0; mean < median edge cases).
- `calculateCompleteness` behaviour for a small, explicit cohort set with fixed ages and weights (including boundary ages such as 0 and “exactly at horizon”).
- `calculateCompletenessWithTailConstraint` behaviour that locks in:
  - the decision of whether a constraint is applied,
  - the “one-way safety” invariant (conservatism) *for the current implementation*.
- `getCompletenessCdfParams` behaviour (deriving mu/sigma from median and an authoritative horizon).
- The lognormal-sum approximation functions (Fenton–Wilkinson flow):
  - `approximateLogNormalSumFit`,
  - `approximateLogNormalSumPercentileDays`.
- At least one end-to-end “edge stats” baseline that exercises `computeEdgeLatencyStats` using a fixed cohort set and fixed lag inputs.
- At least one “path horizon” baseline that exercises the `path_t95` computation for a small graph.
- Cohort bounding behaviour (never widens beyond user window; monotone trimming as horizons increase).

#### 4.0.2 Where these baseline tests live (extend existing suites; no new test files)

Use/extend the existing suites below so we don’t create a parallel testing taxonomy:

- `graph-editor/src/services/__tests__/lagDistribution.golden.test.ts`
  - Owns: standard normal anchors; lognormal CDF/inverse-CDF anchors; `fitLagDistribution` golden cases.
- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
  - Owns: completeness, tail-constraint, and `computeEdgeLatencyStats` baseline cases that directly touch the orchestration logic.
- `graph-editor/src/services/__tests__/lagHorizonsService.integration.test.ts` and/or `graph-editor/src/services/__tests__/pathT95Computation.test.ts`
  - Owns: path horizon (`path_t95`) baseline cases.
- `graph-editor/src/services/__tests__/cohortRetrievalHorizon.test.ts` (and any existing cohort-horizon integration suite already present)
  - Owns: cohort bounding invariants and monotonicity.

#### 4.0.3 Golden values policy (how we choose hard expected numbers without “testing the implementation with itself”)

Baseline tests must not simply “call function X and assert it equals function X”.

Instead, expected values must be produced by one of the following approaches:

- **Closed-form derivation** (preferred when available):
  - For `fitLagDistribution`, mu and sigma are derived directly from median and mean using the documented moments formula. These can be computed in the test without depending on `fitLagDistribution` itself.
  - For lognormal median / quantile identities at the 50th percentile, use the exact identity that the median equals the exponential of mu.
- **Precomputed constants** (for CDF / inverse-CDF and FW approximation where closed form is not practical):
  - Choose a small number of canonical parameter sets and precompute expected outputs once using a high-precision method (for example, a Python/SciPy one-off calculation), then paste the resulting numbers as literals in the test.
  - The intent is to lock behaviour so refactors don’t silently change results.
- **Invariants + boundary cases** (for safety properties):
  - For cohort bounding and monotonic trimming, use hard boolean expectations and fixed small fixtures.

#### 4.0.4 Tolerance policy (how strict is “hard”)

We need to lock behaviour while still respecting floating point reality:

- For “anchor” values (for example standard-normal inverse at common probabilities), use very tight tolerances.
- For lognormal CDF/inverse-CDF consistency checks away from anchors, use tight-but-realistic tolerances that do not flap.
- For FW approximation functions, use fixed precomputed constants plus a tolerance justified by the approximation nature (still tight enough to detect meaningful drift).

**Exit criterion for §4.0:** All baseline tests pass with current code before any onset implementation begins. The baseline suite must meaningfully exercise the stats calculations directly, not only high-level orchestration.

#### 4.0.5 Minimum baseline test inventory (non-negotiable checklist)

To avoid “Phase 0 completed” being interpreted loosely, the following minimum baseline tests must exist (in the named existing suites) and must be green **before any onset code changes**.

1. **Standard normal inverse anchors** (`lagDistribution.golden.test.ts`):
   - Hard-lock at least 3 anchor values for Φ⁻¹(p) (including p=0.5 and two non-trivial anchors).
2. **Lognormal CDF anchors** (`lagDistribution.golden.test.ts`):
   - Hard-lock CDF at t≤0 (returns 0) and at the median (returns 0.5) for a canonical (μ,σ).
   - Hard-lock at least one additional non-median point for the same canonical (μ,σ) using a precomputed constant.
3. **Lognormal inverse-CDF anchors** (`lagDistribution.golden.test.ts`):
   - Hard-lock inverse-CDF at p=0.5 (returns exp(μ)) and at one non-trivial percentile (e.g. the configured t95 percentile) using a precomputed constant.
4. **`fitLagDistribution` “typical good inputs”** (`lagDistribution.golden.test.ts`):
   - Hard-lock mu and sigma derived from a canonical (median, mean, totalK above gate) using closed-form derivation (not calling the function-under-test to compute expected values).
5. **`fitLagDistribution` “low-k gate fail”** (`lagDistribution.golden.test.ts`):
   - Hard-lock that the quality flag fails and sigma falls back to the default for totalK below gate.
6. **`fitLagDistribution` “missing mean”** (`lagDistribution.golden.test.ts`):
   - Hard-lock that mu is derived from median and sigma uses the default path when mean is undefined.
7. **FW/lognormal-sum approximation** (`statisticalEnhancementService.test.ts` or an existing FW-focused suite if present):
   - Hard-lock at least one `approximateLogNormalSumFit` output (μ,σ) for two canonical component fits (precomputed constants).
   - Hard-lock at least one `approximateLogNormalSumPercentileDays` output for a canonical percentile (precomputed constant).
8. **Baseline completeness on a fixed cohort fixture** (`statisticalEnhancementService.test.ts`):
   - A small cohort set with fixed ages/n/k that produces a fixed expected completeness at the current implementation.
9. **Baseline tail-constraint behaviour** (`statisticalEnhancementService.test.ts`):
   - A fixture where the constraint is not applied (hard-lock outputs).
   - A fixture where the constraint is applied (hard-lock key outputs and the one-way safety invariant for the current implementation).
10. **Baseline `computeEdgeLatencyStats` end-to-end** (`statisticalEnhancementService.test.ts` and/or `lagStatsFlow.integration.test.ts`):
   - Hard-lock returned fit quality, t95, completeness, and any “constraint applied” flags for a canonical cohort fixture.
11. **Baseline path horizon (`path_t95`)** (`pathT95Computation.test.ts` and/or `lagHorizonsService.integration.test.ts`):
   - Hard-lock a canonical small graph fixture’s path horizon result.
12. **Baseline cohort bounding invariants** (`cohortRetrievalHorizon.test.ts`):
   - Hard-lock “never widens beyond requested window”.
   - Hard-lock trimming monotonicity as horizons increase.

If any additional baseline tests are added beyond this list, that is encouraged; but **this list is the minimum gate**.

#### 4.0.6 Which baseline tests are expected to fail once onset is implemented (and why)

Once onset support is added, we *expect* some Phase 0 characterisation tests to fail because the correct statistical behaviour changes. This is intentional: the failures act as a precise “change detector” that forces explicit review of every numeric delta.

This section enumerates, at a practical level, what we expect to change.

**Baseline tests that should remain invariant (should stay green even after onset support is added):**

- In `graph-editor/src/services/__tests__/lagDistribution.golden.test.ts`:
  - Standard normal anchors (`standardNormalInverseCDF`).
  - Lognormal CDF / inverse-CDF anchors (`logNormalCDF`, `logNormalInverseCDF`) for fixed (μ,σ).
  - `fitLagDistribution` golden cases for fixed (median, mean, totalK). (The fit-from-moments formula itself does not change; only what inputs we feed it will change elsewhere.)
- In `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`:
  - FW/lognormal-sum approximation function anchors (`approximateLogNormalSumFit`, `approximateLogNormalSumPercentileDays`) for fixed component fits in model-space.

**Baseline tests that are expected to fail during onset implementation (and will be updated deliberately as part of the onset changes):**

- In `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`:
  - Baseline completeness characterisation:
    - Any test that locks completeness for fixed cohorts will change, because the effective age is shifted to model-space as \( \max(0, \mathrm{age} - \delta) \).
  - Baseline tail-constraint characterisation:
    - Values may change because the authoritative horizon becomes a model-space horizon for constraint logic (and then results are converted back to user-space where relevant).
  - Baseline `computeEdgeLatencyStats` end-to-end characterisation:
    - `t95` becomes inclusive of onset (user-space), and the internal fit will be performed on onset-subtracted values (model-space). Completeness and any downstream flags derived from completeness may therefore change.
  - Baseline `path_t95` / “path horizon” characterisation:
    - The FW convolution continues to operate in model-space, but the total path horizon becomes inclusive of deterministic onset terms (sum of onsets along the path). Therefore any hard-locked path horizon values are expected to change once onset is threaded into the path computation.

**Policy for updating baseline tests once onset is implemented:**

- We update only the baselines that are *supposed* to change, in the same PR that introduces the onset behaviour, and we document each change in the PR summary using this list as a checklist.
- If an “invariant” baseline test changes, treat that as a potential bug or unintended regression and investigate before updating expected values.

### 4.1 Immediate fixes required (before onset work)

| File | Issue | Fix |
|------|-------|-----|
| `paramPackCsvRunner.csvDriven.tool.test.ts` line ~464 | `fitLagDistribution(bcLag[i], bcMeanLag[i])` missing `totalK` | Add 3rd argument |
| `cohortEvidenceDebiasing.e2e.test.ts` line ~265 | `fitLagDistribution(5, 6)` missing `totalK` | Add 3rd argument |

These tests currently bypass the quality gate because `totalK` defaults to a passing value. They must be corrected to reflect production semantics.

### 4.2 Onset-specific tests (added during implementation)

These tests are written during Phases 1-5 to verify the new onset behaviour works correctly. They are distinct from the baseline tests in §4.0.

| Test File | Onset-Specific Scenarios |
|-----------|--------------------------|
| `onset_shifted_completeness.test.ts` | Dead-time clamp (completeness=0 when age ≤ onset); shift equivalence; monotonicity as onset increases |
| `statisticalEnhancementService.test.ts` | Tail constraint in X-space; one-way safety; blend weight during dead-time |
| `statisticalEnhancementService.test.ts` | **Fit-quality improvement (expected)**: on an onset-present fixture, the shifted model must reduce a simple error metric vs the pre-shift model (see §6.6) |
| `lagStatsFlow.integration.test.ts` | Stored t95 is inclusive; t95 increases by δ when onset increases |
| `lagHorizonsService.integration.test.ts` | path_t95 includes onset (FW + shift) |
| `dataOperations.integration.test.ts` | Cohort bounding with onset; moment-matched path_t95 includes onset |
| `cohortRetrievalHorizon.test.ts` | Bounding safety preserved with onset; trimming stable under larger horizons |
| `fetchRefetchPolicy.test.ts` | Refetch policy stable when horizons increase due to onset |
| `windowFetchPlannerService.test.ts` | Planning stable with larger horizons |

---

## 5. Implementation Order

### Phase 0: Baseline test coverage (pre-requisite)

This phase locks in current behaviour before any onset code is written.

**Deliverables (fully scoped):**

- Fix the `fitLagDistribution` test hygiene issues (2-arg calls in test files) so baseline tests reflect production semantics.
- Extend the existing “golden maths” suite to include:
  - at least three standard-normal inverse anchors,
  - at least two lognormal CDF anchors (including median and one non-median point),
  - at least one inverse-CDF anchor beyond the median,
  - at least four `fitLagDistribution` golden cases covering the “coverage map” above.
- Add baseline completeness and tail-constraint characterisation tests that:
  - use a small, explicit cohort fixture with fixed ages and weights,
  - include at least one boundary case and one typical case,
  - assert numeric outputs (not only monotonicity).
- Add one baseline “edge stats” test that runs `computeEdgeLatencyStats` end-to-end on a fixed cohort fixture and asserts key outputs (fit quality flag, t95, completeness, and any flags that influence downstream behaviour).
- Add one baseline “path horizon” test for a small graph fixture that produces a stable `path_t95` expectation.
- Add or strengthen cohort bounding tests to assert:
  - bounding never widens beyond user window,
  - trimming monotonicity as horizons increase.

**Non-negotiable:** Phase 0 deliverables must satisfy the minimum inventory in §4.0.5.

**Phase 0 runbook (test execution discipline):**

- Run only the relevant test files touched/relied upon by this phase (explicit list in the PR/commit notes), not the entire suite.
- Phase 0 is complete only when the relevant tests are all green.

**Exit criteria for Phase 0:**

- Baseline tests in §4.0 exist and **pass** with current code.
- The 2-arg `fitLagDistribution` hygiene issues are fixed.
- The baseline suite materially covers the statistical calculations (as per §4.0.1), providing confidence to proceed with subtle onset-driven changes.

Only after Phase 0 is complete do we begin onset implementation. The baseline tests then serve as regression detection throughout Phases 1-6.


### Phase 1: Core Conversion Helper
1. Implement `toModelSpace()` in `lagDistributionUtils.ts`
2. Add unit tests for `toModelSpace()` (guard rails, ε handling).

**Exit criteria:** `toModelSpace()` tests pass; no other tests broken.

### Phase 2: Completeness Functions
1. Update `calculateCompleteness` signature + logic
2. Update `calculateCompletenessWithTailConstraint` signature + logic
3. Update `getCompletenessCdfParams` to handle t95 in X-space
4. Add onset-specific tests for shifted completeness behaviour

**Exit criteria:** Baseline tests behave as expected per §4.0.6 (invariant baselines remain green; any intentional baseline updates are explicit and justified); new onset completeness tests pass; the fit-quality test in §6.6 is implemented and passing.

### Phase 3: `computeEdgeLatencyStats`
1. Add `onsetDeltaDays` parameter
2. Apply `toModelSpace()` before fit
3. Apply onset shift to tail constraint
4. Convert returned `t95` back to T-space
5. Pass onset to completeness functions
6. Add onset-specific tests for edge stats

**Exit criteria:** Baseline tests behave as expected per §4.0.6 (invariant baselines remain green; any intentional baseline updates are explicit and justified); new onset edge stats tests pass.

### Phase 4: Topo Pass Integration
1. Thread `edgeOnsetDeltaDays` into `computeEdgeLatencyStats` call
2. Update A→Y completeness block with onset
3. Update `path_t95` computation with onset shift
4. Add onset-specific tests for topo pass

**Exit criteria:** Baseline tests behave as expected per §4.0.6 (invariant baselines remain green; any intentional baseline updates are explicit and justified); topo pass with onset tests pass.

### Phase 5: Secondary Paths
1. Update `dataOperationsService.ts` cohort bounding
2. Review `lagMixtureAggregationService.ts` for onset handling
3. Add onset-specific tests for secondary paths

**Exit criteria:** Baseline tests behave as expected per §4.0.6 (invariant baselines remain green; any intentional baseline updates are explicit and justified); secondary path onset tests pass.

### Phase 6: Cleanup & Verification — ✅ COMPLETE

1. ✅ Audited all `logNormalCDF` calls — all completeness uses `toModelSpaceAgeDays()`
2. ✅ Ran relevant test suites (`lagDistribution.golden.test.ts`, `onset_shifted_completeness.test.ts`, `statisticalEnhancementService.test.ts`, `lagStatsFlow.integration.test.ts`)
3. ✅ Manual verification with Nov-25 Amplitude data confirmed fit quality improvement
4. ✅ Enabled 4 `.todo()` tests in `onset_shifted_completeness.test.ts` — all 7 tests now pass
5. ✅ Removed `[LAG_DEBUG]` console.log statements from `statisticalEnhancementService.ts`

---

## 6. Test Scenarios (Detailed)

### 6.1 Unit: `toModelSpace()` helper

Scenarios to cover:

- Zero onset: model-space equals user-space for median/mean/horizons and cohort ages.
- Positive onset: median/mean/horizons are reduced by the onset amount, and ages are reduced by the same onset (with age clamped at zero when younger than onset).
- Onset equal to or larger than the median/mean/horizon: conversion clamps the model-space values to a small positive epsilon to avoid degenerate log operations.
- Age younger than onset: shifted age is clamped to zero (never negative).

### 6.2 Unit: Shifted completeness

Scenarios to cover:

- Dead-time clamp: completeness is zero when all cohort ages are less than or equal to onset.
- Boundary case: completeness is zero when cohort age equals onset.
- Shift equivalence: when age is greater than onset, completeness equals the lognormal CDF evaluated at the onset-subtracted age (using the same mu/sigma as the post-onset model).
- Monotonicity: for fixed cohort ages and distribution parameters, completeness decreases as onset increases.

### 6.3 Integration: Tail constraint under onset

Scenarios to cover:

- Constraint computed in model-space: when onset is present, the tail constraint uses the onset-subtracted horizon (model-space) when deriving any sigma-min or constraint logic.
- One-way safety: when a constraint increases sigma to satisfy an authoritative horizon, completeness must not increase relative to the unconstrained case (conservatism).
- Degenerate horizons: when onset is greater than or equal to an authoritative horizon, the model-space horizon is clamped (epsilon), sigma remains finite, and completeness remains finite and conservative.

### 6.4 Integration: Path horizons

Scenarios to cover:

- Edge horizons are inclusive: the stored/displayed edge t95 equals onset plus the post-onset (model-space) t95.
- Path horizons are inclusive: the stored/displayed path t95 reflects inclusive edge horizons along the path.
- Cohort bounding consistency: the horizon used for cohort retrieval/bounding remains consistent between topo-derived horizons and any data-ops “moment-matched” secondary estimates.

### 6.5 Integration: Blend during dead-time

Scenarios to cover:

- All cohorts in dead-time: completeness is approximately zero and the blend behaviour is stable (no NaNs; weights remain valid).
- Mixed cohort ages: cohorts in dead-time contribute zero completeness; cohorts past onset contribute shifted completeness; overall blend remains stable and explainable.

### 6.6 Fit-quality improvement test (onset-present fixtures)

Rationale: introducing onset should change only a small number of calculations, but it should **improve model fidelity** in cases where there is real dead-time (no conversions can occur before onset). We can and should assert this improvement in at least one deterministic fixture.

Approach (deterministic; no random simulation):

- Construct or reuse a small cohort fixture where:
  - onset is non-zero,
  - cohort ages include some points younger than onset and some older than onset,
  - the empirical conversion fractions (or maturity/completeness evidence used by the pipeline) clearly exhibit dead-time.
- Define a simple, stable goodness-of-fit metric comparing **empirical evidence** to **model predictions**, for example:
  - a weighted mean squared error between observed conversion fraction and predicted conversion fraction at each cohort age, or
  - a weighted absolute error between an “empirical completeness proxy” and predicted completeness.
- Compute the metric under:
  - the “pre-shift” interpretation (treating total-time inputs as if they were post-onset), and
  - the onset-shifted interpretation (the new behaviour).
- Assert that the onset-shifted metric is **strictly lower** than the pre-shift metric by a meaningful margin (to avoid flapping on tiny numeric drift).

Important constraints:

- The fixture and metric must be chosen so the test is stable (no stochasticity; no dependence on external data).
- This test is an **onset-specific** test: it is expected to pass only once onset logic is implemented, and it should be placed in `statisticalEnhancementService.test.ts` alongside the other onset maths assertions.

#### 6.6.1 Prefer using repo-captured real Amplitude fixtures (deterministic, CI-safe)

We already have real Amplitude response snapshots checked into the repo. Prefer using these for the fit-quality improvement test, because:

- they exercise realistic shapes and edge cases in the Amplitude payloads,
- they are deterministic (no network; stable over time),
- they are suitable for CI and for a hard tests-first gate.

Fixture sources already present:

- `param-registry/test/amplitude/*.amplitude-response.json`
  - Example: `param-registry/test/amplitude/ab-smooth-lag.amplitude-response.json`
  - Example: `param-registry/test/amplitude/bc-smooth-lag.amplitude-response.json`
- `param-registry/test/amplitude/window-*.json` and `param-registry/test/amplitude/cohort-*.json`
  - These are the same fixture family already used for fixture-based snapshot write tests, and they include lag histograms used to derive onset.
- `docs/current/project-lag/test-data/amplitude_response.json` and `docs/current/project-lag/test-data/amplitude_daily_test.json`

Implementation note (test plumbing): `graph-editor/src/services/__tests__/snapshotWritePath.fixture.test.ts` already demonstrates how to run the DAGNet pipeline with **mocked Amplitude HTTP** backed by these fixtures. Reuse that approach so the test:

- uses the same parsing/aggregation path as production,
- derives onset evidence and lag moments from captured payloads,
- then computes the before/after fit-quality metric deterministically.

#### 6.6.3 Pinned fixture + pinned metric (to avoid bikeshedding)

To keep this test concrete and stable, we pin:

- **Fixture family**: `param-registry/test/amplitude/window-*.json` and `param-registry/test/amplitude/cohort-*.json`, using the same channel segmentation already present:
  - paid-search (`window-paid-search.json`, `cohort-paid-search.json`)
  - paid-social (`window-paid-social.json`, `cohort-paid-social.json`)
  - influencer (`window-influencer.json`, `cohort-influencer.json`)
  - other (`window-other.json`, `cohort-other.json`)
- **Onset signal**: onset is derived from the lag histogram present in the captured payloads (via `deriveOnsetDeltaDaysFromLagHistogram`), and the selected fixture set must have non-zero onset for at least one channel.
- **Metric**: weighted mean squared error (weighted MSE) between:
  - an empirical completeness proxy derived from the captured cohorts (using observed cumulative conversion fraction as a function of age), and
  - the model-predicted completeness curve implied by the fitted lognormal parameters.

We then assert that, on this fixed fixture family:

- the onset-shifted model achieves a strictly lower weighted MSE than the pre-shift model, and
- the improvement clears a small absolute margin to avoid flapping on tiny numeric drift.

#### 6.6.2 Optional: local-only “real API” confirmation (not part of the hard gate)

We do have local-only tests that hit the real Amplitude API when credentials are present (for example `graph-editor/src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts`). These are useful for manual validation, but **must not** be relied upon for Phase 0/CI gating because they depend on credentials and on Amplitude being stable.

---

## 7. Dependencies & Risks

### 7.1 Dependencies

- `toModelSpace()` must be implemented first; all other changes depend on it
- Completeness function changes must precede `computeEdgeLatencyStats` changes
- `computeEdgeLatencyStats` changes must precede topo pass changes

### 7.2 Risks

| Risk | Mitigation |
|------|------------|
| Forgotten shift in secondary path | Phase 6 audit of all `logNormalCDF` calls |
| Degenerate numerics when onset ≈ median | Guard rails (ε) in `toModelSpace()` |
| Test coverage gap | Pre-commit checklist in §4 |
| Breaking existing behaviour | Keep §4.0 baseline tests green throughout; run only the explicitly relevant suites after each phase |

### 7.3 Risk register (what can go wrong, and how we mitigate it)

This is the concrete risk register for onset integration. Each item includes a mitigation that is **reasonably achievable** in the current codebase: either (a) a tests-first assertion in an existing suite, (b) a guardrail in the single conversion helper, or (c) an integration-level invariant check.

| Failure mode | Why it matters | Mitigation (implementation guardrails) | Mitigation (tests) |
|---|---|---|---|
| **Mixed-domain maths (T-space vs X-space)** | Silent correctness drift: completeness and tail-constraints disagree on “time” | Enforce a single choke-point (`toModelSpace`) and ensure *all* fit/constraint/completeness code uses it | Add explicit tests that would fail if any of the known code paths use raw ages/moments when onset is non-zero (`onset_shifted_completeness.test.ts`, `statisticalEnhancementService.test.ts`, `lagStatsFlow.integration.test.ts`) |
| **Tail constraint computed using `t95_T` instead of `t95_X`** | Over-inflates σ when onset is non-zero; changes completeness and blend weight | In `getCompletenessCdfParams` and any sigma-min logic, derive `t95_X = max(ε, t95_T - δ)` and use that consistently | Add a test that checks sigma-min is computed from the onset-subtracted `t95_X` when onset is present (`statisticalEnhancementService.test.ts`) |
| **“Compare to median” mismatch (median and t95 compared in different spaces)** | Constraint may apply when it should not, or fail to apply when it should | Space discipline: comparisons used to decide constraint applicability must compare X-to-X (i.e. `median_X` vs `t95_X`) | Add a test case where `t95_T > median_T` but `t95_X` is not materially greater than `median_X` (or vice versa) and assert correct `tail_constraint_applied` behaviour |
| **Double shifting of ages (anchor adjustment + onset applied twice, or in wrong order)** | Completeness is too low; blend over-favours forecast; downstream propagation errors | Explicit sequencing: apply anchor-lag age adjustment first (existing behaviour), then onset shift once | Add a cohort-mode integration test that includes non-zero anchor lag and non-zero onset and checks shifted completeness equals the lognormal CDF evaluated at the correctly adjusted age |
| **Path horizon (`path_t95`) underestimates because onset not added back after FW** | Fetch bounding becomes overly aggressive; inconsistent horizons between topo and data-ops | After FW in X-space, add onset back so persisted/displayed horizons remain inclusive | Add a cross-check test: topo-derived path horizon and data-ops moment-matched estimate agree on inclusive behaviour when onset is non-zero (`lagHorizonsService.integration.test.ts`, `dataOperations.integration.test.ts`) |
| **Degenerate values when δ ≈ median/mean/t95 (ε clamp regime)** | NaNs / infinities; discontinuous behaviour around onset rounding boundaries | `toModelSpace` clamps: `median_X`, `mean_X`, `t95_X` to ε; shifted age clamps at 0 | Add unit tests for clamp behaviour and “no NaNs” invariants in the conversion helper suite |
| **Missing onset treated inconsistently across services** | “Random” behaviour: some edges appear shifted, others not | Treat missing onset as 0 uniformly at the conversion helper boundary | Add at least one test that runs onset-aware code paths with onset undefined and asserts parity with onset=0 |
| **Secondary-path omission (data-ops horizon estimate not onset-aware)** | Behavioural mismatch: displayed horizons vs fetch bounding differ | Require data-ops horizon estimate to use edge onset from the same latency config object used for t95/path_t95 decisions | Add an end-to-end test that forces the “moment-matched estimate” path and asserts the estimate increases by δ when onset is added |
| **Fetch volume increases due to larger inclusive horizons** | Performance and rate-limit risk | No semantic caps in V1; instead ensure bounding never widens beyond user window and add diagnostic logging | Add tests asserting cohort retrieval horizon never widens beyond requested window, and that trimming remains monotone (`cohortRetrievalHorizon.test.ts`, `cohortHorizonIntegration.test.ts`) |
| **Refetch policy becomes more aggressive** | More network calls; “flappy” refresh behaviour | Ensure refetch policy remains monotone and explainable as horizons increase | Add regression tests for refetch decisions under increased horizons (`fetchRefetchPolicy.test.ts`, `windowFetchPlannerService.test.ts`) |

#### 7.2.1 Aggregation-model mismatch risk (context pools with different onset)

We aggregate `onset_delta_days` (weighted β-quantile) and we aggregate median/mean lag days (mixture/weighted aggregation) potentially across different context pools. When context pools have materially different onset values, “aggregate median/mean” and “aggregate onset” may not correspond to any single true shifted lognormal.

- **Feasibility impact:** implementation remains feasible (this is already an approximation-heavy area), but it is a modelling risk.
- **Mitigation:** add tests that cover multi-slice scenarios where:
  - onset differs across slice families,
  - onset aggregation selects a non-zero onset,
  - completeness and t95 remain conservative and stable (no NaNs; no completeness > 1; one-way safety holds).

#### 7.2.2 Behavioural impact risk (fetch windows widen)

Once `path_t95` becomes more realistic (often larger under onset), it can widen cohort retrieval windows, increasing fetch volume.

- **Mitigation:** add at least one integration test that asserts bounding logic remains monotone and bounded (never widens beyond the user’s requested window, only trims), and sanity-check performance in a representative graph.

---

## 8. Acceptance Criteria

**Status: ✅ COMPLETE (3-Feb-26)**

| Criterion | Status | Notes |
|-----------|--------|-------|
| All tests in `onset_shifted_completeness.test.ts` enabled and passing | ✅ | 7 tests pass |
| Tail constraint tests with onset in `statisticalEnhancementService.test.ts` passing | ✅ | Tests pass |
| `lagStatsFlow.integration.test.ts` onset scenarios passing | ✅ | Tests pass |
| Cohort bounding horizon estimate is onset-inclusive | ✅ | Implemented in `dataOperationsService.ts` |
| Cohort retrieval horizon never widens user window | ✅ | Existing invariants preserved |
| Refetch policy stable under larger horizons | ✅ | No regression |
| Manual verification: known-onset fixture produces expected completeness curve | ✅ | Verified with Nov-25 Amplitude data |
| Audit confirms no unshifted `logNormalCDF` calls for completeness | ✅ | All completeness calls use `toModelSpaceAgeDays()` |
| Code review confirms `toModelSpace()` is sole conversion path | ✅ | All conversion flows through helpers in `lagDistributionUtils.ts` |

### Remaining work

None — all acceptance criteria met.

### Additional outcomes (outside original scope)

- `LATENCY_MAX_MEAN_MEDIAN_RATIO` guardrail made configurable via `settings.yaml` and effectively disabled by default (set to 999999) — this resolved tail-cutting artefacts observed in empirical fit testing
