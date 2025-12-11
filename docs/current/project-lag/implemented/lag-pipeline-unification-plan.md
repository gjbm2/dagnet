## LAG Pipeline Unification – Single Code Path Implementation Plan

### 0. Context and Goal

This plan describes how to converge all LAG (Latency‑Adjusted Graph) computation onto **one** implementation path, in line with the statistical design in `lag-statistics-reference.md` and the rendering refactor in `lag-rendering-fix.md`.

Today there are effectively two competing paths:

- A **file‑level path** in the window aggregation and data operations services that:
  - Recomputes latency summaries (including completeness and forecast) at parameter merge time.
  - Uses those values inside `addEvidenceAndForecastScalars` to derive a blended mean before the graph‑level LAG pass runs.
- A **graph‑level path** in the statistical enhancement service that:
  - Aggregates cohorts for the current DSL window/cohort.
  - Fits lag distributions, computes completeness, inbound‑n, and blended probabilities.
  - Writes LAG results to `edge.p.*` on the graph.

The design documents intend the **graph‑level statistical enhancement** to be the *only* place where LAG statistics (completeness, t95, p∞, blended p.mean) are computed. This plan removes the file‑level LAG logic and routes all fetch flows through a single graph‑level path, using `fetchItems` as the canonical entry point.

Non‑goals:

- Do not change DSL semantics (window vs cohort, context, case).
- Do not change the mathematical definitions of completeness, t95, or the blend formula.
- Do not change how rendering consumes `edge.p.*`, beyond benefiting from more consistent stats.

---

### 1. Architectural Decision – Canonical Entry Point

**Objective:** Treat `fetchItems` in `graph-editor/src/services/fetchDataService.ts` as the **single canonical Stage‑2 (stats) execution path** that:

1. Runs per‑item fetch/merge (Stage‑1) via `dataOperationsService` as today.
2. Builds the LAG `paramLookup` and derives the LAG cohort window from the current DSL.
3. Runs the statistical enhancement pass (`enhanceGraphLatencies`) once, using that lookup and cohort window.
4. Applies the resulting LAG values (latency stats and blended means) back to the graph via `UpdateManager`.

Implementation steps (code‑level, prose only):

1. In `fetchDataService.ts`, refactor `fetchItem` so that it:
   - Matches the current public signature used by hooks/components.
   - Immediately wraps its single `FetchItem` into an array and calls:
     - `fetchItems([item], optionsWithOnProgress, graph, setGraph, dsl, getUpdatedGraph)`.
   - Does not call `enhanceGraphLatencies` directly.
2. Ensure `fetchItems` remains the **only** function that:
   - Builds `paramLookup` for latency edges.
   - Computes `lagCohortWindow` from the DSL.
   - Calls `enhanceGraphLatencies` and applies its results.
3. Audit all call sites of `fetchItem` and `fetchItems` (hooks, menus, planner, window selector) to confirm:
   - No one bypasses `fetchItem`/`fetchItems` to call `dataOperationsService` + LAG manually.
   - All menu‑driven “Get from Source” and “Get from File” flows either:
     - Call `fetchItem` (which now delegates to `fetchItems([item], …)`), or
     - Call `fetchItems` directly for batch cases.

Success criteria:

- After this step, every fetch path (single item or batch, versioned or from‑file) flows through `fetchItems`, and the LAG topo pass is always invoked from there and nowhere else.

---

### 2. Narrowing Responsibilities of `mergeTimeSeriesIntoParameter`

**File:** `graph-editor/src/services/windowAggregationService.ts`

**Current issue:** `mergeTimeSeriesIntoParameter` currently performs a second, file‑level LAG computation:

- It builds cohort‑like data from all merged dates (full merged window).
- It computes aggregate lags and calls `computeEdgeLatencyStats`.
- It derives completeness and a new forecast and writes them into the parameter value’s `latency` and `forecast` fields.

This duplicates the graph‑level statistical enhancement and does not respect DSL window scoping, which leads to misleading completeness when fresh cohorts coexist with older ones.

Target role for `mergeTimeSeriesIntoParameter`:

- Merge time‑series data reliably into a canonical `values[]` entry, per slice family (context/case).
- Maintain basic slice‑level summaries such as:
  - The merged mean (k/n) for the union of dates.
  - Optional slice‑local median and mean lag arrays, if those are needed by downstream tooling.
- **Do not** attempt to:
  - Compute completeness.
  - Compute a definitive t95 for LAG.
  - Compute p∞ or any forecast used in the LAG blend.

Implementation steps:

1. In `mergeTimeSeriesIntoParameter`, leave intact the logic that:
   - Sorts and merges daily time‑series points.
   - Derives merged `dates`, `n_daily`, `k_daily`, and header `n`, `k`, `mean`.
   - Maintains any per‑day median/mean lag arrays required for diagnostics.
2. Remove the block that:
   - Constructs `CohortData[]` from `mergedDates` for LAG.
   - Calls `aggregateLatencyStats` and `computeEdgeLatencyStats`.
   - Produces `recomputedForecast` and `recomputedLatencySummary`.
   - Spreads `forecast` and `latency` from those recomputed values into the merged `ParameterValue`.
3. Ensure the merged `ParameterValue` still:
   - Contains accurate merged `n`, `k`, `mean`.
   - Contains median and mean lag arrays where appropriate as simple summaries.
   - Does **not** contain completeness or p∞ that are intended to be authoritative for LAG.
4. Update `windowAggregationService` unit tests to:
   - Assert correct merge behaviour and simple lag summaries.
   - No longer assert that completeness or LAG‑style forecast values are present or correct at the parameter level.

Success criteria:

- Parameter files remain the source of truth for raw time‑series and simple slice summaries.
- No parameter‑level completeness or LAG forecast is relied upon anywhere else in the codebase.

---

### 3. Narrowing Responsibilities of `addEvidenceAndForecastScalars`

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Current issue:** `addEvidenceAndForecastScalars` uses parameter‑level `latency.completeness` (from the merge path) together with a baseline to compute a blended mean, effectively running a second blend outside the graph‑level topo pass.

Intended role for `addEvidenceAndForecastScalars`:

- Provide complete **inputs** to the statistical enhancement path by ensuring that:
  - Evidence scalars (`evidence.mean`, `evidence.stdev`, `evidence.n`, `evidence.k`) are present on the aggregated value for the target DSL slice.
  - Forecast scalars for LAG‑enabled cohort queries are available by copying from the relevant window() slice in the same file (dual‑slice retrieval).
- Leave the actual LAG blending and all completeness use to the graph‑level pass.

Implementation steps:

1. Keep the logic that:
   - Detects whether the parameter is of probability type.
   - Parses the target DSL into constraints (including whether it is a cohort() query).
   - For exact slice matches:
     - Uses header n/k directly to populate `evidence` on the value.
   - For non‑exact window() queries:
     - Relies on upstream aggregation to have set appropriate n/k for the requested window.
   - For cohort() queries:
     - Uses cohort aggregation with a cohort window that matches the DSL to populate evidence for the requested date range.
   - For cohort() queries that require a forecast:
     - Locates the corresponding window() slice in the same file and copies its mean into a dedicated forecast scalar for that cohort slice.
2. Remove the part that:
   - Locates a baseline and reads `v.latency?.completeness` from the parameter value.
   - Calls the blend formula to derive a new mean.
   - Overwrites `values[].mean` with a LAG‑style blended mean at the parameter level.
3. Confirm that after this change:
   - The parameter’s `values[].mean` remains a simple evidence‑style mean or neutral merged mean.
   - The graph‑level statistical enhancement is solely responsible for:
     - Using completeness and population to blend evidence and forecast.
     - Writing the final blended mean to `edge.p.mean`.
4. Adjust unit tests for `addEvidenceAndForecastScalars` so that they:
   - Focus on correctness of evidence and forecast scalars as inputs.
   - Do not assert that blended means or completeness‑driven behaviour occur in this function.

Success criteria:

- `addEvidenceAndForecastScalars` becomes a pure “input preparation” step and does not make any completeness‑aware decisions.
- No code path outside the statistical enhancement service uses completeness to modify probability values.

---

### 4. Ensuring All Fetch Flows Use the Unified Path

**Files:** `graph-editor/src/services/fetchDataService.ts`, hooks, and menu components.

Objective: guarantee that **every** way of fetching data (single‑edge, batch, window selector, planner, context menus) ultimately:

1. Calls `fetchItems` with the relevant items and DSL.
2. Lets `fetchItems` coordinate:
   - Individual fetch/merge operations.
   - Build‑up of the parameter lookup for latency edges.
   - Computation of the LAG cohort window.
   - Invocation of `enhanceGraphLatencies` followed by application of results back to the graph.

Implementation steps:

1. Update `fetchItem` so that it:
   - No longer directly decides when or how to invoke LAG computations.
   - Wraps its single `FetchItem` into an array and forwards everything (options, graph, setter, DSL, `getUpdatedGraph`) to `fetchItems`.
2. In `fetchItems`:
   - Keep the existing logic that:
     - Determines which items are latency‑relevant.
     - Builds `paramLookup` for those items.
     - Parses the DSL to derive the LAG cohort window according to the design (window() vs cohort()).
     - Calls `enhanceGraphLatencies` once, passing:
       - The current graph.
       - The parameter lookup map.
       - The analysis date and the derived cohort window.
     - Applies the resulting LAG values in a single batch to the graph.
3. Review the hook `useFetchData` and the UI call sites to ensure that:
   - Context menus (“Get from Source”, “Get from File”, etc.) rely on `fetchItem` or `fetchItems`, not lower‑level services, so they automatically benefit from the unified pipeline.
   - The window selector and planner continue to call `fetchItems` directly, which already includes the LAG pass.
4. Confirm, via inspection and lightweight logging where necessary, that after a fetch from any entrypoint:
   - LAG values on graph edges (`p.latency.*`, `p.mean`, `p.evidence`, `p.forecast`) are always updated by the same topo pass.
   - No alternative code path persists or overrides these values based on param‑level completeness.

Success criteria:

- There is a single, well‑documented post‑fetch LAG update path rooted in `fetchItems`.
- All user‑visible fetch actions (batch and single‑edge) end up using this same statistical pipeline.

---

### 5. Documentation and Testing Alignment

Documentation updates:

1. In `docs/current/project-lag/implemented/design.md`:
   - Add a short subsection under the LAG implementation section clarifying:
     - That statistical enhancement (lag fitting, completeness, inbound‑n, and blending) is centralised in the graph‑level pass.
     - That `fetchItems` is the canonical post‑fetch entrypoint for triggering this pass.
2. In `docs/current/project-lag/lag-rendering-fix.md`:
   - Optionally add a note tying the unified statistical pipeline to the unified rendering pipeline:
     - Rendering consumes only graph‑level LAG outputs and does not inspect param‑level completeness or blended probabilities.

Testing strategy (described in words only):

1. Extend the existing LAG stats integration tests to:
   - Cover both window() and cohort() modes with completeness scoped to the query window.
   - Include a case matching the problematic edge where:
     - Cohorts are young, with `k = 0`, and path‑level t95 is significantly larger than cohort ages.
     - Expected completeness is low and blended p.mean remains close to forecast.
2. Add end‑to‑end tests that:
   - Run a versioned fetch from a menu for a latency edge.
   - Run an equivalent fetch via the window selector or planner.
   - Compare the resulting `edge.p.latency.*` and `edge.p.mean` to confirm that both entrypoints produce identical results.
3. Ensure there are no tests that:
   - Depend on param‑level completeness or blended means as authoritative LAG outputs.
   - Assert on LAG values before the graph‑level pass has run.

Overall success condition:

- After implementing this plan, there is **one** LAG code path:
  - Param files provide raw time‑series and simple slice summaries.
  - `fetchItems` orchestrates fetch, merge, and statistical enhancement for all flows.
  - `enhanceGraphLatencies` is the only place that computes completeness, t95, and blended p.mean.
  - Graph edges (`edge.p.*`) remain the single source of truth for all downstream consumers, including rendering and analytics.


