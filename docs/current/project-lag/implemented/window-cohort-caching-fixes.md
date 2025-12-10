## Window & Cohort Caching Fixes – Implementation Plan

### 1. Scope and Goals

This document describes the remaining work required to bring the **caching and merge layer** for `window()` and `cohort()` slices into full alignment with the LAG design in `design.md` (especially §3.3, §4.7.3, §4.8).

The focus is on:

- Making **fetch‑from‑source** behaviour maturity‑aware for latency edges.
- Ensuring **write‑side merges** for `window()` and `cohort()` slices:
  - Correctly combine raw evidence over time.
  - Correctly recompute **forecast** and latency scalars at retrieval/merge time.
- Ensuring query‑time code does **not** have to “patch up” missing forecast; query‑time should only:
  - Select the right slices.
  - Aggregate raw evidence.
  - Apply the statistical enhancement layer to produce evidence and blended `p.mean`.

This is an implementation plan: it specifies *what* needs to change and *where*, but not the concrete code.

---

## 2. Current Behaviour vs Design – Caching and Merge Gaps

### 2.1 Window() slices – caching and merge

**Design intent (summary):**

- `window()` slices for latency edges:
  - Serve as the **pinned DSL baseline** for `p.forecast` and slice‑level latency stats.
  - Should be merged over time so that, for a given context/case family, the param file contains a **single canonical window slice** whose:
    - `dates[]`, `n_daily[]`, `k_daily[]` cover the full effective coverage.
    - `window_from` / `window_to` and `sliceDSL` reflect the union of all covered dates in absolute UK date format.
- Maturity‑based logic:
  - `maturity_days` controls how far back data is considered “immature”.
  - Immature portions of the window must be re‑fetched; mature portions may be reused.

**Current implementation (window mode):**

- `mergeTimeSeriesIntoParameter` now:
  - For a given context/case family:
    - Merges existing and new daily data **by date** into a single canonical value entry.
    - Existing dates are preserved, new dates overwrite or extend coverage.
    - `window_from` / `window_to` are updated to earliest/latest merged dates.
    - `sliceDSL` is canonicalised to a `window(<earliest>:<latest>)[.context(...)]` form.
- However:
  - There is **no maturity‑aware refetch policy** driving *which* dates to fetch.
  - The merge does **not** currently recompute forecast or latency scalars; any `forecast` or latency already on the slice are not recalculated in TypeScript after merging.
  - `shouldRefetch` as sketched in `design.md` is **not implemented**; fetches are driven by gap detection and existing staleness heuristics only.

### 2.2 Cohort() slices – caching and merge

**Design intent (summary):**

- `cohort()` slices:
  - Are holistic for a given anchor and date range; they are not incrementally merged by date in the same way as windows.
  - Should be **replaced** as a whole when:
    - Immature cohorts still exist.
    - Or the slice is deemed stale.
  - The merged slice’s `sliceDSL` and `cohort_from` / `cohort_to` should reflect the *union* of cohorts actually present after merges.

**Current implementation (cohort mode):**

- For a context/case family in cohort mode:
  - All existing cohort‑mode values are dropped.
  - A new single value entry is written with:
    - Daily arrays from the new fetch.
    - `cohort_from` / `cohort_to` taken from the fetch window.
    - Canonical `sliceDSL` using a cohort form.
- However:
  - There is no `shouldRefetch` logic yet; we always “replace slice” when we write new cohort data rather than deciding between “use cache” and “replace slice” based on maturity.
  - Cohort merge does **not** recompute any forecast baseline when there is no window data; it simply trusts that `p.forecast` either comes from existing window slices or remains absent.

### 2.3 Forecast recomputation and maturity

**Design intent (summary):**

- `p.forecast` is:
  - A **retrieval‑time** scalar, derived from **mature cohorts** in window slices for a pinned DSL.
  - Conceptually independent of the query window used later at query time.
- Any merge of window slices must therefore:
  - Re‑evaluate the mature portion of the merged window.
  - Recompute `p.forecast` (and associated latency scalars) for the merged slice.

**Current implementation:**

- Forecast values are currently:
  - Produced in the upstream LAG/forecast pipeline and written onto individual window slices as they are fetched.
  - At query time, `addEvidenceAndForecastScalars`:
    - Finds the **most recent matching window slice** for a context/case family.
    - Copies its `forecast` scalar to the aggregated parameter data.
- After the new canonical merge:
  - We **do not yet recompute `forecast`** at merge time.
  - We also do not recalculate window‑level latency stats after merging.
  - Whether `p.forecast` actually reflects mature‑only data remains entirely a property of the upstream fetch; the merge neither improves nor corrects it.

---

## 3. Required Fixes – By Responsibility

### 3.1 Maturity‑aware refetch policy (`shouldRefetch`)

**Goal:** Introduce an explicit, testable **refetch policy** that is used for all fetch‑from‑source operations on latency edges, so that immaturity rules, not just gaps, determine what to pull.

Planned steps:

- Introduce a **small policy helper** in the services layer (either a new module or a section within `dataOperationsService`):
  - Inputs:
    - The current slice (window or cohort) for a given slice family.
    - The edge config (at least `latency.maturity_days` and potentially `latency.anchor_node_id`).
    - The graph (where total‑path maturity is needed).
  - Outputs (as described in `design.md`):
    - For non‑latency edges: “gaps only”.
    - For `window()` with latency: a “partial” refetch window defined by a maturity cut‑off date.
    - For `cohort()`: either “replace slice” or “use cache” based on whether any cohorts are still immature.

- Integrate this helper into the **versioned fetch** pathways:
  - `getFromSource` and `getFromSourceDirect` should:
    - Inspect existing slices in the parameter file for the target family.
    - For each candidate slice, call the refetch helper to decide:
      - “gaps only” → current incremental behaviour.
      - “partial” → fetch only the immature portion of the requested window.
      - “replace slice” → drop the existing cohort slice and fetch a new one.
      - “use cache” → skip the external fetch entirely.

- Update tests to verify:
  - Refetch decisions for representative window and cohort examples.
  - That the fetch layer fetches only immature windows for latency edges and does not re‑pull mature segments unnecessarily.

### 3.2 Forecast and latency recomputation on window() merge

**Goal:** After any merge of window slices for a latency edge, recompute `p.forecast` and slice‑level latency stats on the canonical merged value, so that param files remain self‑consistent and graph‑level forecast selection can remain simple.

Planned steps:

- Extend the **merge options** for window mode so that `mergeTimeSeriesIntoParameter` has access to:
  - The relevant latency configuration (`maturity_days`, `anchor_node_id`).
  - Optionally, any raw lag arrays or summary statistics provided by the upstream LAG service for the new fetch.

- Within `mergeTimeSeriesIntoParameter` (window mode):
  - Once the new canonical merged slice has been built (merged dates and daily data):
    - Treat the merged series as the authoritative time series for that slice family.
    - Invoke the statistical enhancement logic (or a light wrapper around it) to:
      - Recompute a **mature‑based forecast baseline** for the merged window.
      - Recompute `median_lag_days`, `mean_lag_days`, `t95`, and `completeness` for that baseline.
    - Write these scalars back onto the merged value:
      - `forecast` updated to the new baseline.
      - `latency` summary fields updated accordingly.

- Read‑time forecast selection (`addEvidenceAndForecastScalars`) can then remain simple:
  - It continues to select the “best” matching window slice by recency and context.
  - It no longer needs to worry about whether that slice’s forecast is stale relative to earlier slices in the file; the merge will have normalised them.

### 3.3 Cohort() slice replacement and forecast fallback

**Goal:** Make cohort slice replacement maturity‑aware and, where required by the design, support a fallback for `p.forecast` when window baselines are not available.

Planned steps:

- Leverage the refetch policy from 3.1 for **cohort slices**:
  - Only perform a full replacement fetch when:
    - Immature cohorts exist.
    - Or other staleness conditions are met.
  - Otherwise, use cache and avoid unnecessary calls to the data source.

- For `p.forecast`:
  - When matching window slices exist, continue to use them as the baseline as today.
  - When no window slices exist but cohort data is available:
    - Either:
      - Implement the cohort‑based forecast fallback described in the design (using cohort ages and lag distribution), and store that as a slice‑level forecast.
      - Or, if that extension is deferred, explicitly mark forecast as unavailable for such edges rather than leaving stale or misleading values.

### 3.4 Canonical `sliceDSL` generation and anchor handling

**Goal:** Ensure that `sliceDSL` is always a **canonical identifier** consistent with the design, and that anchor information for cohorts comes from the latency config, not ad‑hoc DSL fragments.

Planned steps:

- For window mode merges:
  - Continue to generate `sliceDSL` in the `window(<earliest>:<latest>)[.context(...)]` form using UK dates.
  - Ensure context and case dimensions are normalised (sorted, deduplicated) so that the same family always yields the same `sliceDSL`.

- For cohort mode merges:
  - Source the anchor from the **edge’s latency configuration** (`anchor_node_id`), falling back to any existing canonical representation if needed.
  - Generate `sliceDSL` in the `cohort(<anchor>,<earliest>:<latest>)[.context(...)]` form, again using UK dates and normalised context/case dimensions.

### 3.5 Maturity‑aware fetch and merge end‑to‑end tests

**Goal:** Validate the full lifecycle: fetch → merge → recompute forecast/latency → query → evidence/blended probability.

Planned steps:

- Extend or add integration tests that:
  - Start from a param file with a known window/cohort slice and latency configuration.
  - Simulate:
    - An initial fetch that yields partially mature data.
    - A second fetch after some days have elapsed, with more mature data.
  - Assert that:
    - The refetch policy chooses the correct immature segments to refresh.
    - `mergeTimeSeriesIntoParameter` produces a single canonical merged slice with updated coverage.
    - `forecast` and latency summary fields on that slice reflect the merged, more mature data.
    - Query‑time evidence and blended `p.mean` behave as expected when querying before and after the second fetch.

---

## 4. Non‑Goals and Deferred Work

The following items are **not** in scope for this fixes plan, but are worth noting explicitly:

- Changing the underlying LAG maths beyond what is already specified in `design.md`.
- Introducing UI‑level maturity visualisations beyond what the existing latency fields support.
- Retrofitting all historical param files to the canonical `sliceDSL` format; the focus is on ensuring that **future merges** produce canonical forms, and that existing files remain readable.

---

## 5. Summary

The current implementation now provides:

- Correct **query‑time** evidence and blended `p.mean` semantics for both `window()` and `cohort()` queries.
- Correct cross‑slice forecast selection at query time.
- Canonicalised write‑side merges for window and cohort slices at the raw evidence level.

The remaining work described here is focused on:

- Making **fetch and merge** fully maturity‑aware.
- Ensuring that **`p.forecast` and latency scalars are recomputed** at retrieval/merge time in accordance with the design.
- Treating `sliceDSL` as a canonical coverage identifier rather than a loose DSL fragment.

Once these fixes are in place, the caching layer will match the design’s expectations end‑to‑end, and query‑time code will no longer need to compensate for missing or inconsistent retrieval‑time semantics.




