# Cohort Maturity Documentation Index

**Last updated**: 2-Apr-26

This directory contains all design docs, specs, and investigation notes
for the cohort maturity fan chart and related forecasting work.

---

## Primary design docs

| Doc | Status | Scope |
|-----|--------|-------|
| [cohort-maturity-project-overview.md](cohort-maturity-project-overview.md) | Active | Project map: phases, epochs, data pipeline, terminology |
| [cohort-maturity-full-bayes-design.md](cohort-maturity-full-bayes-design.md) | Draft | Bayesian update formulas, denominator policy, f/e paths, implementation plan. **Contains open issues §7.5 and §11** |
| [cohort-maturity-fan-chart-spec.md](cohort-maturity-fan-chart-spec.md) | Draft | Chart spec: user-facing behaviour, phasing, window mode computation, fan bounds |
| [cohort-x-per-date-estimation.md](cohort-x-per-date-estimation.md) | Proposal — Option 1 partially implemented | Per-Cohort-date `x` estimation: Options 1/1b/2, comparison, delivery. **Contains open calibration issues §8** |
| [cohort-backend-propagation-engine-design.md](cohort-backend-propagation-engine-design.md) | Proposal | BE propagation engine: shared libraries, state model, join semantics, MC independence |

## Investigation and reference docs

| Doc | Status | Scope |
|-----|--------|-------|
| [fan-chart-mc-bug.md](fan-chart-mc-bug.md) | Open | Root cause: sparse `cohort_at_tau` in cohort mode producing zero-width bands |
| [cohort-forecast-conditioning-attempts-1-Apr-26.md](cohort-forecast-conditioning-attempts-1-Apr-26.md) | Reverted | Audit trail of failed experimental fixes (posterior ESS, conditional blending) |
| [cohort-fan-harness-context.md](cohort-fan-harness-context.md) | Active | Test harness context, epoch boundaries, visual elements |
| [option15.md](option15.md) | Reference | Cursor conversation export: Option 1.5 (subject-conditioned upstream forecast) — analysis of the partition problem at joins |

---

## Current implementation state (2-Apr-26)

### Major changes this session (2-Apr-26)

**Importance-weighted MC fan chart** — complete rewrite of the MC
dispersion mechanism in `cohort_forecast.py`:

- **Importance sampling** replaces all previous rate-draw approaches
  (per-Cohort Beta draw, pooled Beta, raw MVN p, posterior mean).
  For each MC draw θ^(b) from the MVN posterior, computes the
  Binomial likelihood of the observed Cohort data, normalises to
  importance weights, and resamples.  This conditions ALL parameters
  (p, mu, sigma, onset) on the window evidence — not just p.
- **Zero-maturity degeneration** verified: at zero maturity, no
  evidence → uniform weights → fan = confidence band.  Tested in
  `TestWindowZeroMaturityDegeneration::test_fan_equals_confidence_band_at_zero_maturity`.
- **Fan narrows with evidence**: more Cohorts / more data → stronger
  conditioning → narrower fan.  Tested in
  `TestWindowZeroMaturityDegeneration::test_fan_narrows_with_evidence`.
- **Unified window/cohort codepath**: the MC forecast loop is now
  a single path.  The only branch is how x is computed: flat N_i
  (window) vs a_pop × reach × CDF_path(τ) (cohort).
- **`compute_confidence_band`** now returns (upper, lower, median)
  — third element added for like-for-like comparison with fan median.
- **Anchor window filter** added: Cohorts outside [anchor_from,
  anchor_to] are now excluded from the forecast.
- **tau_max fix**: uses last frame's snapshot date, not sweep_to,
  so Cohorts aren't treated as "mature" for days beyond the data.

### Cohort-mode `x` estimation (from prior session)

- `compute_reach_probability()`: walks the DAG backward from the
  subject edge's from-node, multiplying edge rates (`p.mean`) to
  get the fraction of anchor population arriving at the node.
- `x_model(s, τ) = a_s × reach × CDF_path(τ)`: model-derived
  arrivals per Cohort date, using weighted-average path CDF across
  incoming edges. Floored at `x_frozen`.
- Per-Cohort rule: observed `x` where `τ ≤ tau_max`, model forecast
  (floored) where `τ > tau_max`.

### What was NOT changed

- Deterministic midpoint: still uses per-Cohort posterior mean with
  `alpha_0/beta_0`.  Not yet updated to use importance-weighted
  draws (the midpoint is deterministic, not stochastic, so
  importance weighting doesn't directly apply — it would need a
  different approach).
- FE: no changes. No new data plumbing.

---

## Open issues (consolidated)

All open calibration and implementation issues are tracked in two
locations. This section indexes them to avoid confusion.

### From this session

- **`path_alpha/path_beta` dead code**: deleted. The `path_` prefix
  in this app refers to the cohort-level posterior on the same edge
  (not upstream DAG path). Already handled correctly by the
  `posterior_path_alpha/beta` source selection at lines 461-466.

- **Production data testing blocked**: Bayes fit requires
  `BAYES_WEBHOOK_SECRET` in `.env.local` (now added) but the local
  Bayes roundtrip has a model fit issue. Test fixture works correctly.

### From `cohort-maturity-full-bayes-design.md`

- **§7.5 — y projection base**: the frontier-conditioned formula
  gives depressed rates for low-maturity Cohorts because `y` is
  anchored at `x_at_frontier` while `x` grows to full model
  population. Correct convolution formula needed.

- **§11 — Known implementation defects**: shared-ancestor bug in
  DAG reach traversal, reach not anchored to query anchor node,
  inconsistent probability sources, silent latency fallback,
  per-node cap distortion.

### From `cohort-x-per-date-estimation.md`

- **§8.1 — Zero-maturity degeneration invariant**: RESOLVED for
  window mode.  Both tests pass.  Cohort mode not yet verified.

- **§8.2 — Stochastic denominator**: cohort-mode `x` is still
  deterministic across MC draws (uses point-estimate upstream CDF).
  The importance weighting conditions (mu, sigma, onset) on evidence
  which partially addresses this, but upstream CDF is not yet
  per-draw.

### Key design decision: window vs cohort CDF basis

Window mode uses `q = p × CDF` for `c_i` and `remaining_cdf`.
This is how `p^(b)` draw variation enters the fan — through the
CDF terms, not through the posterior rate formula.

Cohort mode uses pure `cdf_arr` (no `p`). This was an intentional
split: the cohort-mode rate dispersion comes from the Beta posterior
draw (`rng.beta`), not from `q`. The two modes have different
dispersion mechanisms.

This split is a pragmatic choice, not a principled one. It should
be revisited once §8.1 is resolved.

### Recommended sequence

1. **§8.1**: investigate zero-maturity degeneration using
   diagnostic output. Start with `window()` (simpler case).
   Write fixture test once the invariant is understood.
2. Fix §11 implementation defects (shared-ancestor bug etc.)
3. Fix §8.2 Proposal 2B (probability basis consistency)
4. Evaluate fan quality on real data
5. Implement §8.2 Proposal 2A (stochastic denominator) if needed
6. Address §7.5 (y projection base convolution) if fans still
   show incorrect limiting behaviour
