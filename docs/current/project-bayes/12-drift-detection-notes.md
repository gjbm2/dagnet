# Doc 12 — Drift Detection: Design Notes and Attempted Approaches

**Status**: Parked — backing out to fix upstream edge fit quality first
**Date**: 19-Mar-26

---

## 1. Goal

Detect and accommodate temporal drift in both probability and latency
within a single training window. The model should project from the
**current regime**, not a historical average.

## 2. Design (from doc 6 §Phase D and session reasoning)

### Symmetric drift in p and latency

The probability dimension already has a hierarchy: `p_base → p_window
(tight) → p_cohort (path-informed divergence via σ_temporal)`. The
latency dimension now mirrors this (`mu_base → mu_cohort`). Drift
adds **within-run temporal variation** on top:

- `σ_p_drift`: how much p moves between time bins
- `σ_mu_drift`: how much latency mu moves between time bins
- Both governed by their own drift parameters
- Both calibratable from `fit_history` via DerSimonian-Laird

### Separate bin schemes for p and mu

p drift can be estimated from ALL trajectories (mature ones give
k/n ≈ p directly). Latency drift can only be estimated from
**immature** trajectories where the CDF shape is visible. So:

- **p bins**: adaptive, sized by cumulative n threshold. Every anchor
  day contributes. More data → smaller bins → finer resolution.
- **mu bins**: adaptive, sized by immature trajectory count (anchor
  days with min age < 30d and 5+ retrieval ages). Fewer, wider bins
  concentrated in the recent period.

### Adaptive binning criteria

- Walk through anchor days chronologically
- Accumulate into a bin until threshold met, then start new bin
- Minimum bin width: 14 days (prevents single-day degenerate bins)
- p threshold: ~30,000 total n per bin
- mu threshold: ~30 immature trajectories per bin
- Degenerate cases: <2 bins → drift disabled for that dimension

### Output

- Current-regime estimate (most recent bin's posterior) for both p and mu
- σ_p_drift and σ_mu_drift as diagnostics
- Per-bin trajectory NOT output (no forecasting value without trend model)

## 3. Approaches tried

### Random walk (non-centred)

```
logit_p_base_0 = logit(p_base)
eps_t ~ Normal(0, 1)
logit_p_t = logit_p_{t-1} + eps_t * σ_drift * sqrt(gap)
```

**Result**: NUTS could not sample efficiently. Even with 4 bins (30-day),
the model timed out at 600s. The funnel geometry between `eps_t` and
`σ_drift` is pathological — when σ_drift → 0 (stable parameter, the
common case), all eps values must → 0 simultaneously, creating a
high-dimensional funnel that NUTS navigates with tiny step sizes.

The problem scales with the number of bins AND the number of edges
(each edge contributes its own funnel). With 4 edges × 4 bins, that's
16 simultaneous funnels — intractable.

### Not yet tried: partial pooling (hierarchical)

```
logit_p_mean ~ Normal(prior)
tau_p ~ HalfNormal(0.3)
logit_p_t ~ Normal(logit_p_mean, tau_p)  for each populated bin t
```

Independent per-bin values pulled toward a shared mean. No chain
between bins, no funnel. Standard partial pooling — well-studied,
NUTS-friendly. Loses time-ordering information but for current-regime
estimation we only need the most recent bin.

**This is the recommended next approach when drift work resumes.**

## 4. Key data insights

### Snapshot data span vs anchor day span

The test graph has 120 days of anchor days (Nov 2025 – Mar 2026) but
only 39-54 days of daily fetch activity (late Jan – mid Mar). Early
anchor days have only 1-2 retrieval ages at very mature ages (60-100d)
— they constrain p (final rate) but not latency shape. Recent anchor
days have 5-14 retrieval ages spanning the CDF rise — they constrain
both p and latency.

### Bin sizing must be data-driven

Fixed calendar bins (7d or 30d) create bins with wildly different
data density. Adaptive binning by cumulative evidence threshold gives
well-constrained bins regardless of fetch history length.

### Immaturity criterion for mu bins

A trajectory is informative for latency shape only if its minimum
retrieval age is below the edge's t95 (~15-17d for this graph) AND
it has enough retrieval ages (5+) to trace the CDF rise. Most
trajectories from before the daily fetch period are fully mature
and contribute nothing to latency drift detection.

## 5. Code written (to be backed out)

Files modified for drift:
- `bayes/compiler/types.py`: `bin_idx`, `mu_bin_idx` on CohortDailyTrajectory/Obs,
  `n_drift_bins`, `n_mu_drift_bins` on BoundEvidence
- `bayes/compiler/evidence.py`: `_assign_trajectory_bins()`,
  `_adaptive_bin_boundaries()`, `_parse_trajectory_date()`
- `bayes/compiler/model.py`: `_build_drift_walk()`, drift variable creation
  in `build_model()`, per-bin mu/p dispatch in `_emit_cohort_likelihoods()`
- `bayes/compiler/inference.py`: drift diagnostic extraction
- `bayes/test_wiring.py`: drift-aware checks

## 6. Prerequisites before resuming

- Fix upstream edge fit quality (low-quality fits on edges closer to
  anchor — the reason drift work was parked)
- Consider whether partial-pooling approach resolves the funnel issue
- May need to reduce the number of drift variables further (e.g.,
  drift only on edges with evidence of instability from fit_history)
