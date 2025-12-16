## Cohort completeness fix (A‑anchored semantics + t95 tail pull)

**Status**: Draft (implementation pending)  
**Last updated**: 16-Dec-25  
**Owner**: DagNet  
**Context**: `project-lag` completeness semantics regression for downstream cohort edges (e.g. “73% complete” under `cohort(-30d:-1d)` on a trailing edge despite long upstream delay).

### Problem statement

In **cohort mode** (`cohort(A, start:end)`), edge latency “completeness” is intended to answer:

- **For a given edge X→Y, among people who entered at the anchor A within the cohort date range, how complete is the X→Y transition by the query date?**

In other words, cohort completeness should be **A‑anchored** (unconditional on reaching X), not “post‑X”.

### Current behaviour (wrong for cohort semantics)

Today, downstream edge completeness is computed using an edge-local maturity model:

- Construct an “effective age at edge” by subtracting an estimate of A→X delay from the anchor age:  
  `effective_age ≈ max(0, anchor_age − anchor_median_lag(A→X))`
- Evaluate the **X→Y** lag CDF at `effective_age` and n‑weight average across cohort-days.

This yields a value that is best interpreted as:

- “How mature is X→Y **given** a model of when users reached X?”

Because it is computed against an edge-local lag distribution and does not explicitly represent the A‑anchored journey mass that has not yet reached X, it can produce **implausibly high** values (e.g. ~0.73) for trailing edges in short cohort windows.

### Corrected definition (cohort mode)

For **cohort mode only**, define downstream edge completeness as:

- **A→Y maturity**: “Of eventual X→Y successes originating from A‑anchored cohorts in the date range, what fraction should have occurred by the query date?”

Operationally, that means modelling the time-to-success for the edge as a **path‑anchored** random variable:

- `T(A→Y) = T(A→X) + T(X→Y)`

and evaluating completeness directly on **raw anchor age** (days since A), not “age since reaching X”.

This change makes “completeness on a trailing edge” behave like a cohort‑anchored quantity: if many of the A‑anchored cohort members haven’t even reached X, the implied A→Y maturity cannot be arbitrarily high.

### How we compute A→Y (using existing LAG machinery)

We already have the ingredients needed for A→Y:

- **A→X** delay series from Amplitude 3‑step funnels:
  - `anchor_median_lag_days[]`
  - `anchor_mean_lag_days[]`
- **X→Y** leg delay series:
  - `median_lag_days[]`
  - `mean_lag_days[]`
- Existing lognormal fitting and sum-approximation (moment matching).

Computation outline:

- Fit a lognormal for A→X (from anchor lag median/mean aggregates).
- Fit a lognormal for X→Y (from edge lag median/mean aggregates).
- Approximate `A→Y` as a lognormal using moment-matching of the sum (Fenton–Wilkinson).
- Evaluate the A→Y CDF at each cohort-day’s **raw anchor age**, n‑weight average, yielding cohort completeness for the edge.

### Tail “pull” / one-way constraints using t95 signals (required)

The median/mean lag data for cohort windows can be **biased young** under censoring/immaturity (by construction). Therefore, completeness must incorporate authoritative tail information to avoid thin-tail fits that overstate maturity.

We apply the same principle already used elsewhere in LAG completeness:

- **One-way tail constraint only**: tail constraints may **increase** σ (fatter tail), but must never decrease σ (thinner tail).
- The constraint is expressed as: “the implied t95 of the fitted distribution must be at least the authoritative t95”.

#### Which t95 is authoritative for cohort completeness

For downstream edges in cohort mode, we consider two tail signals:

- **Edge-local t95**: `t95(X→Y)` (edge horizon)
- **Path-level t95**: `path_t95(A→Y)` (journey horizon)

Rules:

- The **A→Y completeness distribution** is pulled using **`path_t95(A→Y)`** when available.
  - If `path_t95_overridden` is true on the graph edge, that value is authoritative.
  - Otherwise, use the best available computed estimate (e.g. topo DP or anchor+edge convolution estimate, depending on the current LAG pass).
- The **X→Y leg distribution** continues to be pulled using **`t95(X→Y)`** when needed.

Optional (recommended for robustness):

- The **A→X anchor-delay distribution** may be pulled using a node-level `path_t95(A→X)` (the path t95 to reach node X) when available, again as a one-way σ increase.

These constraints prevent cohort-mode completeness from being dominated by biased-young medians/means when the tail signal clearly implies a longer horizon.

### Fallbacks (explicit and logged)

If we cannot compute an A→Y distribution with acceptable inputs (e.g. missing anchor lag arrays, insufficient converters for fits, invalid moments), we fall back in a controlled way:

- Fallback 1: retain the existing “subtract A→X median then evaluate X→Y” computation, but log it explicitly as a **conditional/post‑X fallback**.
- Fallback 2: if even that cannot be computed robustly, use configured defaults (existing LAG behaviour), again with explicit logging so it is visible in session logs.

### Observability requirements

Session logs for cohort completeness should include, at minimum:

- Whether completeness was computed as **A→Y path‑anchored** vs **fallback conditional**.
- The authoritative t95 used for each tail pull (edge vs path).
- Whether the tail constraint was applied (and the before/after σ values).
- The cohort age range used for evaluation (raw ages for A→Y; adjusted ages only for fallback).

### Expected behavioural change (qualitative)

For trailing edges under `cohort(-30d:-1d)`:

- The current computation can yield high values (e.g. ~0.73) because it is effectively measuring post‑X leg maturity on (age − A→X median).
- After this fix, completeness is measured on A→Y time-to-success with `path_t95` tail pull, so it should **drop materially** when upstream delay is substantial, and should no longer present a trailing edge as “mostly complete” in a cohort window where much of the A‑anchored mass has not yet plausibly traversed the upstream path.


