## Context MECE: implicit uncontexted slices (window + cohort) and forecast/evidence aggregation

**Status**: Draft (proposal)  
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
- **MECE key**: a context key whose values represent a partition that is safe to aggregate by summing disjoint pools (e.g. marketing channel buckets, depending on `otherPolicy` and mapping semantics).

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
- Preferred: compute a mixture median by:
  - Building per-slice distribution approximations (using existing fitting utilities), then computing mixture quantiles weighted by \(K_i\).
- Acceptable initial approximation (explicitly labelled as such): weighted median of slice medians using weights \(K_i\).

All lag-aggregation decisions must be logged in session logs as they materially affect interpretation.

### Proposed implementation changes (survey + concrete touch points)

#### 1) Centralise MECE slice detection and “implicit uncontexted” resolution

Add a new service (suggested location):

- `graph-editor/src/services/meceSliceService.ts`

Responsibilities:

- Identify which context keys are eligible as MECE keys (via `contextRegistry` semantics).
- Given a set of `ParameterValue` entries + a target mode (`window` or `cohort`) + a slice family descriptor (context/case dims + signature rules), determine:
  - Whether a complete MECE partition exists
  - Which values comprise the partition
  - Whether it is safe to sum (guardrails against mixed dimensions)

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

- The warning should be surfaced in the slice selection UX that drives “Retrieve all slices” (and in the pinned query tooling), without duplicating business logic in UI components.
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


