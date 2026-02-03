# Onset Integration: Implementation Plan

Date: 3-Feb-26

**Parent design document:** `1-onset.md`

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

### 1.1 Completed (tracking/storage working)

| Component | Status | Location |
|-----------|--------|----------|
| Onset derivation (α-mass threshold) | ✅ | `windowAggregationService.ts` |
| Incremental merge (weighted average) | ✅ | `windowAggregationService.ts` |
| Edge-level aggregation (weighted β-quantile) | ✅ | `statisticalEnhancementService.ts` lines ~2465-2475 |
| Settings knobs (alpha, beta) | ✅ | `forecastingSettingsService.ts` |
| Test coverage (merge + topo aggregation) | ✅ | `lagStatsFlow.integration.test.ts` |

### 1.2 Not Yet Implemented (core stats integration)

| Component | Status | Location |
|-----------|--------|----------|
| Shifted completeness in CDF evaluation | ❌ | `statisticalEnhancementService.ts` |
| Shifted fit (model-space conversion) | ❌ | `lagDistributionUtils.ts` / `statisticalEnhancementService.ts` |
| Tail-constraint in X-space | ❌ | `statisticalEnhancementService.ts` |
| FW path horizons with onset shift | ❌ | `statisticalEnhancementService.ts`, `dataOperationsService.ts` |

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

What “completed” means here:

- All “spec tests” for shifted completeness, inclusive horizons, and tail constraint safety exist in the relevant suites.
- Tests may initially fail locally (“red”) while implementing, but we do not proceed to later phases until the tests for the current phase are written and passing (“green”).
- No reliance on `it.todo(...)` as the primary safety mechanism. If a scenario is critical, it should become an active assertion in the same phase it is implemented.

### 4.1 Immediate fixes required (before onset work)

| File | Issue | Fix |
|------|-------|-----|
| `paramPackCsvRunner.csvDriven.tool.test.ts` line ~464 | `fitLagDistribution(bcLag[i], bcMeanLag[i])` missing `totalK` | Add 3rd argument |
| `cohortEvidenceDebiasing.e2e.test.ts` line ~265 | `fitLagDistribution(5, 6)` missing `totalK` | Add 3rd argument |

These tests currently bypass the quality gate because `totalK` defaults to a passing value. They must be corrected to reflect production semantics.

### 4.2 Test file assignments

| Test File | Scenarios to Add/Enable |
|-----------|-------------------------|
| `onset_shifted_completeness.test.ts` | Un-todo dead-time clamp, boundary, shift equivalence, monotonicity tests |
| `statisticalEnhancementService.test.ts` | Tail constraint safety under onset; blend weight = 0 during dead-time |
| `lagStatsFlow.integration.test.ts` | Inclusive horizon persistence; stored t95 increases by δ when onset increases |
| `lagHorizonsService.integration.test.ts` | Path horizon consistency with onset (FW + shift) |
| `dataOperations.integration.test.ts` | Cohort bounding horizon consistency with onset (end-to-end) |
| `dataOperationsService.integration.test.ts` | Moment-matched `path_t95` estimate includes onset when available |
| `cohortHorizonIntegration.test.ts` | Cohort window bounding uses inclusive horizons and remains monotone/safe |
| `cohortRetrievalHorizon.test.ts` | Bounding logic never widens user window; trimming logic stable under larger horizons |
| `fetchRefetchPolicy.test.ts` | Refetch policy remains monotone when horizons increase due to onset |
| `windowFetchPlannerService.test.ts` | Planning remains stable with larger horizons; no pathological over-fetch |

---

## 5. Implementation Order

### Phase 0: Tests-first (pre-requisite)

This phase is explicit and must be done before any behavioural onset changes:

- Fix the `fitLagDistribution` test hygiene issues (2-arg calls).
- Add/enable shifted-onset tests in existing suites (see §6) as active assertions as soon as the relevant code exists.
- Add coverage that proves “no unshifted completeness remains” across both:
  - the topo pass (`statisticalEnhancementService.ts`), and
  - the cohort bounding horizon estimate path (`dataOperationsService.ts`).

### Phase 1: Core Conversion Helper
1. Implement `toModelSpace()` in `lagDistributionUtils.ts`
2. Add unit tests for `toModelSpace()` (guard rails, ε handling) in an existing maths-focused suite (prefer `lagDistribution.golden.test.ts`).

### Phase 2: Completeness Functions
1. Update `calculateCompleteness` signature + logic
2. Update `calculateCompletenessWithTailConstraint` signature + logic
3. Update `getCompletenessCdfParams` to handle t95 in X-space
4. Enable shifted completeness tests in `onset_shifted_completeness.test.ts`

### Phase 3: `computeEdgeLatencyStats`
1. Add `onsetDeltaDays` parameter
2. Apply `toModelSpace()` before fit
3. Apply onset shift to tail constraint
4. Convert returned `t95` back to T-space
5. Pass onset to completeness functions
6. Add integration tests for edge stats with onset

### Phase 4: Topo Pass Integration
1. Thread `edgeOnsetDeltaDays` into `computeEdgeLatencyStats` call
2. Update A→Y completeness block with onset
3. Update `path_t95` computation with onset shift
4. Add integration tests for full topo pass with onset

### Phase 5: Secondary Paths
1. Update `dataOperationsService.ts` cohort bounding
2. Review `lagMixtureAggregationService.ts` for onset handling
3. Add integration tests

### Phase 6: Cleanup & Verification
1. Audit all `logNormalCDF` calls for "forgotten shift"
2. Run full LAG test suite
3. Manual verification with known-onset test fixtures

---

## 6. Test Scenarios (Detailed)

### 6.1 Unit: `toModelSpace()` helper

| Scenario | Input | Expected Output |
|----------|-------|-----------------|
| Zero onset | `(0, 5, 6, 15, 10)` | `(5, 6, 15, 10)` — no change |
| Positive onset | `(2, 5, 6, 15, 10)` | `(3, 4, 13, 8)` — all shifted |
| Onset = median | `(5, 5, 6, 15, 10)` | `(ε, 1, 10, 5)` — guard rail on median |
| Onset > median | `(7, 5, 6, 15, 10)` | `(ε, ε, 8, 3)` — guard rail on both |
| Age < onset | `(5, 5, 6, 15, 3)` | `ageX = 0` (clamped, not negative) |

### 6.2 Unit: Shifted completeness

| Scenario | Cohort Age | Onset | Expected |
|----------|------------|-------|----------|
| Dead-time clamp | 3 | 5 | 0 |
| Boundary (age = onset) | 5 | 5 | 0 |
| Shifted equivalence | 10 | 3 | `CDF(7, μ, σ)` |
| Monotonicity | 10 | 0→5 | Completeness decreases |

### 6.3 Integration: Tail constraint under onset

| Scenario | Setup | Expected |
|----------|-------|----------|
| Constraint in X-space | `onset=3, t95_T=20` | Sigma-min computed from `t95_X=17` |
| One-way safety | `onset>0, constraint increases σ` | Completeness ≤ unconstrained |
| Degenerate (onset ≥ t95) | `onset=25, t95_T=20` | `t95_X=ε`, conservative sigma, finite completeness |

### 6.4 Integration: Path horizons

| Scenario | Setup | Expected |
|----------|-------|----------|
| Edge t95 inclusive | `onset=3, fit implies t95_X=12` | Stored `t95=15` |
| Path t95 inclusive | `anchor t95=10, edge onset=3, edge t95_X=8` | `path_t95 ≥ 10+3+8 = 21` (FW may differ slightly) |
| Cohort bounding consistency | Same edge in topo vs data-ops | Same inclusive horizon |

### 6.5 Integration: Blend during dead-time

| Scenario | Setup | Expected |
|----------|-------|----------|
| All cohorts in dead-time | `max(cohort.age) < onset` | `completeness ≈ 0`, blend favours forecast |
| Mixed ages | Some cohorts in dead-time, some past | Appropriate weighted blend |

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
| Breaking existing behaviour | Run full test suite after each phase |

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

Before marking onset integration complete:

- [ ] All tests in `onset_shifted_completeness.test.ts` enabled and passing
- [ ] Tail constraint tests with onset in `statisticalEnhancementService.test.ts` passing
- [ ] `lagStatsFlow.integration.test.ts` onset scenarios passing
- [ ] Cohort bounding horizon estimate is onset-inclusive and consistent with topo `path_t95` (`dataOperations.integration.test.ts` and/or `dataOperationsService.integration.test.ts`)
- [ ] Cohort retrieval horizon never widens user window; trimming remains monotone under larger horizons (`cohortRetrievalHorizon.test.ts`, `cohortHorizonIntegration.test.ts`)
- [ ] Refetch policy and fetch planning remain stable/monotone under larger horizons (`fetchRefetchPolicy.test.ts`, `windowFetchPlannerService.test.ts`)
- [ ] Manual verification: known-onset fixture produces expected completeness curve
- [ ] Audit confirms no unshifted `logNormalCDF` calls remain for maturity/completeness
- [ ] Code review confirms `toModelSpace()` is the sole user→model conversion path
