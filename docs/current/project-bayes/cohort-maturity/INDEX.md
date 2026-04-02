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

### What was implemented today

**Option 1 cohort-mode `x` estimation** in `cohort_forecast.py`:

- `compute_reach_probability()`: walks the DAG backward from the
  subject edge's from-node, multiplying edge rates (`p.mean`) to
  get the fraction of anchor population arriving at the node.
- `x_model(s, τ) = a_s × reach × CDF_path(τ)`: model-derived
  arrivals per Cohort date, using weighted-average path CDF across
  incoming edges. Floored at `x_frozen`.
- Per-Cohort rule: observed `x` where `τ ≤ tau_max`, model forecast
  (floored) where `τ > tau_max`.
- Cohort-mode `y` uses Beta posterior draw (`rng.beta`) for rate
  dispersion. Window mode uses posterior mean (unchanged).
- Window mode uses `q = p × CDF` for `c_i` and `remaining_cdf`
  (preserving original `p` dispersion mechanism). Cohort mode uses
  pure `cdf_arr`.
- Zero-maturity diagnostic (`[DIAG_0d]`) active for Cohorts with
  `tau_max ≤ 5`, both modes.

### What was NOT changed

- Window mode MC path: structurally identical to pre-session code.
  Fan dispersion confirmed visually correct.
- Deterministic midpoint: updated for Option 1 `x_model` and
  carry-forward in cohort-mode sparse data, but no Beta draw.
- FE: no changes. No new data plumbing.

---

## Open issues (consolidated)

All open calibration and implementation issues are tracked in two
locations. This section indexes them to avoid confusion.

### From `cohort-maturity-full-bayes-design.md`

- **§7.5 — y projection base**: the frontier-conditioned formula
  gives depressed rates for low-maturity Cohorts because `y` is
  anchored at `x_at_frontier` while `x` grows to full model
  population. A per-tau projection was tested and visually better
  but mathematically incorrect (double time-scaling). Correct
  convolution formula needed.

- **§11 — Known implementation defects**: shared-ancestor bug in
  DAG reach traversal, reach not anchored to query anchor node,
  inconsistent probability sources, silent latency fallback,
  per-node cap distortion. These are implementation bugs in the
  current `cohort_forecast.py` Option 1 code.

### From `cohort-x-per-date-estimation.md`

- **§8.1 — Zero-maturity degeneration invariant**: both `window()`
  and `cohort()` must degenerate to `p × CDF_edge(τ)` as maturity
  → 0. Not yet confirmed. Diagnostic dump (`[DIAG_0d]`) is in
  place to decompose the divergence. Next step: run `window(-0d:)`
  and `cohort(-0d:)` queries and analyse the diagnostic output to
  identify which terms block degeneration.
  **This is the highest priority open issue.**

- **§8.2 — Stochastic denominator**: cohort-mode `x` is
  deterministic across MC draws. Proposal 2A (sample upstream path
  terms per draw) and 2B (consistency fix: `compute_reach_probability`
  uses `edge.p.mean` while CDF weights use `read_edge_cohort_params`
  path posterior — pick one source).

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
