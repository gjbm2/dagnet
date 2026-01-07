## Latency standard deviation (lag stdev) – capability plan

**Status:** Proposal  
**Created:** 18-Dec-25  
**Owner:** DagNet LAG pipeline / analytics  

### 0. Why this document exists

We currently expose latency summary scalars such as `median_lag_days`, `mean_lag_days`, `t95`, `path_t95`, and `completeness`, but we do not expose any measure of dispersion for lag (for example a standard deviation).

This is an odd omission because:

- The LAG pipeline already reasons over distributions and maturity.
- In cohort/window views we already have cohort date slices, which gives a straightforward, empirical way to estimate lag variability without making binomial or standard error assumptions.
- When we display latency or use it in “between-step” reasoning (funnels and path analyses), a dispersion signal would correctly communicate imprecision.

This is not a “quick fix” because it touches schema, storage, rendering, and analysis outputs.

### 1. Scope and non-goals

**In scope**

- Define and compute a “lag dispersion” scalar alongside existing latency summaries.
- Persist it in the same place as existing latency outputs (edge probability parameter packs and graph edges).
- Surface it in the UI latency beads (edge-level).
- Make it available to analytics outputs that already surface lag means/medians.

**Non-goals (for this document)**

- No change to the fundamental lag model choice (lognormal vs alternative distributions).
- No attempt to produce full uncertainty intervals for lag; only a single dispersion scalar.
- No new time-series view; this remains a scalar enhancement.

### 2. Terminology and user-facing intent

We need to be explicit about what “latency stdev” means to the user:

- It is a measure of the spread of observed conversion delays within the selected evidence window/cohort view.
- It is not a confidence interval for the mean; it is not a standard error.
- It should help the user distinguish “tight and predictable lag” from “wide and noisy lag”.

For display, the UI can render “median lag 5d ± 1d” or similar, but this document intentionally does not prescribe exact formatting beyond requiring UK-friendly units and labels.

### 3. Data availability: why we can do this empirically

Even without probabilistic assumptions, we can estimate lag dispersion because in cohort/window views we already have:

- Cohort date slices (the cohort start dates).
- Per-slice lag summaries used to compute the displayed median/mean lag.

There are two common representations we may have available (depending on the edge and data source):

- A lag distribution fit representation (parameters of a fitted distribution).
- Per-cohort lag summaries (median and mean lag per cohort day) plus their weights (conversions per cohort day).

The second representation is sufficient to estimate a meaningful spread without inventing additional modelling assumptions.

### 4. Proposed definition (minimum viable)

We define two possible dispersion scalars; implement exactly one first:

- **Option A (preferred):** `lag_stdev_days` as the weighted standard deviation of per-cohort `mean_lag_days` values, weighted by realised conversions (`k`) in each cohort slice included in the view.
  - Rationale: aligns with the existing “mean lag days” output and produces a dispersion with clear units (days).
  - Practicality: uses data we already aggregate; does not require raw per-conversion delays.

- **Option B:** `lag_stdev_days` as the standard deviation implied by the fitted lag distribution (for example a lognormal fit), computed from the fit parameters.
  - Rationale: more internally consistent with the distribution used for completeness/t95.
  - Risk: depends on fit quality; if fit is biased, this stdev reflects the model more than the data.

Recommendation: start with Option A if the per-cohort arrays and weights exist robustly; otherwise use Option B as a fallback only where the fit exists and is trusted.

### 5. Window vs cohort sensitivity

Lag dispersion must be computed for the exact same evidence scope as the other lag scalars:

- In **window()** view: aggregate only cohorts (or events) that fall within the selected window.
- In **cohort()** view: aggregate only cohorts whose cohort start date is within the cohort range.

This is the same sensitivity requirement as completeness; any “merged file window” approach that ignores the current DSL scope will produce misleading dispersion and must be avoided.

### 6. Storage and schema impact (modest but real)

We will add one new field under latency:

- `p.latency.lag_stdev_days` (name to be confirmed; consistent naming is required)

This impacts:

- Parameter pack shape written to files (values under `p.latency`).
- Graph edge probability shape in-memory.
- Any JSON schema and UI types that treat latency as a known set of keys.
- Python graph builder extraction (so analytics runners can see the value).

Compatibility:

- Old packs will not have the field; UI should treat missing as “unknown” and not display ±.
- No back-compat aliasing should be introduced; new field only.

### 7. Pipeline changes (where the computation belongs)

This capability must be computed in the same canonical LAG path as the other latency fields, not in ad-hoc UI code.

The computation should occur alongside existing latency aggregation:

- When we aggregate cohorts and compute `median_lag_days` / `mean_lag_days`, also compute `lag_stdev_days` using the chosen definition.
- Ensure the topo pass (which computes `path_t95`) does not inadvertently “rewrite” or lose the lag stdev value; it should be carried through as an edge-level stat.

Key requirement:

- The computation must be fed the same cohort selection implied by the current DSL (window vs cohort), consistent with the unification plans in project-lag docs.

### 8. Param packs and graph propagation

Once computed, `lag_stdev_days` must be propagated consistently:

- Stored in parameter packs under the edge probability parameter’s `latency` section.
- Written onto graph edges as part of the LAG enhancement pass so rendering and analysis see the same value.
- Ensured to survive scenario composition and layering (current/base/live scenarios), without any per-menu duplication.

### 9. UI: latency edge beads

We should update the latency bead rendering to include the dispersion signal:

- If `lag_stdev_days` is present, display “±” information in a compact way.
- If absent, render exactly as today (no placeholder noise).

This is a display-only change; no computation belongs in UI components.

### 10. Analytics: how it should be exposed

Analytics outputs that already surface lag should be able to include the new field as an optional metric:

- For funnel and path analyses, expose `lag_stdev_days` at the same conceptual grain as the lag values being displayed.
- For “between-step” (segment) lag, this is not automatically derived by weighting means; it requires variance propagation.
  - A future enhancement can compute segment stdev using second moments if we also have per-edge lag variance and a reasonable independence assumption.
  - This document does not require segment stdev in the first iteration; it requires edge-level stdev to be available.

### 11. Testing impact

This work requires updating and/or adding tests across layers:

- LAG computation tests:
  - Verify `lag_stdev_days` is computed deterministically for both window() and cohort() scoped inputs.
  - Verify it changes when the DSL scope changes (window/cohort sensitivity).
- Rendering tests (if present):
  - Verify the latency bead displays ± only when the field exists.
- Analytics runner tests:
  - Verify the new field is passed through when present and omitted when absent.

### 12. Rollout plan (incremental, low risk)

Suggested order of implementation:

- Add computation in the canonical LAG enhancement path and store on graph edges.
- Add persistence into param packs (write + read path).
- Add UI bead display behind “field exists” gating.
- Add analytics exposure for analyses that already show lag values.
- Add/adjust tests as required.

### 13. Open decisions to resolve before implementation

- Which definition is authoritative for v1: per-cohort empirical spread vs distribution-implied spread.
- Naming and placement: confirm `lag_stdev_days` under `p.latency`.
- Weighting choice for empirical spread: weight by realised conversions (`k`), by cohort population, or something else.
- Whether cohort-day slices with `k = 0` should be excluded from the dispersion estimate (likely yes, to avoid noise dominating the estimate).






