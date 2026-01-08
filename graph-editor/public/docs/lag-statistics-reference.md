# LAG Statistics Reference

> **Latency-Adjusted Graphs (LAG)** provide statistically rigorous probability estimates for conversion funnels where events take time to occur.

This document is the canonical reference for LAG statistics and convolution logic. It describes:

- How cohort data flows from Amplitude through to blended probabilities
- The mathematical foundations for completeness, forecasting, and blending
- How scenarios and what-if analysis interact with LAG calculations

---

## 1. Graph Structure (Example: Mixed Latency/Non-Latency Path)

```
                              PATH: A → B → C → X → Y → Z

      ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐
      │     A     │    │     B     │    │     C     │    │     X     │    │     Y     │    │     Z     │
      │  (START)  │──▶│           │───▶│           │──▶│           │───▶│           │───▶│           │
      │  anchor   │    │           │    │           │    │           │    │           │    │           │
      └───────────┘    └───────────┘    └───────────┘    └───────────┘    └───────────┘    └───────────┘
                  │                 │                 │                 │                 │
             A→B  │            B→C  │            C→X  │            X→Y  │            Y→Z  │
                  │                 │                 │                 │                 │
                  ▼                 ▼                 ▼                 ▼                 ▼

            NON-LATENCY       NON-LATENCY       1st LATENCY       2nd LATENCY       3rd LATENCY
            (no maturity)     (no maturity)     latency-tracked   latency-tracked   latency-tracked
            lag = 0           lag = 0           median ~2d        median ~8d        median ~6d


      KEY:
      ─────
      • Non-latency edges: no lag distribution (effectively instantaneous)
      • Latency edges: has lag distribution, requires cohort tracking
      • Anchor (A): furthest upstream START node, defines cohort entry dates

      NOTE (14-Dec-25): The implementation uses `latency_parameter` as the latency enablement flag.
      Conceptually, “latency-tracked” is an explicit property of an edge; the exact schema field is an implementation detail.
```

---

## 2. Amplitude Funnel Construction (A→X vs A→X→Y)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   WHY DIFFERENT FUNNEL TYPES?                                                       │
│   ───────────────────────────                                                       │
│                                                                                     │
│   For latency edges, we need to track cohorts from an ANCHOR (A) through to the    │
│   edge we're measuring. The funnel construction depends on WHERE the edge sits:     │
│                                                                                     │
│   • FIRST latency edge from anchor:  Use 2-step funnel (A → X)                     │
│   • DOWNSTREAM latency edges:        Use 3-step funnel (A → X → Y)                 │
│                                                                                     │
│   The 3-step funnel gives us BOTH the local edge lag AND the cumulative anchor     │
│   lag, which we need for computing effective ages on downstream edges.              │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

      ┌───────────────────────────────────────────────────────────────────────────────┐
      │                                                                               │
      │   2-STEP FUNNEL: A → X   (for first latency edge)                            │
      │   ───────────────────────────────────────────────                            │
      │                                                                               │
      │      ┌───────────┐                    ┌───────────┐                           │
      │      │     A     │───────────────────▶│     X     │                           │
      │      │  anchor   │      A→X edge      │           │                           │
      │      └───────────┘                    └───────────┘                           │
      │                                                                               │
      │   Amplitude returns per cohort (A-entry date):                                │
      │     • n = users entering A                                                    │
      │     • k = users reaching X                                                    │
      │     • medianTransTime = A→X median lag                                        │
      │     • avgTransTime = A→X mean lag                                             │
      │                                                                               │
      │   Maps to param file:                                                         │
      │     • n_daily[], k_daily[]                                                    │
      │     • median_lag_days[], mean_lag_days[]                                      │
      │     • (no anchor_* fields – this IS the anchor edge)                          │
      │                                                                               │
      └───────────────────────────────────────────────────────────────────────────────┘

      ┌───────────────────────────────────────────────────────────────────────────────┐
      │                                                                               │
      │   3-STEP FUNNEL: A → X → Y   (for downstream latency edges)                  │
      │   ─────────────────────────────────────────────────────────                  │
      │                                                                               │
      │      ┌───────────┐         ┌───────────┐         ┌───────────┐               │
      │      │     A     │────────▶│     X     │────────▶│     Y     │               │
      │      │  anchor   │  A→X    │  (via)    │  X→Y    │  (target) │               │
      │      └───────────┘         └───────────┘         └───────────┘               │
      │                                                                               │
      │   Amplitude returns per cohort (A-entry date):                                │
      │                                                                               │
      │     STEP 1 (A entry):                                                         │
      │       • anchor_n = users entering A                                           │
      │                                                                               │
      │     STEP 2 (A→X):                                                             │
      │       • n = users reaching X (becomes denominator for X→Y)                    │
      │       • anchor_medianTransTime = A→X median lag                               │
      │       • anchor_avgTransTime = A→X mean lag                                    │
      │                                                                               │
      │     STEP 3 (X→Y):                                                             │
      │       • k = users reaching Y                                                  │
      │       • medianTransTime = X→Y median lag (local edge)                         │
      │       • avgTransTime = X→Y mean lag (local edge)                              │
      │                                                                               │
      │   Maps to param file:                                                         │
      │     • n_daily[], k_daily[]             ← from steps 2,3 (X→Y evidence)       │
      │     • median_lag_days[], mean_lag_days[] ← from step 3 (X→Y lag)             │
      │     • anchor_n_daily[]                 ← from step 1 (A population)          │
      │     • anchor_median_lag_days[]         ← from step 2 (A→X lag)               │
      │     • anchor_mean_lag_days[]           ← from step 2 (A→X lag)               │
      │                                                                               │
      └───────────────────────────────────────────────────────────────────────────────┘

      ┌───────────────────────────────────────────────────────────────────────────────┐
      │                                                                               │
      │   DEEPER FUNNELS: A → X → Y → Z   (for 3rd+ latency edges)                   │
      │   ────────────────────────────────────────────────────────                   │
      │                                                                               │
      │      ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐        │
      │      │     A     │───▶│     X     │───▶│     Y     │───▶│     Z     │        │
      │      │  anchor   │    │           │    │  (via)    │    │ (target)  │        │
      │      └───────────┘    └───────────┘    └───────────┘    └───────────┘        │
      │                                                                               │
      │   Still constructed as a 3-step funnel, but the "via" step is the            │
      │   immediate predecessor of the target edge:                                   │
      │                                                                               │
      │     Query: funnel(A, Y, Z)                                                    │
      │       • anchor_* fields capture A→Y cumulative lag                            │
      │       • local fields capture Y→Z lag                                          │
      │                                                                               │
      │   The key insight: anchor_median_lag gives us the cumulative time             │
      │   from A to reach the SOURCE node of the edge we're measuring.                │
      │                                                                               │
      └───────────────────────────────────────────────────────────────────────────────┘

      ┌───────────────────────────────────────────────────────────────────────────────┐
      │                                                                               │
      │   NON-LATENCY EDGES IN THE PATH                                              │
      │   ─────────────────────────────                                               │
      │                                                                               │
      │   When there are non-latency edges between A and the target:                  │
      │                                                                               │
      │      ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐        │
      │      │     A     │───▶│     B     │───▶│     C     │───▶│     X     │        │
      │      │  anchor   │    │  lag=0    │    │  lag=0    │    │ (target)  │        │
      │      └───────────┘    └───────────┘    └───────────┘    └───────────┘        │
      │                                                                               │
      │   The Amplitude funnel skips non-latency intermediates:                       │
      │     Query: funnel(A, X)   ← 2-step, treating C→X as first latency edge       │
      │                                                                               │
      │   Non-latency edges are "collapsed" in the funnel – users pass through       │
      │   them effectively instantly, so they don't contribute to anchor lag.         │
      │                                                                               │
      │   For completeness calculation:                                               │
      │     effective_age = anchor_age   (no subtraction for 0-lag edges)            │
      │                                                                               │
      └───────────────────────────────────────────────────────────────────────────────┘

      SUMMARY: Which Funnel to Use?

      ┌────────────────────────────────────────────────────────────────────────────┐
      │                                                                            │
      │   EDGE POSITION                    │  FUNNEL TYPE   │  anchor_* FIELDS?   │
      │   ─────────────────────────────────│────────────────│─────────────────────│
      │   First latency edge from A        │  2-step (A→X)  │  No (this IS the    │
      │   (possibly via 0-lag edges)       │                │  anchor edge)       │
      │                                    │                │                     │
      │   Second+ latency edge             │  3-step        │  Yes (A→source lag) │
      │   (e.g., X→Y where X is latency)   │  (A→X→Y)       │                     │
      │                                    │                │                     │
      │   Non-latency edges                │  N/A           │  No cohort tracking │
      │   (latency_parameter = false)      │  (window only) │  needed             │
      │                                                                            │
      └────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Per-Edge Data from Amplitude / Param Files

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           PARAM FILE (per latency edge)                             │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────┐   │
│   │  EDGE CONFIG                                                                │   │
│   ├─────────────────────────────────────────────────────────────────────────────┤   │
│   │   DEFAULT_T95_DAYS     30                  ─── FALLBACK if no lag data      │   │
│   │   anchor_node_id       "household-created" ─── Cohort anchor (A)            │   │
│   └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────┐   │
│   │  COHORT SLICE  (cohort(A,start:end))                                        │   │
│   ├─────────────────────────────────────────────────────────────────────────────┤   │
│   │                                                                             │   │
│   │   dates[]            [16-Nov, 17-Nov, 18-Nov, ...]                          │   │
│   │   n_daily[]          [135, 77, 101, ...]           ─┐                       │   │
│   │   k_daily[]          [55, 42, 53, ...]              │── LOCAL EDGE EVIDENCE │   │
│   │   median_lag_days[]  [2, 2, 2, ...]                 │   (this edge only)    │   │
│   │   mean_lag_days[]    [2.1, 2.0, 2.2, ...]         ─┘                        │   │
│   │                                                                             │   │
│   │   anchor_n_daily[]          [200, 150, 180, ...]   ─┐                       │   │
│   │   anchor_median_lag_days[]  [5, 6, 5, ...]          │── A→(this edge) LAG   │   │
│   │   anchor_mean_lag_days[]    [5.5, 6.2, 5.1, ...]  ─┘   cumulative upstream  │   │
│   │                                                                             │   │
│   │   latency: {                                       ── EDGE-LEVEL SUMMARY    │   │
│   │     median_lag_days: 2,                                                     │   │
│   │     mean_lag_days: 2.1,                                                     │   │
│   │     t95: 4.6    (computed from μ,σ or fallback to DEFAULT_T95_DAYS)        │   │
│   │   }                                                                         │   │
│   │                                                                             │   │
│   │   (No persisted anchor_latency summary block)                               │   │
│   │   (A→source summary is derived on demand from anchor_* arrays)              │   │
│   │                                                                             │   │
│   └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────┐   │
│   │  WINDOW SLICE  (baseline window)   ── FORECAST BASIS + LAG-PRIOR INPUT      │   │
│   ├─────────────────────────────────────────────────────────────────────────────┤   │
│   │   n_daily/k_daily (mature days)      ──▶  p.forecast.mean (recomputed at query time) │   │
│   └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

NOTE (18-Dec-25): We distinguish two “window” concepts:

- **Baseline window**: the pinned/merged whole-window slice (typically ~60–90 days) stored in the param file. It stores daily arrays and lag summaries, and is the **data basis** for `p.forecast` (which is recomputed at query time).
- **Query window** (`window(start:end)` in the DSL): the user-selected X-entry cohorts whose evidence/completeness are computed by aggregating within the available window-slice daily arrays (it is not necessarily stored as its own slice).

NOTE (15-Dec-25): Amplitude conversion window (`cs`) policy:

- For `cohort()` queries: `cs` is driven by the **cohort conversion window** carried to the adapter as `cohort.conversion_window_days`.
  - Current implementation (as of 8-Jan-26): `conversion_window_days = ceil(max(path_t95 | t95 over graph))` clamped to 90 days, so cohort-mode denominators are coherent across edges within a slice.
- For `window()` queries (baseline window retrieval): we set a **fixed** `cs = 30 days` to avoid accidental censoring by provider defaults when building baseline lag summaries and derived horizons.
  - Current implementation (as of 8-Jan-26): this 30-day default is enforced in the shipped Amplitude adapter (`public/defaults/connections.yaml`), not sourced from `DEFAULT_T95_DAYS` (though both default to 30 in shipped settings).

---

## 3. Lag Distribution Fitting

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   INPUTS                                                                            │
│   ──────                                                                            │
│   median_lag_days      (from per-cohort or slice-level summary)                     │
│   mean_lag_days        (from per-cohort or slice-level summary)                     │
│   DEFAULT_T95_DAYS     (fallback if no empirical lag data)                           │
│   total_k              (total converters – for quality gate)                        │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   FIT LOGIC                                                                         │
│   ─────────                                                                         │
│                                                                                     │
│   CASE 1: median_lag_days valid AND total_k >= MIN_CONVERTERS                       │
│       μ = ln(median_lag_days)                                                       │
│       σ = sqrt(2 × ln(mean_lag_days / median_lag_days))   (if mean available)       │
│       σ = DEFAULT_SIGMA (0.5)                              (if mean unavailable)    │
│       empirical_quality_ok = true                                                   │
│                                                                                     │
│   CASE 2: median_lag_days valid BUT total_k < MIN_CONVERTERS                        │
│       μ = ln(median_lag_days)       ← use available median, still informative       │
│       σ = DEFAULT_SIGMA (0.5)                                                       │
│       empirical_quality_ok = false  ← but t95 falls back to DEFAULT_T95_DAYS        │
│                                                                                     │
│   CASE 3: median_lag_days invalid (missing, NaN, ≤0)                                │
│       μ = 0                                                                         │
│       σ = DEFAULT_SIGMA (0.5)                                                       │
│       empirical_quality_ok = false  ← t95 falls back to DEFAULT_T95_DAYS            │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   t95 COMPUTATION                                                                   │
│   ───────────────                                                                   │
│                                                                                     │
│   IF empirical_quality_ok:                                                          │
│       t95 = logNormalInverseCDF(LATENCY_T95_PERCENTILE, μ, σ)                       │
│                                                                                     │
│   ELSE:                                                                             │
│       t95 = DEFAULT_T95_DAYS  ← fallback to configured value                        │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

NOTE (14-Dec-25): Use explicit horizon primitives (`t95`, `path_t95`) with override semantics (see `docs/current/project-lag/t95-fix.md`). When no reliable empirical estimate is available, the system falls back to `DEFAULT_T95_DAYS`.

NOTE (14-Dec-25): Percentiles must be treated as **configuration**, not hard-coded:

- `LATENCY_T95_PERCENTILE` defines the meaning of `t95` (edge-local horizon).
- `LATENCY_PATH_T95_PERCENTILE` defines the meaning of `path_t95` (path horizon).

These constants are part of the statistical constants set and should be referenced consistently by all implementations and docs.

---

## 4. Effective Age Calculation (Per Cohort)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   ANCHOR AGE                                                                        │
│   ──────────                                                                        │
│   For each cohort date d:                                                           │
│       anchor_age[d] = TODAY - d                                                     │
│                                                                                     │
│   (e.g., cohort 16-Nov-25 observed on 10-Dec-25 → anchor_age = 24 days)            │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   EFFECTIVE AGE AT EDGE (depends on edge position)                                  │
│   ────────────────────────────────────────────────                                  │
│                                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────┐   │
│   │  CASE 1: First latency edge from anchor (A→X or A→B→C→X where B,C are 0-lag)│   │
│   │                                                                             │   │
│   │      effective_age[d] = anchor_age[d]                                       │   │
│   │                                                                             │   │
│   │      (Non-latency edges A→B→C contribute 0 lag, so we ignore them)          │   │
│   │                                                                             │   │
│   └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────┐   │
│   │  CASE 2: Downstream latency edge (X→Y, Y→Z, ...)                            │   │
│   │                                                                             │   │
│   │      effective_age[d] = max(0, anchor_age[d] - anchor_median_lag_eff)       │   │
│   │                                                                             │   │
│   │      WHERE:                                                                 │   │
│   │        anchor_median_lag_eff is the effective A→(source) median delay used  │   │
│   │        for cohort-mode completeness adjustment.                             │   │
│   │                                                                             │   │
│   │      We use a simple soft transition from prior to observed:                │   │
│   │        - Prior median m0: derived from upstream baseline-window lag          │   │
│   │          summaries (distribution-aware).                                     │   │
│   │        - Optional tail safety: if enabled, use upstream path_t95 horizons    │   │
│   │          (interpreted at LATENCY_PATH_T95_PERCENTILE) to prevent the prior   │   │
│   │          from being systematically optimistic in the tails on fat-tail paths.│  │
│   │        - Observed median m̂: population-weighted median from                  │   │
│   │          anchor_median_lag_days[] within the selected cohort window.         │   │
│   │        - Weight w ∈ [0,1]: increases with cohort coverage and effective      │   │
│   │          population.                                                        │   │
│   │        - Effective delay: m_eff = w·m̂ + (1-w)·m0                              │   │
│   │                                                                             │   │
│   │      If anchor_* arrays are absent, w=0 (prior-only).                        │   │
│   └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

      EXAMPLE: Path A → B → C → X → Y with B,C non-latency, X,Y latency

      ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐
      │     A     │───▶│     B     │───▶│     C     │───▶│     X     │───▶│     Y     │
      │  anchor   │    │  lag=0    │    │  lag=0    │    │  median=2 │    │  median=8 │
      └───────────┘    └───────────┘    └───────────┘    └───────────┘    └───────────┘

      For cohort d with anchor_age = 24 days:

      Edge C→X (first latency edge):
          effective_age = 24 days  (0 + 0 = 0 upstream latency)

      Edge X→Y (downstream latency):
          anchor_median_lag (A→X) = ~2 days
          effective_age = max(0, 24 - 2) = 22 days
```

---

## 5. Completeness Calculation

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   FORMULA                                                                           │
│   ───────                                                                           │
│                                                                                     │
│                      Σ n[d] × F(effective_age[d]; μ, σ)                            │
│   completeness = ─────────────────────────────────────────                         │
│                              Σ n[d]                                                 │
│                                                                                     │
│   WHERE:                                                                            │
│     F(t; μ, σ) = log-normal CDF at time t                                          │
│     μ, σ = fitted from this edge's median/mean lag                                  │
│     effective_age[d] = computed per §4 above                                        │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   INTERPRETATION                                                                    │
│   ──────────────                                                                    │
│                                                                                     │
│   "What fraction of eventual converters on this edge, for these cohorts,            │
│    should have converted by now?"                                                   │
│                                                                                     │
│   IMPORTANT: This is an “as-of now” view. Conversions that occur after the end of   │
│   the selected `window(start:end)` / `cohort(start:end)` still count towards the    │
│   evidence for those cohorts, because we care about what HAS happened so far.       │
│                                                                                     │
│   A separate “completed by window end” semantic toggle is a deferred requirement.   │
│                                                                                     │
│   STRUCTURAL LIMITATION (15-Dec-25): Completeness is currently **model-derived**     │
│   from the fitted/assumed lag distribution and cohort ages. It does not directly    │
│   consult realised conversions-to-date (`p.evidence.k/n`). This can be              │
│   counter-intuitive in some edge cases (e.g. `p.evidence.k > 0` while completeness  │
│   is ~0 due to a conservative upstream delay adjustment). A potential improvement   │
│   is to introduce an evidence-informed completeness floor/blend, but this is        │
│   deferred until after Phase 1 semantics/regression repair is stable.               │
│                                                                                     │
│   • completeness → 0:  Cohorts are too young; most conversions still pending        │
│   • completeness → 1:  Cohorts are mature; nearly all conversions have occurred     │
│                                                                                     │
│   PHASE 2 T95 TAIL CONSTRAINT (15-Dec-25): Completeness applies an explicit tail     │
│   constraint anchored to the authoritative `t95` horizon. This can ONLY LOWER (or   │
│   leave unchanged) completeness. It must NEVER increase completeness.               │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   SCOPING BY QUERY MODE                                                             │
│   ─────────────────────                                                             │
│                                                                                     │
│   Completeness is computed from cohorts whose dates match the query mode:           │
│                                                                                     │
│   • window(1-Dec-25:6-Dec-25):                                                      │
│       Completeness uses only cohorts with dates in 1-Dec to 6-Dec.                  │
│       This aligns with p.evidence, which is also window-scoped.                     │
│                                                                                     │
│   • cohort(1-Dec-25:6-Dec-25):                                                      │
│       Completeness uses cohorts with anchor entry dates in 1-Dec to 6-Dec.          │
│       This is the explicit cohort window behaviour.                                 │
│                                                                                     │
│   RATIONALE: In window() mode, evidence is window-based, so completeness            │
│   should also be window-based. This ensures consistency: both metrics               │
│   reflect the same temporal slice of data.                                          │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   EXAMPLE: First latency edge (C→X), median=2, ages 20-24 days                      │
│                                                                                     │
│   ┌──────────────────────────────────────────────────────────────────────────────┐  │
│   │  Cohort    n     eff_age    F(eff_age)    n × F                              │  │
│   │  ──────────────────────────────────────────────────────                      │  │
│   │  16-Nov    135   24 days    100%          135                                │  │
│   │  17-Nov    77    23 days    100%          77                                 │  │
│   │  18-Nov    101   22 days    100%          101                                │  │
│   │  19-Nov    327   21 days    100%          327                                │  │
│   │  20-Nov    257   20 days    100%          257                                │  │
│   │  ...                                                                         │  │
│   │  ──────────────────────────────────────────────────────                      │  │
│   │  TOTAL     2185             completeness = 2185/2185 = 100%                  │  │
│   └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│   EXAMPLE: Second latency edge (X→Y), median=8, anchor_median=2                     │
│                                                                                     │
│   ┌──────────────────────────────────────────────────────────────────────────────┐  │
│   │  Cohort    n     anchor_age  anchor_lag  eff_age    F(eff_age)               │  │
│   │  ──────────────────────────────────────────────────────────────              │  │
│   │  16-Nov    55    24 days     2 days      22 days    98%                      │  │
│   │  17-Nov    42    23 days     2 days      21 days    97%                      │  │
│   │  18-Nov    53    22 days     2 days      20 days    96%                      │  │
│   │  19-Nov    183   21 days     2 days      19 days    95%                      │  │
│   │  20-Nov    147   20 days     2 days      18 days    93%                      │  │
│   │  ...                                                                         │  │
│   │  ──────────────────────────────────────────────────────────────              │  │
│   │  TOTAL               completeness ≈ 72-90% (depending on full cohort mix)    │  │
│   └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Inbound-N Convolution (p.n flow)

### 6.1 Linear Path Example

```
                              TOPOLOGICAL FLOW (LEFT TO RIGHT)
                              ─────────────────────────────────

      ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐
      │     A     │    │     B     │    │     C     │    │     X     │    │     Y     │
      │  (START)  │───▶│           │───▶│           │───▶│           │───▶│           │
      └───────────┘    └───────────┘    └───────────┘    └───────────┘    └───────────┘
            │               │               │               │               │
            ▼               ▼               ▼               ▼               ▼

       p.n = N_anchor   p.n = Σ in     p.n = Σ in     p.n = Σ in     p.n = Σ in
       (from DSL)       forecast.k     forecast.k     forecast.k     forecast.k

            │               ▲               ▲               ▲               ▲
            │               │               │               │               │
            └───────────────┘               │               │               │
              p.forecast.k(A→B)             │               │               │
              = p.n(A) × p.mean(A→B)        │               │               │
                                            │               │               │
                        └───────────────────┘               │               │
                          p.forecast.k(B→C)                 │               │
                          = p.n(B) × p.mean(B→C)            │               │
                                                            │               │
                                    └───────────────────────┘               │
                                      p.forecast.k(C→X)                     │
                                      = p.n(C) × p.mean(C→X)                │
                                                                            │
                                                    └───────────────────────┘
                                                      p.forecast.k(X→Y)
                                                      = p.n(X) × p.mean(X→Y)
```

### 6.2 Multiple Parents / Fan-In (Diamond Pattern)

```
                              DIAMOND PATTERN: Two paths merge at node D
                              ──────────────────────────────────────────

                                    ┌───────────┐
                                    │     B     │
                            ┌──────▶│  p.mean   │──────┐
                            │       │   = 0.6   │      │
      ┌───────────┐         │       └───────────┘      │       ┌───────────┐
      │     A     │─────────┤                          ├──────▶│     D     │
      │  (START)  │         │       ┌───────────┐      │       │  (MERGE)  │
      │  n=1000   │         │       │     C     │      │       └───────────┘
      └───────────┘         └──────▶│  p.mean   │──────┘
                                    │   = 0.3   │
                                    └───────────┘


      STEP-BY-STEP CONVOLUTION:
      ─────────────────────────

      1. At START node A:
         • Anchor population: n = 1000

      2. Edges from A:
         • A→B: p.n = 1000, p.mean = 0.6  → p.forecast.k = 1000 × 0.6 = 600
         • A→C: p.n = 1000, p.mean = 0.3  → p.forecast.k = 1000 × 0.3 = 300

      3. At MERGE node D:
         • Inbound from B→D: p.forecast.k = 600 × p.mean(B→D)
         • Inbound from C→D: p.forecast.k = 300 × p.mean(C→D)

         Assuming p.mean(B→D) = 0.8 and p.mean(C→D) = 0.9:
         • forecast.k from B = 600 × 0.8 = 480
         • forecast.k from C = 300 × 0.9 = 270

      4. p.n at node D (for outgoing edges):

         ┌────────────────────────────────────────────────────────────────┐
         │                                                                │
         │   p.n(D) = Σ inbound p.forecast.k                              │
         │         = p.forecast.k(B→D) + p.forecast.k(C→D)                │
         │         = 480 + 270                                            │
         │         = 750                                                  │
         │                                                                │
         └────────────────────────────────────────────────────────────────┘

      5. Edges from D use p.n = 750 as their input population.
```

### 6.3 Rules

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   RULES                                                                             │
│   ─────                                                                             │
│                                                                                     │
│   1. ANCHOR EDGE (from START node):                                                 │
│      p.n = evidence.n from DSL cohorts (directly observed population)               │
│                                                                                     │
│   2. DOWNSTREAM EDGES (single parent):                                              │
│      p.n = inbound p.forecast.k from the single incoming edge                       │
│                                                                                     │
│   3. DOWNSTREAM EDGES (multiple parents / fan-in):                                  │
│      p.n = Σ (inbound p.forecast.k) over ALL incoming edges to the source node      │
│          = sum of forecast arrivals from all paths into this node                   │
│                                                                                     │
│   4. FORECAST PROPAGATION:                                                          │
│      p.forecast.k = p.n × p.mean                                                    │
│          = expected converters on this edge, passed downstream                      │
│                                                                                     │
│   5. NON-LATENCY EDGES:                                                             │
│      Same convolution rules apply; lag=0 doesn't change the p.n/p.forecast.k flow   │
│                                                                                     │
│   6. TOPOLOGICAL ORDER:                                                             │
│      Convolution must proceed in topological order so that all incoming edges       │
│      have computed p.forecast.k before we compute p.n for downstream edges.         │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.4 Linear Example Values

```
      ┌──────────────────────────────────────────────────────────────────────────────┐
      │                                                                              │
      │  Edge A→B (non-latency):                                                     │
      │    p.n = 4147 (from DSL cohort evidence at anchor)                           │
      │    p.mean = 0.95 (high – nearly everyone proceeds)                           │
      │    p.forecast.k = 4147 × 0.95 = 3940                                         │
      │                                                                              │
      │  Edge B→C (non-latency):                                                     │
      │    p.n = 3940 (from inbound forecast.k)                                      │
      │    p.mean = 0.90                                                             │
      │    p.forecast.k = 3940 × 0.90 = 3546                                         │
      │                                                                              │
      │  Edge C→X (first latency edge):                                              │
      │    p.n = 3546 (from inbound forecast.k)                                      │
      │    p.mean = 0.55 (blended, completeness ~100%)                               │
      │    p.forecast.k = 3546 × 0.55 = 1950                                         │
      │                                                                              │
      │  Edge X→Y (second latency edge):                                             │
      │    p.n = 1950 (from inbound forecast.k)                                      │
      │    p.mean = 0.22 (blended, completeness ~80%)                                │
      │    p.forecast.k = 1950 × 0.22 = 429                                          │
      │                                                                              │
      └──────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Blend Formula (p.mean from evidence + forecast)

Phase 2 clarifies that **`p.mean` is the canonical completeness-weighted blend** of evidence and forecast. There is **no separate “tail substitution” / “Formula A” mean estimator**.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   INPUTS                                                                            │
│   ──────                                                                            │
│                                                                                     │
│   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐                │
│   │  p.evidence.mean│    │  p.forecast.mean│    │  completeness   │                │
│   │  = k / n        │    │  (from window)  │    │  (from lag CDF) │                │
│   └────────┬────────┘    └────────┬────────┘    └────────┬────────┘                │
│            │                      │                      │                          │
│            │                      │                      │                          │
│   ┌────────┴──────────────────────┴──────────────────────┴────────┐                │
│   │                                                               │                │
│   │   ┌─────────────────┐                                         │                │
│   │   │      p.n        │  (from inbound-n convolution)           │                │
│   │   └────────┬────────┘                                         │                │
│   │            │                                                  │                │
│   └────────────┼──────────────────────────────────────────────────┘                │
│                │                                                                    │
│                ▼                                                                    │
│   ┌─────────────────────────────────────────────────────────────────────────────┐  │
│   │                                                                             │  │
│   │   c_w = completeness^η         (η = LATENCY_BLEND_COMPLETENESS_POWER)       │  │
│   │   n_eff = c_w × p.n                                                        │  │
│   │                                                                             │  │
│   │   m₀ = λ × n_baseline        (λ = FORECAST_BLEND_LAMBDA)                    │  │
│   │   m₀_eff = m₀ × (1 - c_w)     (forecast weight vanishes as completeness→1)  │  │
│   │                                                                             │  │
│   │                           n_eff                                             │  │
│   │   w_evidence = ─────────────────────                                        │  │
│   │                    m₀_eff + n_eff                                            │  │
│   │                                                                             │  │
│   │   p.mean = w_evidence × p.evidence.mean                                     │  │
│   │          + (1 - w_evidence) × p.forecast.mean                               │  │
│   │                                                                             │  │
│   └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   BEHAVIOUR                                                                         │
│   ─────────                                                                         │
│                                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────┐  │
│   │                                                                             │  │
│   │   completeness ≈ 0                                                          │  │
│   │       → n_eff ≈ 0                                                           │  │
│   │       → w_evidence ≈ 0                                                      │  │
│   │       → p.mean ≈ p.forecast.mean                                            │  │
│   │                                                                             │  │
│   │   completeness ≈ 1 AND p.n large                                            │  │
│   │       → n_eff large                                                         │  │
│   │       → w_evidence → 1                                                      │  │
│   │       → p.mean ≈ p.evidence.mean                                            │  │
│   │                                                                             │  │
│   │   As edge matures:                                                          │  │
│   │       p.mean smoothly transitions from forecast → evidence                  │  │
│   │       weighted by both HOW COMPLETE and HOW MUCH POPULATION                 │  │
│   │                                                                             │  │
│   └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

NOTE (8-Jan-26): `p.evidence.mean` remains the raw observed \(k/n\). In cohort path-anchored mode, the **blend** may use an adjusted evidence rate (see §7.0) while keeping `p.evidence.mean` unchanged for semantic clarity.

### 7.0 Cohort-path evidence adjustment for blending (right-censor correction) — Updated 8-Jan-26

In `cohort(...)` mode, `p.evidence.mean = k/n` for a downstream edge is often **right-censored**: many cohort members have started the journey, but have not yet had time to complete the edge by the query date.

When cohort completeness is computed in **path-anchored mode** (A→Y maturity; see §9), LAG treats:

- `p.latency.completeness` as an estimate of “fraction of eventual conversions that have already occurred by now” for the A-anchored cohorts.

Under that interpretation, the observed `k/n` is expected to be biased low by approximately that factor:

- `E[k/n] ≈ p∞ × completeness`

So for blending (and **only** in cohort path-anchored mode), we adjust the evidence rate **used for blending** without dividing by very small completeness (which can blow up and create unstable behaviour).

```
evidence_mean_used_for_blend = BetaPosteriorMean(
  k_obs,
  n_eff,
  prior_mean = p.forecast.mean,
  prior_strength ≈ LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE / completeness
)
```

Guardrails:

- Applies only when **cohort-mode completeness is path-anchored** (A→Y), not in `window(...)` mode.
- Does not apply when cohort completeness is a fallback/conditional estimate.
- `p.evidence.mean` remains the **raw observed** signal (`k/n`) for semantic clarity; only the blend uses the adjusted value.

This change reduces the systematic “mid-window tug” where evidence is incomplete but was still treated as an estimate of the eventual rate.

### 7.1 Recency Weighting in Forecast Baseline

When deriving `p.forecast.mean`, **recent mature days are weighted more heavily** than older ones. The implementation recomputes `p.forecast.mean` at query time from context-matching `window()` daily arrays (or MECE-aggregated `window()` slices for implicit uncontexted queries). This ensures the forecast reflects current conversion behaviour rather than stale historical patterns.

**Observability (18-Dec-25):** Each query-time recompute of `p.forecast.mean` emits a `FORECAST_BASIS` entry in the Session Log that records the requested slice, the window-slice basis used, as-of date (max window date), maturity exclusion, and the weighted \(N/K\) used in the estimate.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   RECENCY-WEIGHTED p∞ ESTIMATION                                                    │
│   ──────────────────────────────                                                    │
│                                                                                     │
│   When estimating p∞ from mature cohorts (design.md §5.6):                          │
│                                                                                     │
│         Σ (w[d] × k[d])                                                             │
│   p∞ = ─────────────────                                                            │
│         Σ (w[d] × n[d])                                                             │
│                                                                                     │
│   WHERE:                                                                            │
│     w[d] = exp(-ln(2) * age[d] / H)                                                 │
│     H = RECENCY_HALF_LIFE_DAYS (default: 30 days)                                   │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   EFFECT                                                                            │
│   ──────                                                                            │
│                                                                                     │
│   • A cohort H days old has HALF the weight of a brand-new cohort                   │
│   • A cohort 2H days old has 1/4 the weight                                         │
│   • A cohort 3H days old has 1/8 the weight                                         │
│                                                                                     │
│   This makes p.forecast.mean responsive to recent changes in conversion behaviour   │
│   (e.g. product changes, seasonal effects) while still being grounded in mature     │
│   data where eventual conversions are known.                                        │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   CONSTANT                                                                          │
│   ────────                                                                          │
│                                                                                     │
│   RECENCY_HALF_LIFE_DAYS = 30                                                       │
│                                                                                     │
│   Defined in: src/constants/latency.ts                                              │
│   Configurable via settings/settings.yaml (see public/docs/forecasting-settings.md) │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. End-to-End Flow Summary

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   AMPLITUDE / PARAM FILES                                                           │
│   ───────────────────────                                                           │
│                                                                                     │
│   ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐       │
│   │ n_daily[]  │ │ k_daily[]  │ │median_lag[]│ │anchor_lag[]│ │ latency?   │       │
│   └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘       │
│         │              │              │              │              │               │
│         ▼              ▼              ▼              ▼              ▼               │
│   ┌─────────────────────────────────────────────────────────────────────────────┐  │
│   │                      STATISTICAL ENHANCEMENT SERVICE                        │  │
│   │                      ───────────────────────────────                        │  │
│   │                                                                             │  │
│   │   1. Aggregate cohort data (filter to DSL window)                           │  │
│   │                                                                             │  │
│   │   2. Fit lag distribution:                                                  │  │
│   │        μ = ln(median_lag)                                                   │  │
│   │        σ = from mean/median ratio                                           │  │
│   │        (fallback to DEFAULT_T95_DAYS if no lag data)                        │  │
│   │                                                                             │  │
│   │   3. Compute t95:                                                           │  │
│   │        = logNormalInverseCDF(0.95, μ, σ) if fit OK                          │  │
│   │        = DEFAULT_T95_DAYS otherwise                                         │  │
│   │                                                                             │  │
│   │   4. Compute effective age per cohort:                                      │  │
│   │        First latency edge:  eff_age = anchor_age                            │  │
│   │        Downstream edges:    eff_age = max(0, anchor_age - anchor_median)    │  │
│   │                                                                             │  │
│   │   5. Compute completeness:                                                  │  │
│   │        = Σ n[d] × F(eff_age[d]) / Σ n[d]                                    │  │
│   │                                                                             │  │
│   │   6. Compute p.evidence.mean:                                               │  │
│   │        = Σ k / Σ n                                                          │  │
│   │                                                                             │  │
│   └─────────────────────────────────────────────────────────────────────────────┘  │
│          │                                                                          │
│          ▼                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────────┐  │
│   │                           INBOUND-N PASS                                    │  │
│   │                           ──────────────                                    │  │
│   │                                                                             │  │
│   │   Topo order traversal:                                                     │  │
│   │     • Anchor edges: p.n = evidence.n                                        │  │
│   │     • Downstream:   p.n = Σ upstream p.forecast.k                           │  │
│   │     • All edges:    p.forecast.k = p.n × p.mean                             │  │
│   │                                                                             │  │
│   └─────────────────────────────────────────────────────────────────────────────┘  │
│          │                                                                          │
│          ▼                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────────┐  │
│   │                           BLEND (p.mean)                                    │  │
│   │                           ──────────────                                    │  │
│   │                                                                             │  │
│   │   n_eff = completeness × p.n                                                │  │
│   │   w = n_eff / (λ × n_baseline + n_eff)                                      │  │
│   │   p.mean = w × p.evidence.mean + (1-w) × p.forecast.mean                    │  │
│   │                                                                             │  │
│   └─────────────────────────────────────────────────────────────────────────────┘  │
│          │                                                                          │
│          ▼                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────────┐  │
│   │                           GRAPH / UI                                        │  │
│   │                           ──────────                                        │  │
│   │                                                                             │  │
│   │   edge.p.mean           ← blended probability                               │  │
│   │   edge.p.evidence       ← {mean, n, k}                                      │  │
│   │   edge.p.forecast       ← {mean}                                            │  │
│   │   edge.p.latency        ← {t95, completeness, median_lag_days, path_t95}    │  │
│   │   edge.p.n              ← forecast population                               │  │
│   │                                                                             │  │
│   └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Role of path_t95

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   WHAT path_t95 IS                                                                  │
│   ────────────────                                                                  │
│                                                                                     │
│   UPDATED (11-Dec-25): path_t95 is the anchor-to-edge conversion horizon used for  │
│   cohort() retrieval bounding.                                                      │
│                                                                                     │
│   Prefer ANCHOR+EDGE estimate when available (reduces over-greediness on deep DAGs):│
│     If we have 3-step cohort lag arrays for this edge (anchor_* + edge lag), then  │
│     anchor_* gives A→X, edge lag gives X→Y, and we estimate A→Y as:                 │
│                                                                                     │
│       path_t95 ≈ t95( A→X + X→Y )                                                   │
│                                                                                     │
│     Implementation: moment-matched lognormal sum (Fenton–Wilkinson approximation). │
│                                                                                     │
│   Fallback (when anchor_* is missing / fails fit quality gates):                    │
│     path_t95 = conservative topo accumulation of per-edge t95s over active paths.  │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   WHAT path_t95 IS USED FOR                                                         │
│   ─────────────────────────                                                         │
│                                                                                     │
│   ✓  Retrieval horizons – how far back to fetch cohort data                        │
│   ✓  Caching / staleness decisions – when to consider data stale                   │
│   ✓  Upper bound sanity checks                                                      │
│   ✓  Determining if cohort() vs window() mode is needed for an edge                │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   WHAT path_t95 IS NOT USED FOR                                                     │
│   ─────────────────────────────                                                     │
│                                                                                     │
│   ✗  Direct subtraction from cohort ages                                            │
│       → path_t95 is too conservative; would understate maturity                     │
│                                                                                     │
│   ✗  Using path_t95 as a “time-to-reach-X” median prior                              │
│       → category error; use observed anchor lag medians/means instead               │
│                                                                                     │
│   NOTE (16-Dec-25): path_t95 IS used to *pull the tail* of cohort completeness      │
│   (one-way σ increase) when computing path-anchored A→Y maturity. It is NOT used    │
│   as a subtraction term.                                                            │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Summary of Key Quantities

### 10.1 Edge Properties (on `edge.p.*`)

```
┌─────────────────────────────┬──────────────────────────────────────────────────────┐
│  DSL PATH                   │  MEANING                                             │
├─────────────────────────────┼──────────────────────────────────────────────────────┤
│  p.mean                     │  Blended probability (evidence + forecast weighted   │
│                             │  by completeness and population)                     │
│                             │                                                      │
│  p.evidence.mean            │  Observed k/n for this DSL cohort window             │
│                             │  NOTE: In cohort path-anchored mode, this is        │
│                             │  right-censored; blending uses §7.0 de-biasing.     │
│  p.evidence.n               │  Total observed population (Σ n_daily)               │
│  p.evidence.k               │  Total observed conversions (Σ k_daily)              │
│                             │                                                      │
│  p.forecast.mean            │  Baseline probability from mature window() data      │
│  p.forecast.k               │  Expected converters = p.n × p.mean (internal,       │
│                             │  passed downstream for inbound-n convolution)        │
│                             │                                                      │
│  p.n                        │  Forecast population for this edge under DSL         │
│                             │  (from inbound-n convolution)                        │
│                             │                                                      │
│  p.latency.t95              │  95th percentile of this edge's lag distribution     │
│  p.latency.path_t95         │  Preferred: t95(A→X + X→Y) from anchor_* + edge lag   │
│                             │  Fallback: conservative topo accumulation of t95s    │
│  p.latency.completeness     │  Fraction of eventual conversions that have occurred │
│  p.latency.latency_parameter│  Enablement flag for latency tracking (boolean)      │
│  p.latency.median_lag_days  │  Observed median lag for this edge only              │
│  p.latency.mean_lag_days    │  Observed mean lag for this edge only                │
└─────────────────────────────┴──────────────────────────────────────────────────────┘
```

### 10.2 Param File Fields (per-cohort arrays in `values[]`)

```
┌─────────────────────────────┬──────────────────────────────────────────────────────┐
│  PARAM FILE FIELD           │  MEANING                                             │
├─────────────────────────────┼──────────────────────────────────────────────────────┤
│  dates[]                    │  Cohort entry dates (d-MMM-yy format)                │
│  n_daily[]                  │  Per-cohort population entering this edge            │
│  k_daily[]                  │  Per-cohort conversions on this edge                 │
│  median_lag_days[]          │  Per-cohort median lag (this edge only)              │
│  mean_lag_days[]            │  Per-cohort mean lag (this edge only)                │
│                             │                                                      │
│  anchor_n_daily[]           │  Per-cohort population at anchor (A)                 │
│  anchor_median_lag_days[]   │  Per-cohort cumulative A→(this edge source) median   │
│  anchor_mean_lag_days[]     │  Per-cohort cumulative A→(this edge source) mean     │
│                             │                                                      │
│  latency.median_lag_days    │  Slice-level median lag summary (this edge)          │
│  latency.mean_lag_days      │  Slice-level mean lag summary (this edge)            │
│  latency.t95                │  Slice-level 95th percentile lag                     │
└─────────────────────────────┴──────────────────────────────────────────────────────┘
```

### 10.3 Edge Config (on edge definition)

```
┌─────────────────────────────┬──────────────────────────────────────────────────────┐
│  EDGE CONFIG FIELD          │  MEANING                                             │
├─────────────────────────────┼──────────────────────────────────────────────────────┤
│  p.latency.latency_parameter│  Enablement flag for latency tracking (boolean)      │
│                             │  data available) – also used for t95 fallback        │
│                             │                                                      │
│  p.latency.anchor_node_id   │  ID of the cohort anchor node (A) for this edge      │
│                             │                                                      │
│  conditional_p[]            │  Array of case-specific probability overrides        │
│  conditional_p[i].case_id   │  Which case this entry applies to                    │
│  conditional_p[i].p.mean    │  Probability to use when this case is active         │
└─────────────────────────────┴──────────────────────────────────────────────────────┘
```

### 10.4 Derived/Computed Quantities (internal)

```
┌─────────────────────────────┬──────────────────────────────────────────────────────┐
│  INTERNAL QUANTITY          │  MEANING                                             │
├─────────────────────────────┼──────────────────────────────────────────────────────┤
│  anchor_age[d]              │  TODAY - cohort_date[d] (days since anchor entry)    │
│  effective_age[d]           │  Age at this edge = anchor_age - anchor_median_lag   │
│  evidence_mean_used_for_blend│ In cohort path-anchored mode: clamp01((k/n)/comp)   │
│  μ (mu)                     │  ln(median_lag_days) – log-normal location param     │
│  σ (sigma)                  │  Log-normal scale param (from mean/median ratio)     │
│  F(t; μ, σ)                 │  Log-normal CDF at time t                            │
│  n_eff                      │  completeness × p.n (effective evidence weight)      │
│  m₀                         │  λ × n_baseline (forecast prior weight)              │
│  w_evidence                 │  n_eff / (m₀ + n_eff) (blend weight)                 │
└─────────────────────────────┴──────────────────────────────────────────────────────┘
```

---

## 11. Scenarios & What-If – How Stats Behave Per Scenario

### 11.1 Scenario-Specific Edge Parameters

In scenario / what-if mode, **each scenario** has its own effective parameters and active edge set:

- **Per scenario S:**
  - Some edges may be **activated/deactivated** (e.g. case allocations, switches).
  - Some edges may have **overridden p.mean** or **conditional_p** choices.
  - The **topology of active paths** from A to downstream edges may change.

Conceptually:

```
BASE GRAPH (all edges)                   SCENARIO S (subset + overrides)
─────────────────────────               ─────────────────────────────────

 A → B → C → X → Y → Z                  A → B → C → X → Y → Z
     ↘ D → E ↗                              ↘ D (disabled)  E (disabled)

 Latency, evidence, forecast             Same raw data, but:
 (per edge, per DSL)                     • Only some edges active
                                         • Some p.mean overridden
                                         • Different active paths A→…→edge
```

### 11.2 Scenario-Aware Inbound-N and path_t95

For each scenario S and DSL:

- **Active edges:** determined by scenario logic (`conditional_p`, case allocations, switches).
- **Inbound-n convolution and path_t95 are re-run per scenario:**

```
For scenario S:

  1. Determine active edges for S (using conditional_p, switches, etc.)
  2. Compute scenario-effective p.mean for each edge (after overrides)
  3. Run inbound-n convolution over ACTIVE edges only:
       • Anchor edges:  p.n = evidence.n (or scenario-specific base)
       • Downstream:    p.n = Σ inbound p.forecast.k
       • p.forecast.k = p.n × p.mean (scenario-specific)
  4. Compute path_t95 over ACTIVE latency edges only:
       • Prefer: path_t95 ≈ t95(A→X + X→Y) when anchor_* lag is available
       • Fallback: path_t95(edge) = max over active paths Σ t95(e) along path
```

**Implications:**

- Different scenarios can yield **different p.n** and **different path_t95** for the same edge, even under the same DSL.
- Completeness at an edge still uses:
  - The same **lag distributions** (from underlying data).
  - The same **anchor-age and anchor_median_lag** logic for effective_age.
  - But completeness may be **interpreted differently** in UI (e.g. which edges are shown as relevant) because active paths differ.

### 11.3 Scenario-Specific p.mean and Param Packs

For each scenario S:

1. **Scenario-effective inputs per edge:**
   - `p.evidence.mean` – usually **scenario-independent**, from the data under the DSL.
   - `p.forecast.mean` – usually **scenario-independent** baseline from mature window() data.
   - `completeness` – **scenario-independent** in the pure LAG sense (driven by cohort ages and lag, not by switching edges on/off).
   - `p.n` – **scenario-dependent**, from inbound-n convolution.
   - `n_baseline`, `λ` – global or edge-specific but scenario-independent.

2. **Blend per scenario:**

   ```
   n_eff(S)   = completeness × p.n(S)
   m₀         = λ × n_baseline
   w_evidence = n_eff(S) / (m₀ + n_eff(S))

   p.mean(S)  = w_evidence × p.evidence.mean
              + (1 - w_evidence) × p.forecast.mean
   ```

3. **Scenario param packs (what the scenario editor sees) store:**
   - `p.mean(S)` – scenario-specific blended probability.
   - `p.evidence.mean` – shared across scenarios (given DSL).
   - `p.forecast.mean` – shared across scenarios.
   - `p.latency.t95` – **scenario-independent** (this edge's own lag distribution).
   - `p.latency.path_t95` – **scenario-dependent** (cumulative lag over active paths differs).
   - `p.latency.completeness` – **scenario-independent** (lag CDF at cohort ages).
   - `p.n(S)` – scenario-specific forecast population.

### 11.4 Intuition: What-If Changes and Their Effects

When a user changes a scenario (what-if):

- **Toggling edges / changing case allocations:**
  - Changes which edges are active on a path.
  - Changes the **inbound-n flow**:
    - Some edges may now receive **more or fewer users** (p.n changes).
  - **Completeness (as a pure timing fraction) stays the same**, but:
    - The blend weight `w_evidence` changes via p.n(S), so:
      - p.mean(S) may shift closer to evidence or forecast depending on how much population now flows through that edge.

- **Overriding p.mean on an upstream edge in scenario S:**
  - Changes p.forecast.k upstream.
  - Changes p.n(S) for downstream edges.
  - Downstream p.mean(S) is recomputed using the **same completeness** but new p.n(S), so:
    - It reflects both the new probability and the revised scale of the scenario.

In short, scenarios do **not** change the underlying time/lag maths (completeness, t95), but they **do** change:

- Which paths are considered.
- How much population reaches each edge (p.n).
- The resulting scenario-specific p.mean via the completeness- and n-aware blend.

### 11.5 conditional_p: Per-Case Probability Overrides

Edges can have a `conditional_p` array that provides different probability values for different cases or scenarios:

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   EDGE STRUCTURE WITH conditional_p                                                 │
│   ─────────────────────────────────                                                 │
│                                                                                     │
│   edge: {                                                                           │
│     from: "X",                                                                      │
│     to: "Y",                                                                        │
│     p: {                                                                            │
│       mean: 0.55,              ← BASE probability (used when no case active)        │
│       evidence: { ... },                                                            │
│       forecast: { mean: 0.60 },                                                     │
│       latency: { ... },                                                             │
│     },                                                                              │
│     conditional_p: [           ← CASE-SPECIFIC probabilities                        │
│       {                                                                             │
│         case_id: "optimistic",                                                      │
│         p: {                                                                        │
│           mean: 0.70,          ← Probability when "optimistic" case is active       │
│           evidence: { ... },                                                        │
│           forecast: { mean: 0.70 },                                                 │
│         }                                                                           │
│       },                                                                            │
│       {                                                                             │
│         case_id: "pessimistic",                                                     │
│         p: {                                                                        │
│           mean: 0.35,          ← Probability when "pessimistic" case is active      │
│           evidence: { ... },                                                        │
│           forecast: { mean: 0.35 },                                                 │
│         }                                                                           │
│       }                                                                             │
│     ]                                                                               │
│   }                                                                                 │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 11.6 How conditional_p Interacts with Convolution

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│   SCENARIO EVALUATION FLOW                                                          │
│   ────────────────────────                                                          │
│                                                                                     │
│   For scenario S with active case C on a node:                                      │
│                                                                                     │
│   1. DETERMINE EFFECTIVE p.mean FOR EDGE                                            │
│                                                                                     │
│      IF edge has conditional_p entry matching active case C:                        │
│          p.mean_effective = conditional_p[C].p.mean                                 │
│      ELSE:                                                                          │
│          p.mean_effective = edge.p.mean  (base/blended value)                       │
│                                                                                     │
│   2. USE EFFECTIVE p.mean IN CONVOLUTION                                            │
│                                                                                     │
│      p.forecast.k = p.n × p.mean_effective                                          │
│                                                                                     │
│   3. DOWNSTREAM EFFECTS                                                             │
│                                                                                     │
│      • Downstream p.n changes because upstream p.forecast.k changed                 │
│      • Downstream p.mean is recomputed using the blend formula:                     │
│          n_eff = completeness × p.n(S)                                              │
│          w = n_eff / (λ × n_baseline + n_eff)                                       │
│          p.mean(S) = w × p.evidence.mean + (1-w) × p.forecast.mean                  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 11.7 Case Allocations and conditional_p

When a node has **case allocations** (e.g., A/B test with 50/50 split), this affects how population flows through edges:

```
                              CASE ALLOCATIONS EXAMPLE
                              ────────────────────────

      Node X has case "ab-test" with allocations:
        • treatment: 60%
        • control: 40%

                                    ┌───────────┐
                                    │ treatment │
                            ┌──────▶│  p.mean   │──────┐
                            │  60%  │   = 0.70  │      │
      ┌───────────┐         │       └───────────┘      │       ┌───────────┐
      │     X     │─────────┤                          ├──────▶│     Z     │
      │  p.n=1000 │         │       ┌───────────┐      │       │           │
      │           │         │  40%  │  control  │      │       └───────────┘
      └───────────┘         └──────▶│  p.mean   │──────┘
                                    │   = 0.50  │
                                    └───────────┘


      CONVOLUTION WITH CASE ALLOCATIONS:
      ───────────────────────────────────

      1. X→treatment edge:
         • p.n = 1000 × 0.60 = 600  (allocated population)
         • p.mean = 0.70 (from conditional_p for "treatment" case)
         • p.forecast.k = 600 × 0.70 = 420

      2. X→control edge:
         • p.n = 1000 × 0.40 = 400  (allocated population)
         • p.mean = 0.50 (from conditional_p for "control" case)
         • p.forecast.k = 400 × 0.50 = 200

      3. At merge node Z:
         • p.n = 420 + 200 = 620
```

### 11.8 Summary: What Varies Per Scenario

```
┌────────────────────────┬────────────────────────────────────────────────────────────┐
│  QUANTITY              │  SCENARIO-DEPENDENT?                                       │
├────────────────────────┼────────────────────────────────────────────────────────────┤
│  p.evidence.mean       │  No – from DSL data, same across scenarios                 │
│  p.forecast.mean       │  No – from window() baseline, same across scenarios        │
│  completeness          │  No – from lag/cohort ages, same across scenarios          │
│  t95 (per-edge)        │  No – from this edge's lag distribution only               │
│  median_lag_days       │  No – from this edge's lag data only                       │
│  ───────────────────── │ ──────────────────────────────────────────────────────────│
│  path_t95              │  YES – cumulative lag over ACTIVE paths (differs by S)     │
│  p.mean (effective)    │  YES – affected by conditional_p for active case           │
│  p.n                   │  YES – affected by upstream p.mean choices & allocations   │
│  p.forecast.k          │  YES – = p.n × p.mean, so varies with both                 │
│  w_evidence            │  YES – depends on p.n which varies per scenario            │
│  p.mean (blended)      │  YES – blend uses scenario-specific p.n in weight          │
│  Active edges          │  YES – conditional_p, case weights determine which on/off  │
└────────────────────────┴────────────────────────────────────────────────────────────┘
```

---

## 12. Constants Reference

Key defaults used in LAG calculations:

- **Shipped defaults**: `public/defaults/settings.yaml` (seeded into the repo as `settings/settings.yaml`)
- **Compiled fallbacks**: `src/constants/latency.ts` (used if the settings file is missing or malformed)

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECENCY_HALF_LIFE_DAYS` | 30 | Half-life for recency weighting in p∞ estimation (§7.1) |
| `LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE` | 150 | Stability guardrail for recency weighting and cohort evidence adjustment |
| `DEFAULT_T95_DAYS` | 30 | Default horizon when no reliable t95 is available |
| `FORECAST_BLEND_LAMBDA` | 0.15 | Forecast prior strength λ in blend weighting (§7) |
| `LATENCY_BLEND_COMPLETENESS_POWER` | 2.25 | Completeness power η used for blend weighting (§7) |
| `ANCHOR_DELAY_BLEND_K_CONVERSIONS` | 50 | Credibility threshold for anchor-delay soft transition (cohort completeness) |
| `LATENCY_DEFAULT_SIGMA` | 0.5 | Default log-normal σ when insufficient data (§3) |
| `LATENCY_MIN_FIT_CONVERTERS` | 30 | Minimum k for reliable empirical fit (§3) |
| `PRECISION_DECIMAL_PLACES` | 4 | Decimal precision for probability values |
