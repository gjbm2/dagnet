# 19 — Dispersion Parameter Recovery: Investigation Plan

**Date**: 30-Mar-26
**Status**: Active
**Goal**: Achieve robust κ recovery on synth data before touching production

## The Problem

At 10× traffic (n ≈ 150–200/day, 100 days), our BetaBinomial MLE still
produces wildly inconsistent κ estimates (19–350 across edges, truth = 50).
If this were purely an information problem, 10× n ≈ 100× Fisher information
— more than enough to pin κ within a few percent. Something else is wrong.

## Hypotheses

| # | Hypothesis | Implication |
|---|-----------|-------------|
| H1 | MLE implementation bug (CDF adjustment, recency weighting, best-per-day logic, or numerical issues) | Fix the estimator |
| H2 | Data binding defect — the MLE receives wrong/inconsistent (n, k) vectors | Fix the evidence binder |
| H3 | Dual-kappa model misspecification — single BetaBinomial cannot represent composite of entry-day + step-day variation | Need a different estimator or decomposition |
| H4 | Synth gen is not producing the variation it claims (draw logic bug) | Fix synth gen |

## Investigation Steps

### Phase A: Validate the synth gen output (H4)

Before investigating anything else, confirm the synthetic data is what we
think it is. If the data is wrong, everything downstream is noise.

1. **Run synth gen for mirror-4step at 10× traffic** (mean_daily_traffic = 16000)
   with dual kappa (entry = 50, step = 30), seed = 42.

2. **Extract the raw per-day p draws** from the generator:
   - For each (entry_day, edge), what p_entry was drawn?
   - For each (calendar_day, edge), what p_step was drawn?
   - What was the effective p_eff = p_entry × (p_step / p_truth)?
   - Compute empirical variance of p_eff across days per edge.
   - Does the empirical variance match what Beta(μκ, (1−μ)κ) predicts?

3. **For the first edge (no path, no latency)**:
   - Entry-day and step-day kappa should compose to a single effective κ.
   - Compute the empirical overdispersion directly from the generated (n, k).
   - Compare to truth.

**Pass criterion**: the raw data variance matches theoretical prediction.
If it doesn't, the synth gen has a bug and nothing else matters.

### Phase B: Validate what the MLE actually sees (H2)

Assuming Phase A passes, check the data pipeline from synth output to MLE input.

4. **Dump the exact (n, k, weight, F) vectors** that `_estimate_cohort_kappa`
   receives for each edge. Write these to a temporary diagnostic file or
   print them.

5. **Compare to the raw synth data**:
   - Same number of days?
   - Same n values?
   - Same k values?
   - Any filtering, aggregation, or transformation happening between
     synth output and MLE input?

6. **Check the maturity filter**: we filter on F ≥ 0.9 (DISPERSION_F_THRESHOLD).
   - How many days survive the filter per edge?
   - For downstream edges with latency, does F calculation use the right
     CDF (posterior vs topology defaults)?
   - Is `max_retrieval_age` correct?

7. **Check recency weighting**: are weights reasonable? Is the halflife
   inadvertently discarding most of the data?

8. **Check best-per-day selection**: the `_consider()` / `best_by_day` logic
   picks the most mature observation per anchor day. Is it picking sensibly?

**Pass criterion**: the (n, k) vectors the MLE sees match the raw synth data
(after expected filtering). If they don't, the evidence binder has a bug.

### Phase C: Validate the MLE itself (H1)

Assuming Phases A and B pass, test the estimator in isolation.

9. **Bypass the pipeline entirely.** Generate synthetic BetaBinomial data
   directly in Python:
   ```
   for d in range(100):
       p_d = Beta(μ × κ, (1−μ) × κ)
       k_d = Binomial(n_d, p_d)
   ```
   Feed this to the MLE. Does it recover κ?

   Test matrix:
   - κ = 20, 50, 100, 200
   - n = 20, 200, 2000
   - K = 50, 100, 200 days
   - μ = 0.1, 0.3, 0.7 (covering our funnel range)

10. **If pure BetaBinomial recovery works**, add the CDF adjustment (F < 1)
    and retest. Does the CDF-adjusted likelihood break things?

11. **If CDF adjustment breaks things**, test with F = 1.0 only (fully
    mature cohorts) to isolate whether the issue is the CDF math.

12. **If pure BetaBinomial recovery FAILS**, the MLE has a fundamental
    bug. Inspect:
    - Gradient numerics (log ρ parameterisation)
    - scipy.optimize convergence (method, bounds, starting values)
    - The exact CDF quadrature (scipy.integrate.quad)

**Pass criterion**: the MLE recovers κ within ±20% on pure synthetic
BetaBinomial data at n = 200, K = 100. If it can't do that, nothing
downstream will work.

### Phase D: Characterise the dual-kappa composite (H3)

Only relevant if A, B, C all pass — the estimator works on clean data
but fails on dual-kappa synth data.

13. **Single-kappa synth gen**: temporarily set kappa_step = ∞ (no step-day
    variation) and run the MLE. Does it recover entry-day κ = 50?

14. **Step-only synth gen**: set kappa_entry = ∞, step = 30. Does the
    window MLE recover κ = 30?

15. **Both active**: entry = 50, step = 30. What does each estimator
    (cohort and window) actually converge to? Is there a consistent
    composite that makes theoretical sense?

16. **If the composite is inconsistent**, we need the crossed random
    effects decomposition — but only after confirming the single-source
    case works.

**Pass criterion**: single-source κ recovery works for both cohort and
window. Dual-source produces a theoretically predictable composite.

## Sequencing

```
A (synth gen) ──► B (data binding) ──► C (MLE in isolation) ──► D (dual kappa)
     │                  │                      │
     ▼                  ▼                      ▼
  Bug found?        Bug found?            Bug found?
  Fix & restart     Fix & restart B       Fix & restart C
```

Each phase either finds a bug (fix it, restart from that phase) or passes
(proceed to next). Do not skip ahead — a downstream investigation is
meaningless if the upstream data is wrong.

## Success Criteria

- Single-kappa synth: MLE recovers κ within ±20% across all edges
- Dual-kappa synth: cohort and window MLEs produce theoretically
  predictable composites
- Results are stable across seeds (run 3+ seeds)
- Results hold at both normal (1600) and high (16000) traffic
