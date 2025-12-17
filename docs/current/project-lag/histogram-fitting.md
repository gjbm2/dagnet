# Histogram-assisted latency fitting (future enhancement)

Date: 16-Dec-25

## Context and motivation

We currently model edge latency using a lognormal distribution fitted from summary statistics (typically median and mean lag days), with optional tail constraints from `t95` and `path_t95`. This approach is simple and robust, but it can systematically overstate early completeness on edges where conversion probability is effectively **zero** for an initial period (a practical “dead time” before any conversions can occur).

Amplitude provides **histogram data for the first ~10 days** of lag on each edge query. While this is insufficient to fully model the long tail, it is often sufficient to detect cases where the distribution should not anchor at \(t=0\), but instead at \(t=\delta\) (a non-zero start delay).

If we can infer such a delay, we can reduce early-time completeness bias and improve evidence/censoring behaviour on immature cohorts, especially on deep paths where small completeness errors can propagate into blending and downstream means.

## High-level idea: shifted (delayed) lognormal

Model time-to-conversion as:

- Total lag \(T = \delta + X\)
- \(X\) follows a lognormal distribution
- \(\delta\) is a non-negative delay representing “no conversions can occur before this time”

Completeness at age \(t\) becomes:

- 0 for \(t \le \delta\)
- lognormal CDF evaluated at \(t-\delta\) for \(t > \delta\)

This is a “shifted lognormal” (also describable as a hurdle / delayed-onset model).

## What histogram data can (and cannot) do

### What it can do well

- Detect a plausible **start delay**: if early bins contain (near) zero mass, and then mass appears later.
- Provide strong evidence of a **non-zero support** onset (conversions do not start immediately).
- Provide a stable indicator of “dead time” even when the long tail is unknown.

### What it cannot do well (by itself)

- Characterise the long tail beyond ~10 days.
- Reliably infer higher percentiles (e.g. 95th) for slow edges if significant mass lies beyond the observed histogram window.
- Disambiguate “no early conversions because \(\delta>0\)” from “no early conversions because sample size is tiny” without additional gating.

## Options for estimating \(\delta\) from the early histogram

We should avoid defining \(\delta\) as “first day with any conversions”, because that is extremely sensitive to noise (one stray conversion can collapse \(\delta\) to zero). More defensible options:

- **Cumulative-mass threshold**: choose the smallest day where cumulative histogram mass reaches a small threshold (e.g. 1%).
- **Expected-count threshold**: require that cumulative expected conversions exceeds a minimum count before declaring onset.
- **Sustained-mass onset**: require that mass is non-trivial for a few consecutive bins (reduces single-bin noise).
- **Quantile within observed window**: treat \(\delta\) as an early quantile (e.g. 5th percentile) estimated from the histogram (still needs gating).

All of these require a minimum effective sample size to avoid inferring delays from sparse data.

## How shifting interacts with existing `t95` / `path_t95` tail constraints

The core principle remains: `*_overridden` flags are permissions-only; the presence of `t95` / `path_t95` values may be used as authoritative horizons to avoid thin-tail bias.

With a delay model:

- The fitted lognormal applies to \(X\) (post-delay time).
- Horizons apply to \(T\) (total time), so we must reconcile:
  - The authoritative `t95` / `path_t95` is a percentile of \(T\)
  - The tail constraint logic typically pulls sigma so that the model-implied percentile is not smaller than the authoritative value

A consistent approach is:

- Convert any authoritative horizon on \(T\) into an implied horizon on \(X\) by subtracting \(\delta\) (bounded below by a small epsilon).
- Apply one-way sigma increase to ensure the implied \(X\) percentile meets or exceeds that adjusted horizon.
- Add \(\delta\) back when reporting total `t95` and `path_t95` as graph-visible horizons.

This preserves the current “one-way pull only” semantics (never shrink tails).

## Where this would affect system behaviour

### Completeness

Primary impact: completeness remains closer to 0 for early ages until \(\delta\) elapses, which reduces the risk of:

- Overstating maturity on very young cohorts
- Over-weighting observed evidence when it is structurally right-censored
- Understating forecast dominance on deep edges during the initial dead-time

### Evidence and blending

If evidence is derived from observed \(k/n\) in immature cohorts, then early-time completeness affects how evidence is interpreted (whether via explicit correction or via blending weights).

A more accurate early completeness should reduce “sag” in evidence-dominated downstream means caused by mis-calibrated maturity.

### Path horizons

Path-level horizons (e.g. `path_t95`) may need to incorporate \(\delta\) accumulation across edges if delays are edge-local and compositional. There are multiple modelling choices:

- **Edge-local delay only**: delay affects only that edge’s conversion clock
- **Path delay accumulation**: delays add along the path similarly to other horizon components
- **Mixture-aware join behaviour**: at joins, a small-mass long-delay branch should not dominate mixture horizons

These choices must match the semantics of what the histogram represents (edge-local lag, not global time from start).

## Design risks and mitigation strategies

### Risk: false detection of \(\delta\) due to sparse data

Mitigations:

- Require minimum effective sample size before using histogram-derived \(\delta\).
- Use thresholds based on cumulative mass rather than first non-zero bin.
- Prefer conservative estimates that do not reduce horizons or increase completeness early.

### Risk: mismatched semantics of histogram bins

We must confirm:

- What the histogram measures (edge-local lag days vs some anchored lag).
- Whether bins are conditioned on eventual converters only, or all starters.
- Whether the histogram is itself right-censored by as-of date in cohort mode.

### Risk: incompatibility with current summary stats

If median/mean lag days in the pipeline are already computed conditional on some onset, subtracting \(\delta\) would double-count.

We should explicitly document the data provenance and ensure any shift applies consistently across:

- median lag
- mean lag
- horizons (`t95`, `path_t95`)

## Alternative modelling approaches (beyond shifted lognormal)

Histogram data might also support:

- **Piecewise model**: a discrete early-hazard component (0–10 days) plus a parametric tail beyond.
- **Mixture of fast/slow components**: two lognormals representing heterogeneous populations (requires more than 10 days to be stable).
- **Capped survival adjustment**: treat early bins as a lower bound on hazard and only allow the inferred hazard to increase later.

These are more complex and require careful guardrails to avoid overfitting.

## Suggested future work plan (conceptual)

- Confirm Amplitude histogram semantics and censoring behaviour.
- Define a robust, gated \(\delta\) estimator from early histogram bins.
- Integrate \(\delta\) into completeness evaluation (0 before \(\delta\), shifted CDF after).
- Integrate \(\delta\) into horizon reporting (add \(\delta\) back to total horizons).
- Ensure `t95` / `path_t95` constraints remain one-way and are applied in the shifted frame.
- Add a synthetic harness scenario that demonstrates the improvement:
  - A clear dead-time in the first 10 days
  - A fat tail beyond the early window
  - Demonstrate that completeness stays low during dead-time and downstream means do not sag prematurely

## Open questions

- What percentile threshold is appropriate for onset detection (and how should it vary with sample size)?
- Should \(\delta\) be edge-specific only, or also applied to anchor/path computations?
- How do we reconcile join heterogeneity where one branch has a much longer dead-time but low mass?
- Should histogram-derived \(\delta\) ever be persisted, or treated as transient per fetch?

## Related issue: MECE context slices and mixture quantiles (future reference)

Separately from histogram-derived \(\delta\), we have an emerging requirement around **MECE context slicing**:

- When a context key is MECE (mutually exclusive and collectively exhaustive), the system should be able to treat the set of contexted slices as an **implicit uncontexted truth** for both `window()` and `cohort()` modes (to avoid wasteful explicit uncontexted fetches).

This has a direct implication for histogram-assisted fitting and for latency summaries generally:

- Aggregating medians across slices is not additive. The mathematically correct target is the median of the pooled population, i.e. the 0.5 quantile of the **mixture distribution** \(F(t)=\sum_i w_i F_i(t)\).
- If histogram bins are available (even only early bins), pooling histograms across MECE slices (by summing counts) provides a principled way to estimate early mixture quantiles and to detect onset delays that are stable across segments.
- Even without histograms, a practical approach is to approximate per-slice lag distributions (e.g. lognormal fits with one-way tail constraints) and compute mixture quantiles via monotone root finding.

### Architectural note: shared lag distribution utilities

At present, most lognormal fitting and quantile utilities live inside the statistical enhancement layer (graph-level LAG). If we want to compute mixture quantiles at aggregation time (e.g. when building an implicit uncontexted baseline from MECE slices), we will likely need to **service-ify / library-ify** the distribution machinery:

- Move pure distribution utilities (CDF, inverse CDF, fitting from moments, tail-constraint improvement, mixture quantile solver) into a shared module that does not depend on graph-level services or session logging.
- Keep graph-level orchestration (topo pass, join semantics, path_t95 handling, logging) in the statistical enhancement service.

This is referenced in `docs/current/project-lag/context-fix.md` and should be considered when implementing histogram-assisted fitting so we do not duplicate distribution logic in multiple places.


