## Design Delta – LAG Window & Cohort Caching vs Current Implementation

### 1. Scope

This note documents where the **current implementation** of LAG window/cohort caching **still diverges** from the design in `design.md` and `cohort-window-fixes.md`, specifically around:

- **Write‑side caching and merge policy** for `window()` and `cohort()` slices.
- **Canonicalisation of `sliceDSL`** and date bounds on disk.

It is deliberately narrow: only surfaces that are **not yet implemented** or are implemented differently from the design are listed here.

---

## 2. What *is* implemented (and matches design)

These items are already implemented and verified by `sampleFileQueryFlow.e2e.test.ts`:

- **Evidence semantics**
  - `window()` evidence is computed **only from dates inside the requested window** (narrower and super‑range cases).
  - `cohort()` evidence is computed **only from cohorts inside the requested cohort window**, with exact matches allowed to fall back to header `n`/`k`.
  - `p.evidence.mean` / `p.evidence.stdev` are always derived from `n`/`k` before UpdateManager runs.

- **Forecast semantics**
  - `p.forecast.mean` for `cohort()` queries is derived from the **best matching `window()` slice** for the same context/case dimensions.
  - Forecast remains **independent of the evidence window** (narrow cohort or window queries do not change `p.forecast.*`).

- **Read‑time slice isolation and aggregation**
  - `getParameterFromFile` correctly distinguishes `cohort()` vs `window()` family when filtering slices.
  - Aggregation builds a combined time series from all relevant `values[]` entries, with:
    - Newer fetches overriding older data per date.
    - Multi‑slice (MECE) aggregation only when query + data actually require it.
  - Cohort aggregation uses `aggregateCohortData` to combine per‑cohort arrays and then filters to the `cohort(start:end)` window.

The **observable semantics** for evidence and forecast, as exercised by the E2E tests, now match the design.

---

## 3. Design elements that are **not yet implemented**

This section lists design elements that are **explicitly described in `design.md` but are not yet fully realised in code**.

### 3.1 Canonical `sliceDSL` and on‑disk merge for `window()` slices

**Design (design.md §3.3, §4.7.3):**

- `sliceDSL` for `window()` slices should use **absolute dates**:
  - Format: `window(<abs_start>:<abs_end>)[.context(...)]`.
  - Acts as a **canonical identifier** for that slice (anchor + absolute range + context).
- **Merge policy (latency edges):**
  - For `window()` with `legacy maturity field > 0`:
    - Always re‑fetch **immature** portion of the window.
    - Keep cached data for mature dates.
    - **On merge**:
      - Replace data for dates in the immature window.
      - Keep cached data for mature dates.
      - **Update `sliceDSL` bounds** to reflect actual coverage: `window(<earliest>:<latest>).context(...)`.
- For `window()` with `legacy maturity field = 0`:
  - Incremental gaps are allowed, but merged coverage should still be reflected in `sliceDSL`.

**Current implementation:**

- `mergeTimeSeriesIntoParameter` is **append‑only**:
  - Each fetch appends a new `ParameterValue` entry:
    - New `window_from` / `window_to`.
    - New `dates[]`, `n_daily[]`, `k_daily[]`.
    - New `data_source.retrieved_at`.
    - `sliceDSL` is not updated to a canonical union; it is preserved per‑fetch.
  - Existing `values[]` entries are **not mutated or merged**.
- There is **no write‑side consolidation** of multiple window fetches into a single canonical slice:
  - We do not:
    - Merge overlapping `dates[]` onto an existing window slice.
    - Replace immature date ranges in‑place.
    - Update `sliceDSL` to reflect the union of all coverage.

**Net effect:**

- On **read**, aggregation gives the right behaviour (evidence/forecast are correct).
- On **disk**, the param file retains a **trail of appended window slices** rather than the single canonical slice the design calls for.

### 3.2 Cohort slice merge and `sliceDSL` update

**Design (design.md §4.7.3 “Cohort slice”):**

- For `cohort()` slices:
  - `sliceDSL` includes **anchor node_id** and absolute dates:
    - Format: `cohort(<anchor>,<abs_start>:<abs_end>)[.context(...)]`.
  - Merge policy:
    - Cohort data is holistic for a given anchor+range.
    - **On merge**:
      - Replace the entire slice when immature cohorts or staleness rules require a refresh.
      - **Update `sliceDSL` bounds** to reflect actual coverage after merge.

**Current implementation:**

- Cohort fetches are also appended as new `values[]` entries.
- There is **no implementation that replaces an existing cohort slice in‑place** based on maturity or staleness.
- `sliceDSL` for cohort slices is not updated to reflect extended coverage (e.g., from `1-Sep-25:30-Nov-25` to `1-Sep-25:1-Dec-25` after a later fetch).

**Net effect:**

- The **graph** sees correct cohort evidence/forecast via aggregation.
- The **file** continues to accumulate multiple cohort slices rather than one canonical “current” cohort slice per anchor/context.

### 3.3 Maturity‑based refetch / partial merge decisions

**Design (design.md §4.7.3, “Window slice (CHANGED from current behaviour)” and “Cohort slice”):**

- Expected decision logic (summarised):
  - If **no latency** (`legacy maturity field` not set):
    - Use current incremental gaps behaviour.
  - For `window()` with latency:
    - Compute mature / immature split relative to “today” and `legacy maturity field`.
    - **Always re‑fetch** immature portion (recent days).
    - Merge fetch with existing data as described in 3.1.
  - For `cohort()`:
    - Compute `total_maturity` for the edge.
    - If any cohorts are immature or the slice is stale, re‑fetch and **replace** the slice.

**Current implementation:**

- We **do not yet implement** this decision table as a first‑class component.
- Fetch decisions are currently driven by:
  - `calculateIncrementalFetch` (gap detection).
  - Existing staleness heuristics.
  - But **not** by the maturity‑based split between “re‑fetch immature / reuse mature” as described in the design.

**Net effect:**

- We may:
  - Re‑fetch only gaps instead of selectively replacing immature portions.
  - Append additional slices instead of performing the designed mature/immature merge.

### 3.4 Canonical `sliceDSL` generation and update

**Design (design.md §3.3, “Key changes for window() slices” and “Key changes for cohort() slices”):**

- `sliceDSL` is intended to be a **canonical identifier**:
  - Built from **anchor + absolute date bounds + context**.
  - Updated whenever coverage changes via merge.
- Original queries belong in `data_source.full_query` only.

**Current implementation:**

- We still treat `sliceDSL` largely as:
  - A preserved DSL fragment from the fetch that created the slice.
  - A convenient way to encode context (`context(...)`) and (sometimes) window/cohort clauses.
- We do **not**:
  - Normalise `sliceDSL` on write to the canonical `window(<abs_start>:<abs_end>).context(...)` / `cohort(<anchor>,<abs_start>:<abs_end>).context(...)` forms.
  - Update `sliceDSL` when a slice’s effective coverage changes via merge (because merge is not yet implemented).

**Net effect:**

- Slice isolation works, but:
  - `sliceDSL` on disk does **not** yet serve as a unique, canonical “coverage ID” in the way the design intends.

---

## 4. Remaining work to implement the full design

This section lists the **concrete work items** required to bring the implementation into full alignment with the design for window/cohort caching and merges.

### 4.1 Implement canonical merge for `window()` slices (write‑side)

- **Extend `mergeTimeSeriesIntoParameter`** (and/or introduce a dedicated merge helper) to:
  - Given existing `values[]` and a new window fetch:
    - Identify the **canonical base slice** for this context:
      - Same context/case dimensions (`extractSliceDimensions`).
      - Same anchor semantics.
    - Apply the maturity‑based policy:
      - For non‑latency edges: merge by date (union of all dates), overwriting existing entries where new data exists.
      - For latency edges:
        - Compute mature vs immature split relative to `legacy maturity field`.
        - Replace immature dates from the new fetch.
        - Keep mature dates from the cache.
    - Produce a single merged slice:
      - `dates[]`, `n_daily[]`, `k_daily[]` represent the union of coverage, with latest data per date.
      - `window_from` / `window_to` updated to `<earliest>:<latest>`.
      - `sliceDSL` updated to `window(<earliest>:<latest>)[.context(...)]`.
  - Append‑only entries remain possible for audit/history, but the design prefers the merged slice to be the **active** one for future reads.

### 4.2 Implement canonical merge/replace for `cohort()` slices

- Introduce a merge path for `cohort()` slices that:
  - Identifies the canonical cohort slice for a given anchor/context.
  - Uses the maturity rules (total_maturity, immature cohorts, staleness) to decide:
    - **Replace entire slice** vs use cache.
  - When replacing:
    - Overwrite `dates[]`, `n_daily[]`, `k_daily[]` (and associated latency arrays).
    - Update `cohort_from` / `cohort_to` and `sliceDSL` to reflect new coverage.

### 4.3 Integrate maturity‑based refetch decisions into fetch layer

- Implement `shouldRefetch(slice, edge, graph)` (as sketched in `design.md`) and wire it into:
  - `fetchDataService.itemNeedsFetch` / `getItemsNeedingFetch`.
  - The “fetch from source” code paths (`getFromSource`, `getFromSourceDirect`).
- Ensure decisions are:
  - Aware of `latency.legacy maturity field` and `total_maturity` where applicable.
  - Used to decide between:
    - “gaps only” incremental fetch.
    - Partial immature-window refresh for `window()`.
    - Full slice replacement for `cohort()`.

### 4.4 Canonicalise `sliceDSL` on write and after merge

- Update `mergeTimeSeriesIntoParameter` and any cohort merge logic to:
  - Construct `sliceDSL` in the **canonical forms**:
    - `window(<abs_start>:<abs_end>).context(...)`
    - `cohort(<anchor>,<abs_start>:<abs_end>).context(...)`
  - Ensure:
    - All absolute dates are in the agreed UK format (`d-MMM-yy`).
    - Context/case dimensions are normalised (sorted, consistent).
- Cleanly separate:
  - Canonical `sliceDSL` (coverage + context ID).
  - `data_source.full_query` (original DSL for provenance).

### 4.5 Tests and migration safety

- Add dedicated tests under `src/services/__tests__/` to cover:
  - Window merge over time (mature+immature split, sliceDSL update).
  - Cohort slice replacement and sliceDSL update.
  - Maturity‑based decisions leading to:
    - “gaps only”, “partial”, or “replace_slice” behaviours.
- Migration considerations:
  - Ensure that existing param files with append‑only history are still readable.
  - When writing updated files after a merge, maintain backward‑compatible fields (`values[]`, `window_from/to`, `cohort_from/to`) while enforcing the new canonical `sliceDSL` format.

---

## 5. Summary

The **read‑side** behaviour for `window()` and `cohort()` evidence/forecast now matches the LAG design and is enforced by the E2E tests.  

The **remaining gap** is entirely on the **write‑side caching and merge policy**:

- We do not yet implement canonical merge/replace of `window()` and `cohort()` slices or update `sliceDSL` and date bounds on disk to reflect effective coverage.
- We also do not yet drive refetch/merge decisions from the maturity‑based logic in `design.md`.

Implementing the items in §4 will close this gap and bring the caching layer fully into line with the original design.




