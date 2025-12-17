## Context MECE: implicit uncontexted slices (window + cohort) and forecast/evidence aggregation

**Status**: Implemented (core semantics)  
**Last updated**: 17-Dec-25  
**Owner**: DagNet  
**Context**: Reduce wasted fetches and eliminate the requirement to retrieve explicit uncontexted slices when a contexted slice family is MECE. Ensure uncontexted queries (and implicit forecast baselines) can be satisfied from MECE partitions for both `window()` and `cohort()` modes.

### Problem statement

We currently support fetching and storing time-series data for multiple context slices (e.g. `context(channel:paid-search)` etc.). For MECE keys (where the context values form a mutually-exclusive and collectively exhaustive partition of the population), it is wasteful to require fetching an additional explicit uncontexted slice (`window(...)` or `cohort(...)` with no dotted `context(...)`) merely to support:

- Uncontexted queries (no explicit context filters)
- Cohort-mode forecast baselines (which currently prefer/require uncontexted `window()` slices)

We want:

- The system to use explicit uncontexted slices when they exist (user preference and lower compute risk).
- But to not require them: if a contexted set is MECE, the system should be able to treat that set as an implicit “uncontexted truth” for:
  - Cache coverage (date completeness)
  - Query-time aggregation (n/k/p, evidence)
  - Forecast baselines (implicitly for cohort queries)
  - LAG stats inputs that depend on cohort/window slices (with defensible weighting)

### Definitions

- **Slice family**: the set of parameter values sharing the same non-context dimensions (same case dimensions, same connection/query signature semantics), differing only by context value(s).
- **Mode**:
  - `window()` mode: dates represent step-event (X) dates
  - `cohort()` mode: dates represent cohort entry (A) dates for latency edges
- **Explicit uncontexted slice**: a stored `ParameterValue` entry whose `sliceDSL` has no context/case dimensions (e.g. `window(...)` or `cohort(...)` only).
- **Implicit uncontexted slice**: not stored as a distinct entry; instead derived at query time by aggregating a complete MECE partition of contexted slices.
- **MECE key**: a context key whose values represent a partition that is safe to aggregate by summing disjoint pools.
  - In DagNet, we do not “certify” MECE status by analysing raw data; the user’s context specification is the source of truth.
  - Practically: MECE-eligibility is declared via the context definition semantics (especially `otherPolicy` and how the “other” bucket is treated), and the system trusts that declaration when deciding whether it is safe to sum slices.

### Current behaviour (why it is insufficient)

1. **Cache cutting** (`calculateIncrementalFetch`) supports:
   - `contextAny(...)`: date exists only if all component slices have it.
   - Uncontexted query with only contexted data: “MECE coverage” is inferred by requiring every contexted slice to have the date.
   This is good, but it is not consistently keyed to a specific MECE universe and can accidentally include unrelated context families.

2. **Cohort evidence aggregation**:
   - Cohort aggregation utilities can “pick latest” per date when multiple cohort slices overlap. That is correct for overwrites within the same slice, but wrong for MECE partitions where we must sum disjoint pools per date.

3. **Forecast baselines for cohort queries** (`addEvidenceAndForecastScalars`):
   - Forecast is copied/recomputed from a matching `window()` slice with the same context/case dimensions.
   - For an uncontexted `cohort()` query, this implies we only find an uncontexted `window()` baseline, which forces explicit uncontexted window slices to exist (wasteful when a MECE set of window contexts already exists).

### Target behaviour

#### A) Uncontexted query resolution

For both `window()` and `cohort()` queries:

- If an explicit uncontexted slice exists for the mode and slice family, prefer it.
- Otherwise, if a complete MECE partition exists for the mode and slice family, derive an implicit uncontexted aggregate from the MECE set.
- Otherwise, treat as incomplete and require fetch / show partial data.

#### B) Cohort queries: evidence vs forecast sources

For cohort-mode (`cohort()`) queries on latency edges:

- **Evidence** should be computed from cohort-mode slices (A-anchored cohorts), aggregated to the requested cohort window.
- **Forecast** should be derived from the window-mode baseline of the same slice family.
  - If an explicit uncontexted window baseline exists, use it.
  - Otherwise, if a complete MECE partition of window slices exists, compute an implicit baseline by summing the MECE window slices (then apply the same maturity exclusion / recency weighting logic used for a single baseline).

This removes the requirement to fetch explicit uncontexted window slices just to support cohort forecasts.

### Implementation status (what is now implemented)

Core behaviour described in this document is now implemented in `graph-editor/`, with outcome-oriented e2e tests proving equivalence in the intended cases.

Implemented:

- **Implicit uncontexted from MECE (user-declared)**:
  - Uncontexted reads will use explicit uncontexted slices when present; otherwise they can use a MECE partition (single context key only) when the context definition declares MECE via `otherPolicy`.
- **Window-mode aggregation from MECE slices**:
  - Daily n/k are summed across context pools, and lag medians are computed as mixture medians (not averages of medians).
- **Cohort-mode implicit forecast baseline**:
  - When `edge.p.forecast.mean` is missing (common in MECE-only files), we now derive a stable baseline from window slices via mature-cohort \(p_\infty\) estimation, so cohort queries do not require explicit uncontexted window slices.
- **Partial fetch resumability (versioned mode)**:
  - Successful gaps are persisted as they complete, so re-running “Retrieve all slices” naturally picks up where it left off after rate limiting or transient provider failures.
- **Lag-maths single source of truth (Option A core)**:
  - Lognormal fitting + CDF/quantile maths is now centralised in a pure utility module and re-used by both LAG and MECE mixture aggregation.

Proof (tests):

- `graph-editor/src/services/__tests__/contextMECEEquivalence.paramPack.red.e2e.test.ts` (uncontexted cohort equivalence: explicit vs MECE-only)
- `graph-editor/src/services/__tests__/contextMECEEquivalence.windowAndIncomplete.e2e.test.ts` (uncontexted window equivalence + incomplete partition non-equivalence)
- `graph-editor/src/services/__tests__/lagDistribution.golden.test.ts` (numerical golden lock for lag maths refactor)
- `graph-editor/src/services/__tests__/dataOperationsService.incrementalGapPersistence.test.ts` (gap persistence/resume)

Notable follow-ups (optional):

- **`lagTypes.ts` clean-up** from the original Option A proposal was not required to achieve correctness and has not been done. The lag-maths single source of truth is already achieved via `lagDistributionUtils.ts`.

### Mathematical aggregation rules (defensible defaults)

The aggregation machinery must avoid “averaging averages” without appropriate weights.

#### Evidence/probability scalars (n/k/p)

- For disjoint MECE pools, aggregation is exact:
  - \(N = \sum_i N_i\)
  - \(K = \sum_i K_i\)
  - \(p = K / N\)

This applies to both window and cohort modes (where n/k are counts of users in the relevant populations for the date semantics).

#### Lag mean (mean_lag_days) and anchor mean (anchor_mean_lag_days)

- Treat mean lag as a mean over converting users; weight by conversions:
  - \(\mu = \frac{\sum_i (K_i \cdot \mu_i)}{\sum_i K_i}\)
- If \(K_i\) is unavailable or zero, fall back to weighting by \(N_i\) only if explicitly justified and logged (prefer dropping that slice for lag moments to avoid bias).

#### Lag median (median_lag_days) and anchor median (anchor_median_lag_days)

- Do not average medians directly (not invariant under mixtures).
- Use the mathematically correct target: the median of the pooled population, i.e. the 0.5 quantile of the mixture distribution:
  - For component CDFs \(F_i(t)\) and weights \(w_i\), mixture CDF \(F(t)=\sum_i w_i F_i(t) / \sum_i w_i\).
  - The pooled median is the smallest \(t\) such that \(F(t)\ge 0.5\).
- Implementation approach:
  - Approximate per-slice distributions (lognormal fits from median/mean with one-way tail constraints).
  - Compute mixture quantiles via monotone root finding (binary search on \(t\)).

All lag-aggregation decisions must be logged in session logs as they materially affect interpretation.

#### K=0 is normal: explicit handling rules

K=0 (no conversions) is an expected condition on many days/slices. Proposed rules:

- **Evidence/probability**:
  - Summation is always well-defined: \(K=\sum K_i\), \(N=\sum N_i\), \(p=K/N\) (with \(p\) undefined if \(N=0\)).
  - A MECE aggregate with \(K=0\) and \(N>0\) should produce \(p=0\) (not missing).

- **Lag moments/quantiles** (edge and anchor lag arrays):
  - Lag statistics are defined over converting users (or an explicitly documented population). When \(\sum K_i = 0\) for the aggregate on a given day/window, lag moments and medians are undefined and should remain unset (and we should warn at a high level).
  - Weighting:
    - **Edge lag** (`median_lag_days`, `mean_lag_days`) uses weights \(w_i = K_i\) for that date/window.
    - **Anchor lag** (`anchor_median_lag_days`, `anchor_mean_lag_days`) should follow existing DagNet semantics: weight by cohort population \(N_i\) for that date/window (this matches current anchor aggregation behaviour).
  - Missing/invalid per-slice lag values for a date should cause that slice to contribute zero weight for that specific lag statistic only (do not drop the slice from evidence aggregation).

### Proposed implementation changes (survey + concrete touch points)

#### 1) Centralise MECE slice detection and “implicit uncontexted” resolution

Add a new service (suggested location):

- `graph-editor/src/services/meceSliceService.ts`

Responsibilities:

- Identify which context keys are eligible as MECE keys (via the user-declared `contextRegistry` semantics; especially `otherPolicy`).
- Given a set of `ParameterValue` entries + a target mode (`window` or `cohort`) + a slice family descriptor (context/case dims + signature rules), determine:
  - Whether a complete MECE partition exists
  - Which values comprise the partition
  - Whether it is safe to sum (guardrails against mixed dimensions)

Guardrail (non-vague, explicit):

- Implicit uncontexted aggregation is only permitted when the participating slices vary by **exactly one** context key (the MECE key) and share identical other slice dimensions (case dims and any non-context qualifiers). We do not attempt to treat multi-key context products as MECE in this work.

This service becomes the single source of truth used by:

- Cache cutting (`calculateIncrementalFetch`)
- Cohort/window aggregation logic
- Forecast baseline selection for cohort queries

#### 2) Cache cutting: align MECE coverage checks to the MECE universe

Update:

- `graph-editor/src/services/windowAggregationService.ts` (`calculateIncrementalFetch`)

Changes:

- When evaluating the MECE path (uncontexted query on contexted-only data), use the MECE slice universe returned by `meceSliceService`, not “all slices with any context dimension”.
- Ensure the logic is mode-aware and does not mix cohort/window.
- Ensure `contextAny` checks also use the same universe when appropriate (e.g. `contextAny(channel:...)` should be validated against known MECE values if that is the intended contract).

#### 3) Cohort data aggregation: add MECE-summing mode

Update:

- `graph-editor/src/services/windowAggregationService.ts` (`aggregateCohortData` and any cohort evidence helpers)

Changes:

- Introduce a MECE-summing path for uncontexted cohort queries without an explicit uncontexted cohort slice:
  - For each cohort date, sum n/k across MECE slices.
  - Aggregate lag moments using conversion-weighted rules above.
- Preserve the existing “latest retrieved_at wins” logic only for:
  - Overwrites within the same slice (non-MECE) and/or duplicate entries for the same slice family.

#### 4) Forecast baselines for cohort queries: allow implicit baseline from MECE window slices

Update:

- `graph-editor/src/services/dataOperationsService.ts` (`addEvidenceAndForecastScalars`)

Changes:

- When cohort query is uncontexted and no explicit uncontexted window baseline exists:
  - Attempt to derive a synthetic baseline from MECE window slices via `meceSliceService`.
  - Apply the existing maturity exclusion + recency weighting forecast computation on the synthetic baseline.

Important guardrail:

- The synthetic baseline must be derived only from slices that form a complete MECE partition for the chosen key; otherwise it risks double counting or missing mass.

#### 4a) Realistic edge cases and expected behaviour (graceful degradation)

We should explicitly define “what happens” in the realistic failure/mismatch cases:

- **Some MECE slices exist, but the partition is incomplete** (user didn’t fetch all contexts):
  - Behaviour: do not treat it as implicit uncontexted; surface a non-blocking warning that uncontexted results may be incomplete; allow partial display from explicit slices.

- **Per-day coverage gaps differ across slices** (e.g. one channel has data, another has missing days):
  - Behaviour: implicit uncontexted is only “complete” for the intersection of covered days; for missing days, treat as missing and (if in fetch mode) schedule those gaps; warn that MECE aggregate is partially defined.

- **“No data” markers present for some slices**:
  - Behaviour: treat markers as explicit zero evidence for those days for that slice (they participate in MECE summation as zeros).
  - Warn only if a large fraction of the MECE mass is “no data” so the user can interpret evidence correctly.

- **K=0 on some or all slices/days**:
  - Behaviour: evidence aggregation is still defined (p=0 when N>0). Lag medians/means remain undefined when totalK=0, and blend should fall back towards forecast (consistent with existing philosophy).

- **Different retrieved_at timestamps across slices**:
  - Behaviour: do not attempt to align by timestamp; treat each slice as “best available” for its covered days. If the implicit MECE aggregate is computed from slices with widely different retrieval times, emit a warning that the aggregate is built from mixed freshness.

- **Mixed query signatures across slices** (e.g. a pinned slice definition changed and only some contexts were re-fetched):
  - Behaviour: never sum across incompatible signatures.
  - Proposed rule: for any implicit MECE aggregate, only consider slices whose `query_signature` matches the currently effective signature for the active query.
    - If that yields an incomplete partition, treat the implicit uncontexted result as incomplete and warn (non-blocking).
    - In “Retrieve all slices” workflows, the next run should naturally converge the signatures by refreshing all slices.

- **Partial fetches / provider rate limits mid-run**:
  - Behaviour: any successfully fetched gap should be persisted to the parameter file immediately (versioned mode), so a later re-run simply fetches the remaining missing gaps.
  - If a later gap fails, the system should warn that the run partially completed and that re-running later will resume.

#### 5) LAG topo pass: ensure it consumes MECE-aggregated cohorts consistently

Update:

- `graph-editor/src/services/statisticalEnhancementService.ts` (`enhanceGraphLatencies`)

Changes:

- When the active query is uncontexted cohort mode and the parameter file lacks explicit uncontexted cohort/window slices but has a complete MECE partition, ensure:
  - The cohort cohorts used for evidence/completeness reflect the MECE aggregate (not “latest wins”).
  - The baseline window N used for forecasting/completeness can come from the MECE-derived window baseline if explicit uncontexted baseline is absent.

### User warnings for slice DSL generation (explicit vs implicit uncontexted availability)

We should warn users when a proposed “Retrieve all slices” configuration does not guarantee either explicit or implicit uncontexted support for both modes.

#### Definitions for the warning

- **Explicit** uncontexted support exists if the slice list contains both:
  - a `window(...)` slice with no dotted `context(...)`
  - a `cohort(...)` slice with no dotted `context(...)`

- **Implicit** uncontexted support exists if:
  - For `window()`: the slice list contains a complete MECE partition of `window(...).context(key:value)` slices for at least one MECE key.
  - For `cohort()`: the slice list contains a complete MECE partition of `cohort(...).context(key:value)` slices for the same MECE key.

#### Where to implement the warning

- The warning should be surfaced when the user **sets pinned queries** (and when configuring “Retrieve all slices”), without duplicating business logic in UI components.
- Warnings are **never blocking**: they are advisory and explain what will and won’t be available implicitly/explicitly.
- Implement as a service-level validator returning structured warning messages, then render in UI.

Suggested service entry point:

- `graph-editor/src/services/slicePlanValidationService.ts`

Inputs:

- Proposed slice DSL list (window slices and cohort slices)
- Current context registry (MECE eligibility)

Outputs:

- Warnings:
  - Missing explicit uncontexted window slice AND no implicit MECE window partition
  - Missing explicit uncontexted cohort slice AND no implicit MECE cohort partition
  - Mismatch: MECE window partition exists for key X but cohort partition exists for key Y (cannot support implicit dual-slice cohort behaviour cleanly)

### Observability and logging

All implicit MECE derivations must be explicitly logged (session logs) with:

- Mode (window/cohort)
- MECE key used
- Values included (and whether “other” is computed vs explicit)
- Whether explicit uncontexted slice existed and was preferred
- Any approximation used for medians/quantiles

### Test strategy (additive)

Add new tests (do not edit existing tests unless explicitly authorised):

- Uncontexted `cohort()` query with no uncontexted baseline but complete MECE partitions for both:
  - evidence comes from cohort MECE sum
  - forecast comes from window MECE baseline
- Incomplete MECE partition should not be treated as implicit uncontexted (must remain partial/missing).
- Median/mean combination rules: verify conversion-weighted behaviour for means and a clear, deterministic approximation for medians.

### Outcome-oriented RED tests (TDD gate)

This change is high-risk and semantics-heavy. We should therefore add outcome-oriented RED tests before implementation, written as end-to-end assertions from:

- Parameter file contents (values array, sliceDSLs, dates, n/k, lag arrays, forecast scalars)
- Through production query-time logic (fetch-from-file, aggregation, LAG topo pass)
- To flattened param pack outputs (scenario-visible fields)

The core contract we want to enforce:

- For a MECE key and complete MECE partitions, “explicit uncontexted slices” and “implicit MECE-derived uncontexted slices” must yield the same param packs for the same query, within tight tolerance.

Suggested RED test shape:

- Build two parameter files representing the same underlying world:
  - File A: includes explicit uncontexted `window(...)` and `cohort(...)` slices (no contexts required for the query to work).
  - File B: includes only the MECE contexted slices for both modes (no explicit uncontexted slices).
- Run the same uncontexted query (e.g. `cohort(A, 1-Dec-25:7-Dec-25)`) through the production “from-file” pipeline and produce param packs.
- Assert that the param packs’ edge fields (`p.mean`, `p.evidence.*`, `p.forecast.*`, `p.latency.*`) match exactly or within a strict numeric tolerance.

Implementation notes:

- These tests should be introduced as RED tests using `describe.skip` (consistent with existing outcome-first test patterns) and then un-skipped as the implementation work proceeds.
- No mocking should be used other than the Amplitude HTTP boundary when a test exercises source fetches; for pure “from-file” equivalence tests, no HTTP mocking is needed.
- Where medians are involved, the baseline (File A) should encode the agreed aggregation rule so equivalence is unambiguous (e.g. conversion-weighted mean for means; and an explicitly chosen median aggregation rule).

### Architecture proposal: Option A (extract pure lag distribution utilities for reuse)

This section reasons through “Option A” in detail: extracting the lognormal and quantile machinery into a shared module so it can be reused at aggregation time (MECE implicit uncontexted slices) and at graph-level enhancement time (LAG topo pass), without duplicating logic.

#### Why Option A exists (problem restatement)

The MECE work requires computing mixture quantiles (in particular mixture medians) and tail-constrained distribution parameters in at least two places:

- Query-time aggregation: building implicit uncontexted baselines from MECE context slices for both `window()` and `cohort()`.
- Graph-level latency enhancement (LAG): fitting, tail constraints, completeness CDF construction, path horizon handling.

Today, most of the lognormal fitting and quantile machinery lives inside the statistical enhancement layer, which is oriented around graph-level orchestration and session logging. Calling that directly from aggregation code risks:

- growing existing coupling between services,
- introducing or worsening circular dependencies,
- and creating two inconsistent implementations if we duplicate maths.

Option A is the clean path: share pure maths, keep orchestration where it belongs.

#### Current architectural constraint (important)

There is already cross-coupling between the layers:

- Statistical enhancement references aggregation types.
- Aggregation references statistical enhancement types.

If we add more “statistical” logic into aggregation without restructuring, we will make the dependency graph harder to reason about and more brittle.

Option A is explicitly about using this work to fix the dependency shape rather than worsen it.

#### Target dependency shape (what “good” looks like)

We want to end up with three conceptual layers:

- **Pure maths utilities (shared)**: deterministic functions; no session logging; no graph knowledge; no file registry; no UI.
- **Aggregation layer (query-time)**: slice isolation, MECE set selection, date aggregation, and invoking the shared maths utilities.
- **Graph-level enhancement layer (LAG)**: topo ordering, join semantics, path horizon propagation, and invoking the shared maths utilities; owns detailed session logging for user-facing observability.

This ensures:

- There is exactly one implementation of lognormal fitting, inverse CDF, and tail constraint logic.
- Aggregation can compute mixture medians and synthetic baselines without pulling in graph-level orchestration.
- Graph-level LAG continues to own “system behaviour” and logging.

#### Proposed module split (concrete)

Create a new shared module for distribution maths:

- `graph-editor/src/services/lagDistributionUtils.ts` (or `graph-editor/src/lib/lagDistributionUtils.ts`)

Contents (pure, deterministic):

- Lognormal CDF and inverse CDF utilities used today for quantiles.
- Fit-from-moments routine (median/mean → lognormal parameters) including quality gating inputs.
- One-way tail constraint helpers (t95/path_t95) that return both:
  - the adjusted parameters, and
  - structured diagnostics describing what was changed (so callers can log).
- Mixture quantile solver:
  - given a set of component distributions and weights, return the mixture quantile for a requested percentile.
  - intended first use: mixture median for MECE aggregation.
- Optional mixture helpers for shifted distributions once histogram-derived delay is introduced later (do not implement delay now; just keep the utilities extensible).

Create a new shared types module to break circular imports:

- `graph-editor/src/services/lagTypes.ts`

Move types that are currently shared across layers into this file. Candidates include:

- Cohort-like data point types used by both aggregation and LAG.
- Fit result shapes returned by the pure maths utilities.

Then:

- Statistical enhancement imports types from `lagTypes.ts` and pure maths from `lagDistributionUtils.ts`.
- Aggregation imports types from `lagTypes.ts` and pure maths from `lagDistributionUtils.ts`.
- Aggregation must not import statistical enhancement just to get types.

#### Logging and observability under Option A

The shared maths module must not write session logs. Instead:

- Functions return “diagnostic facts” as plain objects (for example: whether a tail constraint was applied; input vs output sigma; which horizon was used; whether quality gates were met).
- Callers decide how to log:
  - Statistical enhancement should log extensively because it is user-facing and graph-global.
  - Aggregation should log only high-signal events (e.g. “used implicit MECE baseline; key=channel; values included=…; median computed by mixture quantile”).

This avoids:

- coupling maths to session log categories,
- flooding session logs from per-date aggregation loops,
- and making unit tests brittle due to logging side effects.

#### How this enables MECE mixture medians without re-architecting LAG

Once the shared utilities exist, the MECE work can safely compute mixture medians (and other quantiles) at aggregation time by:

- Fitting per-slice distributions from the stored per-slice median/mean lag series (with conversion-weighted inputs).
- Applying one-way tail constraints using the same logic as LAG uses today.
- Computing mixture quantiles using the solver (weighted by conversions).

This has two important benefits:

- The median aggregation rule becomes explicit and testable as a pure function.
- The result matches the same distribution semantics that LAG uses, reducing semantic drift.

#### Implementation steps (migration plan)

1. **Extract types to a shared types file**:
   - Introduce `lagTypes.ts`.
   - Move the shared types out of statistical enhancement into this file.
   - Update imports so aggregation uses `lagTypes.ts` rather than importing statistical enhancement.

2. **Lock in behaviour with numerical “golden” tests (before refactor)**:
   - Add a small, explicit set of deterministic numerical tests that exercise the public/statistically-relevant surfaces we are about to extract (lognormal fit from moments, tail constraint behaviour, inverse CDF/quantiles, and any completeness-CDF parameterisation used by LAG).
   - These tests should assert exact or near-exact numeric outputs (tight tolerances) for a curated set of inputs that cover:
     - Typical medians/means
     - Edge cases (small K, extreme mean/median ratios, invalid inputs)
     - Tail-constraint cases where sigma must increase (and cases where it must not)
   - The intention is not to test implementation details, but to “freeze” the externally observable numerical behaviour so the subsequent refactor can be proven correct.

3. **Extract pure distribution utilities**:
   - Introduce `lagDistributionUtils.ts` containing the lognormal maths and fitting logic.
   - Ensure there are no imports from services with side effects (no file registry, no session logs).
   - Return diagnostics rather than logging.

4. **Refactor statistical enhancement to consume the shared utilities**:
   - Replace internal references to the moved maths with imports from the new module.
   - Keep existing behaviour the same (this refactor should be behaviour-preserving).
   - Use the pre-built numerical “golden” tests plus the existing test suite as proof that behaviour did not change.

5. **Update aggregation paths to use the shared utilities**:
   - Implement the MECE “implicit uncontexted” baseline logic using the shared maths.
   - Implement mixture median aggregation in the MECE cohort and window aggregators.
   - Keep all behaviour behind the MECE detection guardrails described earlier in this doc.

6. **Enable the outcome-oriented RED tests**:
   - Unskip the param-pack equivalence RED tests and iterate until they pass.
   - Add additional RED tests for incomplete MECE and median aggregation edge cases as needed.

7. **Confirm 100% behavioural equivalence for the refactor, then delete old code entirely**:
   - Once the numerical “golden” tests and the relevant existing integration tests pass, treat that as the correctness proof for the extraction refactor.
   - Remove the duplicated in-file implementations from `statisticalEnhancementService.ts` (do not keep compatibility shims or deprecated aliases).
   - Keep only the single source of truth: the shared pure module plus the service-level orchestration that calls it.

#### Risks introduced by Option A (and mitigations)

- **Risk: subtle behavioural changes during refactor**:
  - Mitigation: treat steps 1–3 as behaviour-preserving; rely on existing tests to lock behaviour; add a small set of deterministic unit tests for the extracted utilities.

- **Risk: circular dependency remains**:
  - Mitigation: the explicit objective of `lagTypes.ts` is to eliminate the need for aggregation to import statistical enhancement types.

- **Risk: logging becomes inconsistent**:
  - Mitigation: define structured diagnostics returned by the utilities; standardise how statistical enhancement emits session logs from those diagnostics.

- **Risk: two definitions of “tail constraint” semantics**:
  - Mitigation: tail constraint lives only in the shared maths module; callers do not implement their own versions.

#### Why this is preferable to alternatives

- It avoids duplicating lognormal maths in multiple services.
- It prevents the MECE aggregation work from becoming entangled with graph-level topo orchestration code.
- It reduces long-term maintenance risk by creating a single source of truth for fitting and quantiles.


