## Retrieval Date Logic – Design vs Implementation Redux

**Date:** 9-Dec-25  
**Status:** Analysis / gap review  
**Scope:** Retrieval windows, maturity, and staleness decisions for `window()` and `cohort()` queries, with particular focus on `t95` / `path_t95` usage.

---

## 1. Design Intent (Summary)

This section distils the relevant intent from `design.md` and the window fetch planner docs.

- **Latency scalars and arrays (design.md §3.2):**
  - Parameter files for latency edges store per-cohort arrays (`median_lag_days[]`, `mean_lag_days[]`, `anchor_*_mean_lag_days[]`) and slice-level summaries (`latency.median_lag_days`, `latency.mean_lag_days`, `latency.t95`, `latency.completeness`, `anchor_latency.*`).
  - These are inputs to lag CDF fitting and **t95** computation, not directly the retrieval horizon.

- **Edge-level `t95` (design.md §3.2, §4.7.2, §5.2.1):**
  - `t95` is the persisted 95th percentile lag per edge under the pinned DSL.
  - It is computed from `median_lag_days` and `mean_lag_days` with quality gates; when empirical quality is poor, we fall back to `legacy maturity field`.
  - `t95` is the **primary maturity horizon** for both caching and forecasting.

- **Path-level `path_t95` (design.md §4.7.2):**
  - For cohort slices, **total maturity** is `A→X maturity + X→Y maturity`, expressed as `path_t95` along active paths.
  - A cohort from date \(D\) is mature when `today - D >= path_t95` along the relevant A→…→edge path.
  - `path_t95` is computed in-memory via a DP over active edges and is **transient, per-scenario** (not persisted).

- **Cohort retrieval horizon (design.md §4.7.2, §5.2.1):**
  - For cohort queries, the **effective “how far back” window should be limited by total maturity** (using `t95` / `path_t95`), not by arbitrary DSL ranges.
  - The design explicitly aims to avoid naive “always refetch full -90d cohorts” when only a shorter horizon is warranted by lag statistics.

- **Window retrieval and staleness (window-fetch-planner-service.md §5.2, window-fetch-planner-detailed-design.md):**
  - For `window()`:
    - Coverage is determined by slice headers / daily data (existing vs missing dates).
    - Staleness and refresh candidacy should be driven by **retrieval timestamps plus `t95` / `path_t95`**, not age alone.
  - Planner design requires:
    - Using `t95` (window) or `path_t95` (cohort) when deciding **whether cached-but-complete data is “stale” enough to recommend refresh**.
    - Treating data as **stable** once all previously immature evidence is comfortably beyond the relevant `t95`/`path_t95` threshold, even if it’s old.

---

## 2. Where `t95` / `path_t95` Are Implemented Today

### 2.1 Production of `t95` from cohort/window data

- **Computation and propagation:**
  - `windowAggregationService.mergeTimeSeriesIntoParameter` recomputes latency summaries (including `t95`) after merges and writes them into the latest `values[].latency` entry.
  - `UpdateManager` copies `values[latest].latency.t95` onto `edge.p.latency.t95` for use on the graph.
  - `statisticalEnhancementService.computeEdgeLatencyStats` (tested in `statisticalEnhancementService.test.ts`) produces a `t95` scalar alongside `p_infinity`, `p_mean`, `completeness`, etc., from cohort-style inputs.
  - Param‑pack e2e tests assert that `p.latency.t95` is present and stable in scenario-visible outputs.

**Conclusion:** **Edge-level `t95` production and persistence are implemented and tested.**

### 2.2 Path-level `path_t95`

- **Implementation:**
  - `statisticalEnhancementService.ts` contains:
    - `computePathT95(graph, activeEdges, anchorNodeId?)` – topological DP computing `path_t95` for active edges.
    - `applyPathT95ToGraph(graph, pathT95Map)` – writes `path_t95` onto `edge.p.latency.path_t95` (transient).
  - `LatencyConfig` type includes an optional `path_t95?: number` field for this transient value.

- **Usage:**
  - **No call sites** for `computePathT95` or `applyPathT95ToGraph` were found in the TypeScript codebase.
  - `fetchDataService` only sorts fetch items topologically with a comment about ensuring t95 is available “before they’re needed for downstream path_t95 calculations”, but there is no subsequent call to compute/apply path_t95.
  - There are no tests asserting that `path_t95` is non‑undefined or that it influences any policy decisions.

**Conclusion:** The **path_t95 DP is implemented but currently unused**. It is dead code with respect to runtime retrieval / refetch decisions.

---

## 3. Current Retrieval Logic: Window Queries

This section describes the actual behaviour for `window()` queries from hook → service → data operations.

### 3.1 Call path

1. UI / callers use `useFetchData` with `currentDSL` set to a `window(...)` DSL.
2. `useFetchData.fetchItem` and `fetchDataService.fetchItem` propagate the DSL as both `currentDSL` and `targetSlice` into `dataOperationsService.getFromSource`.
3. `getFromSource` forwards the call to `getFromSourceDirect`, which:
   - Builds a **query payload** including window/cohort dates.
   - Determines a **requested window**:
     - If the DSL contains window dates, those **exact dates** are used as `requestedWindow`.
     - Otherwise, it falls back to a default 7‑day window.
   - Checks for incremental fetch / maturity‑aware refetch (see below).

### 3.2 Non‑latency edges (legacy maturity field ≤ 0 or no latency)

- For edges with `latency.legacy maturity field <= 0`:
  - `fetchRefetchPolicy.shouldRefetch` returns `type: 'gaps_only'`.
  - In `dataOperationsService`, the `refetchPolicy` short‑circuit path for latency edges is effectively bypassed for non‑latency edges.
  - `calculateIncrementalFetch` in `windowAggregationService` is invoked with:
    - `requestedWindow` = **the full requested DSL window**.
    - `targetSlice` = `currentDSL`, so isolation respects context / MECE semantics.
  - Incremental fetch then:
    - Computes all dates in `requestedWindow`.
    - Counts dates with valid `n_daily`/`k_daily` in the slice.
    - Marks missing dates as gaps and returns per‑gap windows (`fetchWindows`) and a combined `fetchWindow`.
  - The actual execution uses those **gap windows only**.

**Key point:** For non‑latency window edges, **t95 is not consulted**. Retrieval horizon is exactly the requested window, and we only avoid re‑fetching dates that already have daily data.

### 3.3 Latency window edges (legacy maturity field > 0 / t95 > 0)

- **Effective maturity selection (edge‑level t95):**
  - `fetchRefetchPolicy.computeEffectiveMaturity` chooses:
    - `effectiveMaturityDays = ceil(t95)` if `t95 > 0`, otherwise
    - `effectiveMaturityDays = legacy maturity field`.
  - Tests in `fetchRefetchPolicy.branches.test.ts` confirm this matrix.

- **Window refetch policy:**
  - For window mode (`isCohortQuery = false`), `evaluateWindowRefetch`:
    - Derives a **maturity cutoff date** = `referenceDate - (effectiveMaturityDays + 1)` days.
    - If the requested window lies entirely before the cutoff → `type: 'gaps_only'` (treat as mature).
    - Otherwise → `type: 'partial'`, with:
      - `matureCutoff` and a `refetchWindow` corresponding to the immature tail of the requested window.

- **Integration in `dataOperationsService`:**
  - When `refetchPolicy.type === 'use_cache'`:
    - `shouldSkipFetch = true` → **no fetch**.
  - When `refetchPolicy.type === 'partial'`:
    - `actualFetchWindows` is initially set to `[refetchWindow]` (immature portion).
    - Incremental fetch is still run over the **full requested window** to detect gaps in both mature and immature regions.
    - Fetch windows may be extended to cover mature gaps if needed.
  - When effective result is gaps‑only (either by policy or by falling back to non‑latency logic):
    - Only gaps (missing dates) in the requested window are fetched.

**Key point:** For latency window edges, `t95` is **used to define a maturity cutoff and split the requested window into mature vs immature parts**, but:

- The retrieval horizon is still **anchored to the requested window dates**, not to an independent t95‑driven baseline.
- There is **no separate staleness test** that uses `(retrieved_at + t95)` vs query horizon as described in the planner design; decisions are local to the edge and per‑request.

---

## 4. Current Retrieval Logic: Cohort Queries

This is the area of most concern relative to the design.

### 4.1 How cohort queries are constructed and passed through

- A `cohort(...)` DSL (e.g. `cohort(anchor,-90d:)`) is:
  - Parsed in `dataOperationsService.getParameterFromFile` and `getFromSourceDirect` to derive a **cohort window** (A‑anchored entry dates).
  - Combined with window information (if present) when running dual‑slice retrieval.
- For versioned cohort fetches:
  - `fetchDataService.fetchItem` passes the same DSL as both `currentDSL` and `targetSlice` into `dataOperationsService.getFromSource`.
  - Inside `getFromSourceDirect`, the Amplitude (or other source) pre‑request is built from this DSL; the **cohort range sent to the API is directly determined by the DSL dates** (after resolving `-90d:` etc).

**No code currently re‑writes the cohort date range using `t95` or `path_t95`.** The only special‑case cohort handling is in the refetch policy and merge mode, not in the date window itself.

### 4.2 Cohort refetch policy (latency edges)

- `fetchRefetchPolicy.shouldRefetch` delegates cohort logic to `evaluateCohortRefetch` with:
  - `legacy maturity threshold = effectiveMaturityDays` derived from `t95` or `legacy maturity field`.
  - `requestedWindow` (for cohort) passed through but **not modified**.

- `evaluateCohortRefetch`:
  - If `existingSlice` is missing or has no cohort dates → `type: 'replace_slice'` with reasons `no_existing_slice` / `no_cohort_dates`.
  - Else, computes a maturity cutoff date from `legacy maturity threshold` (i.e. effective t95):
    - If any cohort dates are **newer than the cutoff** → `type: 'replace_slice'` with reason `immature_cohorts`.
  - Else, if all cohorts are mature but `retrieved_at` is **older than legacy maturity threshold (t95) ago** → `type: 'replace_slice'` with reason `stale_data`.
  - Else → `type: 'use_cache'` (all cohorts mature and data fresh enough).

- Integration in `dataOperationsService`:
  - When `refetchPolicy.type === 'replace_slice'` and `isCohortQuery`:
    - `actualFetchWindows` is set to `[requestedWindow]`.
    - Incremental fetch (`calculateIncrementalFetch`) is **explicitly bypassed** for cohort mode in the integration tests.
    - Cohort merges use `mergeTimeSeriesIntoParameter` with `isCohortMode: true`, which **replaces the existing cohort slice entirely**.

**Implications:**

- When a cohort refetch is triggered (immature cohorts or stale slice), we **re-fetch the entire requested cohort window**, *exactly as specified in the DSL*, regardless of:
  - How far back `t95` or `path_t95` suggests the edge/path meaningfully contributes.
  - Whether older cohorts are already fully mature and effectively stable.
- When `use_cache` is returned, we skip fetch entirely, even if:
  - The DSL’s cohort range is wider than what `path_t95` would suggest is necessary.

There is **no implemented logic that shrinks or bounds the cohort retrieval window using `t95` or `path_t95`.** The maturity logic is used purely to decide **“replace full slice vs use cache”**, not **“how far back”** to retrieve.

### 4.3 Cohort queries on non‑latency edges

- For edges without latency config, cohort queries degenerate to:
  - Full‑window retrieval per DSL the first time (no slice exists).
  - There is no separate cohort‑specific incremental fetch policy; in practice, these are rare and the main path is latency‑enabled cohorts.

**Net effect:** The more sophisticated design that uses cumulative lag (via `t95`/`path_t95`) to bound the historical cohort window is **not present** in current code. Refetches either:

- Skip entirely (`use_cache`), or
- Replace **the full DSL cohort window**, which can be `-90d` or longer.

---

## 5. Staleness / Refresh Semantics vs Planner Design

The planner design in `window-fetch-planner-service.md` and `window-fetch-planner-detailed-design.md` requires:

- A staleness test using:
  - Retrieval timestamps (`data_source.retrieved_at`).
  - `t95` (for window) or `path_t95` (for cohort) to decide:
    - When cached-but-complete data should be flagged as “covered but potentially stale”.
    - When it should instead be treated as “covered and stable”.
- Integration into a central planner result:
  - `effectiveT95` field per item.
  - Differentiated planner outcomes: **covered and stable**, **not covered**, **covered but stale**.

### 5.1 Current use of retrieval timestamps

- Retrieval timestamps are used in two main places:
  - Cohort refetch policy (`evaluateCohortRefetch`):
    - `retrieved_at` older than `legacy maturity threshold (≈ t95)` → `replace_slice` due to `stale_data`.
  - Logging / diagnostics in `dataOperationsService` and `windowAggregationService` (for session logs and debugging).

There is **no central planner** in the codebase today that:

- Combines coverage, maturity, and staleness into a single decision.
- Classifies items into “covered stable” vs “covered stale” vs “missing”.
- Uses `t95` or `path_t95` to drive a UI‑visible “Refresh” state as described in the planner docs.

### 5.2 Missing planner entry points

- There is no `windowFetchPlannerService.ts` (or similar) implemented.
- Planner-related types and pseudo-code only appear in:
  - `docs/current/project-lag/window-fetch-planner-service.md`
  - `docs/current/project-lag/window-fetch-planner-detailed-design.md`
- No React components or services currently import or call a planner analysis/execution function.

**Conclusion:** The **planner’s staleness semantics based on `t95`/`path_t95` and retrieval timestamps have not yet been implemented.** All current decisions are made in:

- `hasFullSliceCoverageByHeader` (header-based coverage only).
- `calculateIncrementalFetch` (gap-based daily coverage only).
- `fetchRefetchPolicy.shouldRefetch` (edge-local maturity / staleness decisions).

---

## 6. Alignment Summary: Design vs Implementation

### 6.1 Implemented as designed

- **Edge-level `t95` computation and persistence:**
  - `t95` is computed from median/mean lag and exposed via `p.latency.t95`.
  - Tests validate that t95 is finite and propagated into the param pack and UI.

- **Effective maturity selection for latency edges:**
  - `computeEffectiveMaturity` honours “prefer `t95`, fallback to `legacy maturity field`”.
  - `shouldRefetch` uses this for both cohort and window modes.

- **Latent vs non-latent window behaviour:**
  - Non‑latency edges use incremental gap detection only.
  - Latency window edges use partial refetch of the immature tail plus filling mature gaps.

### 6.2 Partially implemented

- **Cohort maturity / staleness decisions:**
  - Cohort refetch policy correctly:
    - Detects immature cohorts via a `t95`‑derived maturity cutoff.
    - Treats very old slices as stale and refetches.
  - However, it does **not** use `path_t95` and does not bound the **range** of cohorts fetched.

- **Path_t95 computation:**
  - Core DP and application functions exist and mirror the design §4.7.2.
  - They are not wired into any production flow (no calls, no tests that exercise them).

### 6.3 Not implemented / Divergent

- **Cohort retrieval horizon:**
  - Design intent: bound “how far back” we retrieve cohorts using `t95`/`path_t95`, so we rarely (if ever) need to refetch a full `-90d` range when only the last `t95` days materially contribute.
  - Current implementation: cohort refetches always request the **full DSL cohort window** whenever `replace_slice` is triggered, regardless of `t95` or upstream path lag.

- **Planner-based staleness classification:**
  - Design intent: a central planner that:
    - Distinguishes **covered stable** vs **covered stale** based on `t95`/`path_t95` + `retrieved_at`.
    - Drives a “Refresh” outcome distinct from “Fetch missing”.
  - Current implementation: no planner exists; staleness is handled only at the edge level (cohort stale → `replace_slice`; window immature → `partial`), and not surfaced as a separate outcome state in the window selector.

- **Retrieval-date horizon based on total path maturity (`path_t95`):**
  - Design describes computing `path_t95` from edge `t95` and using it to:
    - Decide cohort maturity relative to A‑anchored entry dates.
    - Influence implicit baseline windows and refresh recommendations.
  - Current code:
    - Computes `t95` but does **not** calculate or use `path_t95` anywhere in the live flow.
    - Does not alter cohort or window date ranges based on cumulative lag; all ranges are driven directly by:
      - The DSL (`window(...)`, `cohort(...)`) for explicit queries.
      - A fixed “last 7 days” baseline when no window is supplied.

---

## 7. Practical Implications

1. **Cohort refetching is over‑broad vs design intent.**
   - Any refetch event for a latency cohort edge will refetch the **entire requested cohort window** (e.g. all 90 days), even when:
     - Only a much shorter horizon (e.g. 20–30 days) matters given `t95` / `path_t95`.
     - Older cohorts are fully mature and effectively stable.

2. **Staleness UX lacks the designed granularity.**
   - There is no “covered but stale” vs “covered and stable” distinction driven by t95/path_t95 plus retrieval timestamps in the window selector.
   - Users see a simpler behaviour: either “needs fetch” (via header/daily coverage) or “cache is fine”, without design-intended hints about maturing cohorts.

3. **Path_t95 is unused despite being implemented.**
   - The DP code is present but not integrated.
   - The topological ordering in `fetchDataService` is a preparatory step that assumes future path_t95 computation, but that follow‑on step hasn’t been wired up.

4. **Retrieval horizons are currently query‑led, not lag‑led.**
   - How far back we go is governed by:
     - The DSL window/cohort range, or
     - A fixed last‑7‑days default for implicit baselines,
   - rather than by dynamically derived `t95` / `path_t95` horizons.

---

## 8. Suggested Next Steps (Non‑binding)

_This section is descriptive, not an implementation plan._

1. **Wire up `computePathT95` and `applyPathT95ToGraph` in the batch fetch flow**, immediately after window slices have t95 computed, so `p.latency.path_t95` is available for planner and refetch decisions.
2. **Introduce a cohort retrieval‑horizon helper** that:
   - Given `path_t95` for an edge and today’s date, computes a “cohort look‑back” bound.
   - Clamps cohort DSL ranges (for retrieval) to that horizon while keeping the original DSL for UI semantics.
3. **Implement the planner’s staleness logic** as specified in the window fetch planner docs, consuming `t95` / `path_t95` and `retrieved_at`, and exposing:
   - Per‑item `effectiveT95`.
   - Outcome states: covered stable / covered stale / not covered.
4. **Align cohort refetch policy with the new horizon helper**, so `replace_slice` does not automatically imply “fetch full -90d” unless the lag statistics justify it.

Until those steps are implemented, the live system will continue to:

- Perform sound but **edge‑local** maturity/staleness checks using `t95`, and  
- Fetch cohort data for the **full DSL range** whenever a cohort refetch is triggered.


