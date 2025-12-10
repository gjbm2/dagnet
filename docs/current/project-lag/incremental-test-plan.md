# Project LAG – Incremental Test Plan

**Created:** 10-Dec-25  
**Status:** Proposal for post-Alpha work  
**Reference:** `graph-editor/public/docs/lag-statistics-reference.md`

This plan extends the existing LAG test suite to more completely cover the behaviour described in the LAG Statistics Reference. It is designed to be incremental: each phase can be implemented and landed independently.

The plan is prose-only by design. It describes *what* to test and *where*, not specific code or assertions.

**Priority for Alpha v1.0:**
- Core LAG tests (T1–T6) are complete and passing
- Phase A (Scenario / conditional_p) is the highest priority for post-Alpha
- Phases B–E can be scheduled based on risk assessment

---

## 1. Current Coverage – Section-by-Section Summary

This section maps the schematic to the current tests and rates indicative coverage.

### §1 Graph Structure (Mixed Latency / Non-Latency Paths)

**Existing coverage**
- `statisticalEnhancementService.test.ts`: uses small graphs for `computeInboundN`, including simple chains and small branching structures.
- `pathT95Computation.test.ts`: covers linear paths, fan-in (multiple paths converging), non-latency edges in the path, and anchor handling.
- `lagStatsFlow.integration.test.ts`: includes single-edge and simple multi-edge graphs to exercise the full LAG pass.

**Assessment**
- Coverage is **good** for small linear and simple branching topologies.
- There is **limited coverage** for more complex mixed graphs (e.g. multiple latency branches re-merging, or deeper chains with both latency and non-latency segments).

**Implication**
- The core invariants for “mixed latency / non-latency” paths are covered, but more realistic multi-branch graphs would strengthen confidence.

### §2 Amplitude Funnel Construction (A→X vs A→X→Y)

**Existing coverage**
- `amplitudeThreeStepFunnel.integration.test.ts`:
  - 2-step X→Y query: validates `n`, `k`, daily series, and latency extraction for X→Y.
  - 3-step A→X→Y query: validates anchor n, local n/k, median and mean lags, and ensures `anchor_median_lag_days` and `median_lag_days` are extracted at correct indices.
  - Semantic check that `anchor_median_lag_days` is larger than the local `median_lag_days` for downstream edges.

**Assessment**
- Coverage is **strong** for:
  - 2-step X→Y funnels.
  - 3-step A→X→Y funnels in cohort mode, including anchor lag extraction.
- There is **no coverage** yet for deeper “A→X→Y→Z” style funnels at the DAS level (those are implicitly covered later via param files, not directly at the adapter level).

**Implication**
- Adapter behaviour is well-covered for the reference 3-step funnel, but additional shapes (e.g. different anchor locations or more steps) could be added later if needed.

### §3 Lag Distribution Fitting

**Existing coverage**
- `statisticalEnhancementService.test.ts`:
  - Detailed tests for `fitLagDistribution`, including:
    - Valid median with sufficient `k` (empirical fit).
    - Valid median but low `k` (quality gate fails; fallback to `maturity_days` for t95).
    - Missing or invalid median.
    - Mean/median ratio bounds (too low, too high, near-1).
  - Tests for `computeT95` fallback behaviour.

**Assessment**
- Coverage is **strong**:
  - All three main cases in §3 are exercised.
  - Quality gates and fallbacks are explicitly tested.

**Implication**
- Lag fitting behaviour is well constrained; no additional tests are strictly required, though integration-style sanity checks (e.g. t95 behaviour vs real param data) might be added later as non-critical enhancements.

### §4 Effective Age Calculation (Per Cohort)

**Existing coverage**
- `lagStatsFlow.integration.test.ts`:
  - Phase 0 T1/T2 and subsequent scenarios:
    - T1: First-latency-edge completeness for mature cohorts (no anchor lag subtraction).
    - T2: Cohort ages relative to analysis date (not DSL window end).
  - Scenario-based tests where completeness responds correctly to cohort ages and lag medians.
- `lagStatsFlow.integration.test.ts` (C1 e2e suite):
  - Verifies per-cohort `anchor_median_lag_days` flow from param values to `CohortData` and into effective-age adjustments.
  - Confirms that downstream effective ages are reduced by anchor lag, and that missing anchor lag falls back correctly.

**Assessment**
- Coverage is **good** for:
  - First vs downstream edges.
  - Use of anchor lag arrays and slice-level summaries.
  - Age relative to analysis date.
- There is **limited explicit coverage** of:
  - Mixed paths where some downstream cohorts lack anchor lag while others have it (partially covered via C1, but not exhaustively).

**Implication**
- The main design invariants are protected; a small number of targeted tests could tighten edge cases around partial anchor lag coverage.

### §5 Completeness Calculation

**Existing coverage**
- `statisticalEnhancementService.test.ts`:
  - Unit tests for `calculateCompleteness`, including:
    - Bounds (0 ≤ completeness ≤ 1).
    - Monotonic behaviour vs age.
    - Weighting by cohort `n`.
  - Property-style tests (CDF bounds, monotonicity).
- `lagStatsFlow.integration.test.ts`:
  - Scenario 6: completeness aggregation matches explicit n-weighted CDF average.
  - Scenarios for mature vs fresh cohorts on single edges.

**Assessment**
- Coverage is **strong**:
  - Both unit-level and integration-level invariants are tested.
  - The schematic formula is explicitly encoded in tests.

**Implication**
- Completeness is well covered; no substantial additions needed beyond any new edge cases discovered later.

### §6 Inbound-N Convolution (p.n Flow)

**Existing coverage**
- `statisticalEnhancementService.test.ts`:
  - Tests for `computeInboundN` and `applyInboundNToGraph`:
    - Anchor edges: `p.n = evidence.n`.
    - Single-path propagation: `p.n` as inbound `p.forecast.k`.
    - Multiple parents / fan-in: `p.n` as sum over inbound `p.forecast.k`.
    - Scenario callback usage for effective probabilities in inbound-n.
- `lagStatsFlow.integration.test.ts`:
  - End-to-end scenarios using `enhanceGraphLatencies` followed by inbound-n, asserting consistent `p.n` and `p.forecast.k` for simple graphs.

**Assessment**
- Coverage is **good** for:
  - Anchor edge rule.
  - Fan-in patterns and linear chains.
  - Interaction with scenario-aware effective probabilities (at least at unit level).
- There is **limited coverage** for:
  - Complex DAGs with multiple overlapping branches and mixed latency/non-latency segments.
  - Interplay of inbound-n and conditional case allocations at scale (currently only small synthetic cases).

**Implication**
- Core convolution rules are well tested; more realistic “business-shaped” graphs would strengthen confidence but are not immediately critical.

### §7 Blend Formula (p.mean from Evidence + Forecast) and Recency Weighting

**Existing coverage**
- `statisticalEnhancementService.test.ts`:
  - Forecast blending tests:
    - High-completeness case (blended mean closer to evidence).
    - Low-completeness case (blended mean closer to forecast), now with explicit window slice providing `n_baseline`.
    - No-blend cases for missing evidence or forecast.
  - `estimatePInfinity` tests:
    - Recency weighting behaviour (older cohorts down-weighted).
    - Boundary cases with no mature cohorts or zero `n`.
- `lagStatsFlow.integration.test.ts`:
  - T5: p∞ fallback when no window() slice is available (design-driven test for the forecast fallback path).

**Assessment**
- Coverage is **good**:
  - The algebraic formula is well exercised.
  - Recency weighting logic has targeted unit tests.
- There is **no explicit end-to-end test** where:
  - Two different mature-horizon periods yield different `p.forecast.mean` due purely to recency weighting.

**Implication**
- The blend mechanics are covered, but a recency-focused integration test would make the impact of `RECENCY_HALF_LIFE_DAYS` more observable.

### §8 End-to-End Flow Summary

**Existing coverage**
- `lagStatsFlow.integration.test.ts`:
  - Multiple scenarios from cohort slices → LAG stats → blended p.mean.
  - C1 anchor lag e2e coverage.
  - Scenario-structured LAG invariants (Phase 0).
- `cohortHorizonIntegration.test.ts` and `cohortRetrievalHorizon.test.ts`:
  - Path_t95 → retrieval horizon behaviour.
- `amplitudeThreeStepFunnel.integration.test.ts`:
  - Full DAS pipeline from Amplitude response → time series → param values.

**Assessment**
- Coverage is **strong** at the “service-level” and “DAS-level” integration boundaries.
- There is **no single test** that links:
  - Realistic DAS data → param files → full LAG + inbound-n + blend in a single flow.

**Implication**
- We have strong overlapping integration tests, but not yet a true end-to-end “golden path” that spans all layers.

### §9 Role of path_t95

**Existing coverage**
- `pathT95Computation.test.ts`: detailed behaviour of `computePathT95`, `applyPathT95ToGraph`, and active-edge filtering.
- `cohortRetrievalHorizon.test.ts` and `cohortHorizonIntegration.test.ts`: use `path_t95` to bound cohort windows and exercise fallback chains and edge cases.

**Assessment**
- Coverage is **strong**:
  - All intended uses (retrieval horizons, not completeness) are exercised.
  - Edge cases (missing t95, very large/small values, mixed latency) are covered.

**Implication**
- `path_t95` is well constrained in its intended role.

### §10 Key Quantities and DSL Paths

**Existing coverage**
- Indirectly covered via:
  - LAG stats flow tests (which rely on `p.mean`, `p.evidence.*`, `p.forecast.*`, `p.latency.*` fields being set correctly).
  - Inbound-n tests (which exercise `p.n` and `p.forecast.k`).
  - Session logging is visually inspected via `tmp.log`, but not asserted in tests.

**Assessment**
- Semantic correctness of quantities is covered implicitly.
- There is **no specific test** that compares an “expected DSL snapshot” of an edge’s properties to the actual computed values.
- Session log fields (e.g. `LAG_CALC_DETAIL`) are **not validated by tests**.

**Implication**
- The risk is mostly around logging and DSL presentation drift; core computation is already guarded by other tests.

### §11 Scenarios & What-If (conditional_p, case allocations)

**Existing coverage**
- `statisticalEnhancementService.test.ts`:
  - Scenario tests for `computeInboundN` using effective probability callbacks.
- `lagStatsFlow.integration.test.ts`:
  - Phase 3 tests for `getActiveEdges` basic behaviour (no scenario, zero probabilities, epsilon).
- `what-ifs-with-conditionals.md` (design doc, not tests).

**Assessment**
- Coverage is **weak / partial**:
  - There are no full integration tests where:
    - A scenario DSL with case allocations or conditional branches is applied.
    - Active edges change.
    - Inbound-n and path_t95 are recomputed per scenario.
    - Scenario-specific `p.mean(S)` is observed in param packs.

**Implication**
- Scenario behaviour is the least tested area relative to the schematic’s detailed description.

---

## 2. Incremental Test Plan

This section proposes additional tests to close the most important gaps. Each sub-section describes *where* to add tests and *what they should assert* in prose.

The order is chosen to maximise confidence for the least implementation effort.

### Phase A – Scenario and conditional_p Coverage (High Priority)

**Goal:** Align tests with §11 of the schematic: scenario-aware active edges, inbound-n, path_t95, and conditional probabilities.

1. **Scenario-aware active edge set and path_t95 (service level)**  
   - Location: `statisticalEnhancementService.test.ts` (new describe block) and/or `lagStatsFlow.integration.test.ts`.  
   - Scenario:  
     - Graph with a branch that is disabled in scenario S (e.g. case allocations or explicit “off” condition) and enabled in scenario S′.  
     - Use a simple diamond topology with two alternative paths and a single downstream merge.  
   - Tests should verify, for each scenario:  
     - `getActiveEdges` includes only edges with non-zero effective probability under the scenario DSL.  
     - `computePathT95` ignores inactive edges and produces different `path_t95` for the same edge between S and S′.  
     - Inbound-n convolution routes all population down the active branch in S and splits it appropriately in S′.

2. **Scenario-specific p.mean and p.n in param packs (integration level)**  
   - Location: `lagStatsFlow.integration.test.ts` (new “Scenario” suite).  
   - Scenario:  
     - Small graph with a case node where one branch is “treatment” and another “control”, with different `p.mean`.  
     - Scenario S: 100% treatment; Scenario S′: split control/treatment.  
   - Tests should verify:  
     - Scenario S param pack shows `p.mean(S)` for the treatment edge equal to the case-specific value, with `p.n` equal to full inbound population.  
     - Scenario S′ shows both edges active, each with `p.n` equal to the allocated population.  
     - Downstream edges have different `p.n` and `p.mean(S)` between S and S′.

3. **conditional_p interaction with convolution**  
   - Location: `statisticalEnhancementService.test.ts` or a new small integration test file.  
   - Scenario:  
     - Single edge with base `p.mean` and `conditional_p` entries for two cases.  
     - In scenario S, case A active; in scenario S′, case B active.  
   - Tests should verify:  
     - Effective `p.mean` used in convolution matches the selected `conditional_p` entry.  
     - Inbound-n and downstream `p.forecast.k` change accordingly between scenarios.

### Phase B – Recency Weighting End-to-End (Medium Priority)

**Goal:** Make the impact of `RECENCY_HALF_LIFE_DAYS` observable at the service level, beyond unit tests.

1. **Two-bucket p∞ comparison**  
   - Location: `lagStatsFlow.integration.test.ts` (new scenario).  
   - Scenario:  
     - Construct two groups of mature cohorts for an edge:  
       - Older group (high `n`, lower conversion rate).  
       - Newer group (moderate `n`, higher conversion rate).  
     - Ensure all cohorts are mature (ages > t95).  
   - Tests should verify:  
     - The simple n-weighted average of all cohorts lies between the two group rates.  
     - The estimated `p_infinity` is closer to the newer group’s rate than to the overall simple average, consistent with half-life weighting.  
     - This effect persists across reasonable variations in group sizes.

2. **Sensitivity to half-life configuration (if ever exposed)**  
   - If `RECENCY_HALF_LIFE_DAYS` becomes configurable, add a param-driven test that:  
     - Repeats the previous scenario with different half-life values.  
     - Verifies that shorter half-life drives `p_infinity` closer to recent data, while longer half-life converges towards the unweighted average.

### Phase C – End-to-End Golden Path (Medium Priority)

**Goal:** Add a single “golden path” test that exercises the entire stack from DAS → param files → LAG → inbound-n → blended p.mean on a small but realistic graph.

1. **Three-edge LAG golden path**  
   - Location: New high-level integration test, likely under `graph-editor/tests/` or a new service-level integration file.  
   - Scenario:  
     - Use a small synthetic Amplitude-style payload (or re-use the existing reference + a minimal transform) to produce realistic param values for a 3-edge chain `A→X→Y→Z`.  
     - Run the full fetch → aggregation → LAG enhancement → inbound-n convolution.  
   - Tests should verify end-to-end properties:  
     - For each edge, `p.evidence.mean`, `p.forecast.mean`, `p.latency` fields, `p.n`, and final `p.mean` follow the design expectations from the schematic.  
     - Completeness is high on early, mature edges and lower on deep, immature ones.  
     - Inbound-n populations match the step-wise convolution described in §6.

### Phase D – Logging and Observability (Lower Priority but Useful)

**Goal:** Ensure key diagnostic outputs (especially session logs) match the schematic and remain stable.

1. **LAG_CALC_DETAIL semantic checks**  
   - Location: New small integration test around `fetchDataService` or a focused unit test that inspects the log payload before it is written.  
   - Scenario:  
     - Run `enhanceGraphLatencies` on a known edge set with deterministic inputs.  
   - Tests should verify:  
     - `LAG_CALC_DETAIL` entries include the documented fields: `queryDate`, `cohortWindow`, `rawAgeRange`, `adjustedAgeRange`, `pathT95`, `mu`, `sigma`, `totalN`, `totalK`, `sampleCohorts` (with ages and CDFs), and anchor-lag debug fields.  
     - Values are in the expected ranges (e.g. completeness ∈ [0,1], ages non-negative, anchorMedianLag zero for first edges, etc.).

2. **Cohort horizon log summary checks**  
   - Location: `cohortHorizonIntegration.test.ts` or an adjacent test.  
   - Scenario:  
     - Use the existing horizon computations but assert on the generated summary field.  
   - Tests should verify:  
     - The human-readable summary strings reflect the correct t95 source, bounding decisions, and date ranges.

### Phase E – Complex Topology Scenarios (Optional / Later)

**Goal:** Stress-test LAG on more complex DAGs representative of real customer graphs.

1. **Multi-branch, mixed-latency graph**  
   - Location: `lagStatsFlow.integration.test.ts` (or a new integration file).  
   - Scenario:  
     - Graph with multiple latency branches, non-latency shortcuts, and a deep downstream merge.  
     - Synthetic cohort and window data chosen so that:  
       - Some paths are highly complete, others are immature.  
       - Some branches have much lower probabilities, contributing little to p.n.  
   - Tests should verify:  
     - p.n and completeness at the merge node reflect the mixture of mature and immature paths.  
     - path_t95 and retrieval horizons differ appropriately across edges.

2. **Scenario toggles on complex graph**  
   - Extend the above scenario with at least two what-if configurations.  
   - Tests should verify that large-scale edge toggles and reallocations behave as described in §11, without violating the invariants established by earlier, smaller tests.

---

## 3. Prioritisation Summary

1. **Phase A – Scenario / conditional_p**  
   - Highest value relative to current gaps.  
   - Directly exercises the most weakly covered schematic section (§11).

2. **Phase B – Recency E2E**  
   - Clarifies and locks in the impact of `RECENCY_HALF_LIFE_DAYS` in real flows.

3. **Phase C – End-to-End Golden Path**  
   - Provides a single, high-signal regression test for the entire LAG pipeline.

4. **Phase D – Logging / Observability**  
   - Protects debuggability; useful but not directly user-facing.

5. **Phase E – Complex Topologies**  
   - Optional longer-term hardening once earlier phases are complete.


